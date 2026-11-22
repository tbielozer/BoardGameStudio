import { Skia } from '@shopify/react-native-skia';
import type { SkImage } from '@shopify/react-native-skia';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Point, Stroke } from './types';
import { pointsToPath } from './drawingCanvasGeometry';
import type { LoadedSurfaceArtwork, PlacedImage } from './drawingCanvasTypes';

type DecodedSkiaImage = NonNullable<ReturnType<typeof Skia.Image.MakeImageFromEncoded>>;

export type DecodedTileArtwork = {
  backgroundImage: DecodedSkiaImage | null;
  images: Array<PlacedImage & { decoded: DecodedSkiaImage | null }>;
};

// Reuse derived paths and decoded image bytes across identical tile faces.
export const tileArtworkPathCache = new WeakMap<Stroke[], ReturnType<typeof pointsToPath>[]>();
export const tileArtworkImageCache = new WeakMap<PlacedImage[], DecodedTileArtwork>();

const pendingSurfaceArtworkLoads = new Map<string, Promise<LoadedSurfaceArtwork>>();
const completedSurfaceArtworkLoads = new Map<string, { artwork: LoadedSurfaceArtwork; weight: number }>();
const completedSurfaceRasters = new Map<string, { image: SkImage; weight: number }>();
const pendingSurfaceRasterLoads = new Map<string, Promise<SkImage | null>>();
export const pendingSurfaceRasterCaptures = new Set<string>();
const surfaceRasterListeners = new Map<string, Set<(image: SkImage) => void>>();
export const surfaceArtworkGenerations = new Map<string, number>();

const MAX_CACHED_SURFACE_ARTWORK = 32;
const MAX_CACHED_SURFACE_ARTWORK_CHARS = 12 * 1024 * 1024;
const MAX_CACHED_SURFACE_RASTERS = 48;
const MAX_CACHED_SURFACE_RASTER_BYTES = 24 * 1024 * 1024;
let cachedSurfaceArtworkChars = 0;
let cachedSurfaceRasterBytes = 0;

export function getCachedSurfaceRaster(key: string) {
  const cached = completedSurfaceRasters.get(key);
  if (!cached) return null;
  completedSurfaceRasters.delete(key);
  completedSurfaceRasters.set(key, cached);
  return cached.image;
}

export function subscribeToSurfaceRaster(key: string, listener: (image: SkImage) => void) {
  const listeners = surfaceRasterListeners.get(key) ?? new Set<(image: SkImage) => void>();
  listeners.add(listener);
  surfaceRasterListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) surfaceRasterListeners.delete(key);
  };
}

export function cacheSurfaceRaster(key: string, image: SkImage) {
  const previous = completedSurfaceRasters.get(key);
  if (previous) cachedSurfaceRasterBytes -= previous.weight;
  const weight = image.width() * image.height() * 4;
  completedSurfaceRasters.delete(key);
  if (weight <= MAX_CACHED_SURFACE_RASTER_BYTES) {
    completedSurfaceRasters.set(key, { image, weight });
    cachedSurfaceRasterBytes += weight;
  }
  surfaceRasterListeners.get(key)?.forEach((listener) => listener(image));
  while (completedSurfaceRasters.size > MAX_CACHED_SURFACE_RASTERS
    || cachedSurfaceRasterBytes > MAX_CACHED_SURFACE_RASTER_BYTES) {
    const oldestKey = completedSurfaceRasters.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = completedSurfaceRasters.get(oldestKey);
    if (oldest) cachedSurfaceRasterBytes -= oldest.weight;
    completedSurfaceRasters.delete(oldestKey);
  }
}

export function loadCachedSurfaceRaster(
  db: SQLiteDatabase,
  key: string,
  surfaceId: string,
  variant: string
): Promise<SkImage | null> {
  const cached = getCachedSurfaceRaster(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingSurfaceRasterLoads.get(key);
  if (pending) return pending;

  const load = db.getFirstAsync<{ png_data: Uint8Array }>(
    'SELECT png_data FROM surface_artwork_rasters WHERE surface_id = ? AND variant = ?',
    surfaceId,
    variant
  ).then((row) => {
    if (!row?.png_data) return null;
    try {
      const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(row.png_data));
      if (image) cacheSurfaceRaster(key, image);
      return image;
    } catch (error) {
      console.warn('Could not decode cached surface artwork:', surfaceId, error);
      return null;
    }
  }).catch((error) => {
    console.warn('Could not load cached surface artwork:', surfaceId, error);
    return null;
  });

  pendingSurfaceRasterLoads.set(key, load);
  void load.finally(() => {
    if (pendingSurfaceRasterLoads.get(key) === load) pendingSurfaceRasterLoads.delete(key);
  }).catch(() => {});
  return load;
}

export function invalidateSurfaceArtworkCache(surfaceId: string) {
  surfaceArtworkGenerations.set(surfaceId, (surfaceArtworkGenerations.get(surfaceId) ?? 0) + 1);
  const cached = completedSurfaceArtworkLoads.get(surfaceId);
  if (cached) {
    cachedSurfaceArtworkChars -= cached.weight;
    completedSurfaceArtworkLoads.delete(surfaceId);
  }
  for (const [key, cachedRaster] of completedSurfaceRasters) {
    if (!key.startsWith(`${surfaceId}|`)) continue;
    cachedSurfaceRasterBytes -= cachedRaster.weight;
    completedSurfaceRasters.delete(key);
  }
}

export function loadSurfaceArtwork(db: SQLiteDatabase, surfaceId: string): Promise<LoadedSurfaceArtwork> {
  const cachedArtwork = completedSurfaceArtworkLoads.get(surfaceId);
  if (cachedArtwork) {
    // Refresh insertion order to implement a small least-recently-used cache.
    completedSurfaceArtworkLoads.delete(surfaceId);
    completedSurfaceArtworkLoads.set(surfaceId, cachedArtwork);
    return Promise.resolve(cachedArtwork.artwork);
  }
  const pendingLoad = pendingSurfaceArtworkLoads.get(surfaceId);
  if (pendingLoad) return pendingLoad;

  const generationAtStart = surfaceArtworkGenerations.get(surfaceId) ?? 0;
  const load = Promise.all([
    db.getFirstAsync<{
      background_color: string | null;
      background_image_data: string | null;
      background_image_mime_type: string | null;
    }>(
      'SELECT background_color, background_image_data, background_image_mime_type FROM drawing_surfaces WHERE id = ?',
      surfaceId
    ).catch((error) => {
      console.error('Could not load drawing-surface background:', surfaceId, error);
      return null;
    }),
    db.getAllAsync<{
      points_json: string; width: number; color: string; is_eraser: number; group_id: string | null;
    }>(
      'SELECT points_json, width, color, is_eraser, group_id FROM strokes WHERE surface_id = ? ORDER BY order_index',
      surfaceId
    ).catch((error) => {
      console.error('Could not load drawing strokes:', surfaceId, error);
      return [];
    }),
    db.getAllAsync<{
      id: number; base64_data: string; mime_type: string;
      center_x: number; center_y: number; width: number; height: number;
    }>(
      'SELECT id, base64_data, mime_type, center_x, center_y, width, height FROM surface_images WHERE surface_id = ? ORDER BY order_index',
      surfaceId
    ).catch((error) => {
      console.error('Could not load drawing images:', surfaceId, error);
      return [];
    }),
  ]).then(([surface, strokeRows, imageRows]): LoadedSurfaceArtwork => ({
    backgroundColor: surface?.background_color ?? null,
    backgroundImage: surface?.background_image_data && surface.background_image_mime_type
      ? { base64Data: surface.background_image_data, mimeType: surface.background_image_mime_type }
      : null,
    strokes: strokeRows.flatMap((stroke) => {
      try {
        return [{
          points: JSON.parse(stroke.points_json) as Point[],
          width: stroke.width,
          color: stroke.color,
          eraser: stroke.is_eraser === 1,
          groupId: stroke.group_id ?? undefined,
        }];
      } catch (error) {
        console.error('Could not decode a saved drawing stroke:', surfaceId, error);
        return [];
      }
    }),
    images: imageRows.map((image) => ({
      id: image.id,
      base64Data: image.base64_data,
      mimeType: image.mime_type,
      center: { x: image.center_x, y: image.center_y },
      width: image.width,
      height: image.height,
    })),
  })).then((artwork) => {
    // Ignore a stale in-flight read if the editor changed this surface mid-load.
    if ((surfaceArtworkGenerations.get(surfaceId) ?? 0) === generationAtStart) {
      const weight = (artwork.backgroundImage?.base64Data.length ?? 0)
        + artwork.images.reduce((total, image) => total + image.base64Data.length, 0)
        + artwork.strokes.reduce((total, stroke) => total + stroke.points.length * 32 + 96, 0);
      if (weight <= MAX_CACHED_SURFACE_ARTWORK_CHARS) {
        completedSurfaceArtworkLoads.set(surfaceId, { artwork, weight });
        cachedSurfaceArtworkChars += weight;
      }
      while (completedSurfaceArtworkLoads.size > MAX_CACHED_SURFACE_ARTWORK
        || cachedSurfaceArtworkChars > MAX_CACHED_SURFACE_ARTWORK_CHARS) {
        const oldestSurfaceId = completedSurfaceArtworkLoads.keys().next().value;
        if (oldestSurfaceId === undefined) break;
        const oldest = completedSurfaceArtworkLoads.get(oldestSurfaceId);
        if (oldest) cachedSurfaceArtworkChars -= oldest.weight;
        completedSurfaceArtworkLoads.delete(oldestSurfaceId);
      }
    }
    return artwork;
  });

  pendingSurfaceArtworkLoads.set(surfaceId, load);
  void load.finally(() => {
    if (pendingSurfaceArtworkLoads.get(surfaceId) === load) pendingSurfaceArtworkLoads.delete(surfaceId);
  }).catch(() => {
    // The caller reports the read error; handle the cleanup promise here.
  });
  return load;
}
