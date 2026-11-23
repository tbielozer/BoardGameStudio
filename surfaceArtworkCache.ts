import {
  BlendMode,
  ClipOp,
  ImageFormat,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
} from '@shopify/react-native-skia';
import type { SkImage, SkRect } from '@shopify/react-native-skia';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Point } from './types';
import { makeTileShapePath, pointsToPath } from './drawingCanvasGeometry';
import type { BoardTileVisual, LoadedSurfaceArtwork } from './drawingCanvasTypes';

const pendingSurfaceArtworkLoads = new Map<string, Promise<LoadedSurfaceArtwork>>();
const completedSurfaceArtworkLoads = new Map<string, { artwork: LoadedSurfaceArtwork; weight: number }>();
const completedSurfaceRasters = new Map<string, { image: SkImage; weight: number }>();
const pendingSurfaceRasterLoads = new Map<string, Promise<SkImage | null>>();
const surfaceArtworkGenerations = new Map<string, number>();
const surfaceArtworkListeners = new Map<string, Set<() => void>>();

const MAX_CACHED_SURFACE_ARTWORK = 32;
const MAX_CACHED_SURFACE_ARTWORK_CHARS = 12 * 1024 * 1024;
const MAX_CACHED_SURFACE_RASTERS = 48;
const MAX_CACHED_SURFACE_RASTER_BYTES = 24 * 1024 * 1024;
let cachedSurfaceArtworkChars = 0;
let cachedSurfaceRasterBytes = 0;

// Flattened faces are drawn at a fixed resolution so one cached image serves
// every on-screen size (board, pile marker, hand) without depending on layout.
const RASTER_PIXELS_PER_INCH = 160;
const RASTER_MAX_SIDE = 1024;

// Saved rasters whose variant does not start with this prefix were made by an
// older renderer and are deleted at startup (see initializeDatabase). Bump it
// whenever the rasterizer's output changes.
export const SURFACE_RASTER_FORMAT = 'v2';

export type SurfaceRasterSpec = {
  surfaceId: string;
  shape: BoardTileVisual['shape'];
  widthInches: number;
  heightInches: number;
  /** Used when the surface has no saved background color. */
  fallbackColor: string;
  drawErasers: boolean;
};

export function getSurfaceRasterVariant(spec: SurfaceRasterSpec) {
  return `${SURFACE_RASTER_FORMAT}|${spec.shape}|${spec.widthInches}|${spec.heightInches}|${spec.fallbackColor}|erasers:${Number(spec.drawErasers)}`;
}

export function getSurfaceRasterKey(spec: SurfaceRasterSpec) {
  return `${spec.surfaceId}|${getSurfaceRasterVariant(spec)}`;
}

export function getCachedSurfaceRaster(key: string) {
  const cached = completedSurfaceRasters.get(key);
  if (!cached) return null;
  completedSurfaceRasters.delete(key);
  completedSurfaceRasters.set(key, cached);
  return cached.image;
}

function cacheSurfaceRaster(key: string, image: SkImage) {
  const previous = completedSurfaceRasters.get(key);
  if (previous) cachedSurfaceRasterBytes -= previous.weight;
  const weight = image.width() * image.height() * 4;
  completedSurfaceRasters.delete(key);
  if (weight <= MAX_CACHED_SURFACE_RASTER_BYTES) {
    completedSurfaceRasters.set(key, { image, weight });
    cachedSurfaceRasterBytes += weight;
  }
  while (completedSurfaceRasters.size > MAX_CACHED_SURFACE_RASTERS
    || cachedSurfaceRasterBytes > MAX_CACHED_SURFACE_RASTER_BYTES) {
    const oldestKey = completedSurfaceRasters.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = completedSurfaceRasters.get(oldestKey);
    if (oldest) cachedSurfaceRasterBytes -= oldest.weight;
    completedSurfaceRasters.delete(oldestKey);
  }
}

function decodeBase64Image(base64Data: string) {
  try {
    return Skia.Image.MakeImageFromEncoded(Skia.Data.fromBase64(base64Data));
  } catch (error) {
    console.warn('Could not decode artwork image:', error);
    return null;
  }
}

// Source rectangle that crops an image to fill the destination (like "cover").
function coverSourceRect(image: SkImage, destWidth: number, destHeight: number): SkRect {
  const imageWidth = image.width();
  const imageHeight = image.height();
  const scale = Math.max(destWidth / imageWidth, destHeight / imageHeight);
  const width = destWidth / scale;
  const height = destHeight / scale;
  return { x: (imageWidth - width) / 2, y: (imageHeight - height) / 2, width, height };
}

// Destination rectangle that fits a whole image inside a box (like "contain").
function containDestRect(image: SkImage, box: SkRect): SkRect {
  const scale = Math.min(box.width / image.width(), box.height / image.height());
  const width = image.width() * scale;
  const height = image.height() * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/**
 * Draws a saved face (background, strokes, image layers) into a CPU image.
 * This replaces snapshotting the on-screen canvas, which on iOS/Android could
 * capture a frame before the artwork was drawn and then cache that blank
 * image permanently.
 */
export function rasterizeSurfaceArtwork(
  artwork: LoadedSurfaceArtwork,
  spec: SurfaceRasterSpec
): SkImage | null {
  if (!(spec.widthInches > 0) || !(spec.heightInches > 0)) return null;
  const scale = Math.min(
    RASTER_PIXELS_PER_INCH,
    RASTER_MAX_SIDE / Math.max(spec.widthInches, spec.heightInches)
  );
  const pixelWidth = Math.max(1, Math.round(spec.widthInches * scale));
  const pixelHeight = Math.max(1, Math.round(spec.heightInches * scale));
  const surface = Skia.Surface.Make(pixelWidth, pixelHeight);
  if (!surface) return null;

  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('transparent'));
  canvas.save();
  canvas.clipPath(makeTileShapePath(spec.shape, pixelWidth, pixelHeight), ClipOp.Intersect, true);

  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  fill.setColor(Skia.Color(artwork.backgroundColor ?? spec.fallbackColor));
  canvas.drawRect({ x: 0, y: 0, width: pixelWidth, height: pixelHeight }, fill);

  const imagePaint = Skia.Paint();
  imagePaint.setAntiAlias(true);
  const backgroundImage = artwork.backgroundImage
    ? decodeBase64Image(artwork.backgroundImage.base64Data)
    : null;
  if (backgroundImage) {
    canvas.drawImageRect(
      backgroundImage,
      coverSourceRect(backgroundImage, pixelWidth, pixelHeight),
      { x: 0, y: 0, width: pixelWidth, height: pixelHeight },
      imagePaint
    );
  }

  // Strokes are stored in inches. Erasers clear to transparent, matching the
  // editor, which shows the board through erased parts of a piece.
  canvas.save();
  canvas.scale(scale, scale);
  const strokePaint = Skia.Paint();
  strokePaint.setAntiAlias(true);
  strokePaint.setStyle(PaintStyle.Stroke);
  strokePaint.setStrokeCap(StrokeCap.Round);
  strokePaint.setStrokeJoin(StrokeJoin.Round);
  for (const stroke of artwork.strokes) {
    if (stroke.eraser && !spec.drawErasers) continue;
    strokePaint.setColor(Skia.Color(stroke.color));
    strokePaint.setStrokeWidth(stroke.width);
    strokePaint.setBlendMode(stroke.eraser ? BlendMode.Clear : BlendMode.SrcOver);
    canvas.drawPath(pointsToPath(stroke.points), strokePaint);
  }
  canvas.restore();

  for (const placed of artwork.images) {
    const decoded = decodeBase64Image(placed.base64Data);
    if (!decoded) continue;
    const box = {
      x: (placed.center.x - placed.width / 2) * scale,
      y: (placed.center.y - placed.height / 2) * scale,
      width: placed.width * scale,
      height: placed.height * scale,
    };
    canvas.drawImageRect(
      decoded,
      { x: 0, y: 0, width: decoded.width(), height: decoded.height() },
      containDestRect(decoded, box),
      imagePaint
    );
  }

  canvas.restore();
  surface.flush();
  const snapshot = surface.makeImageSnapshot();
  return snapshot.makeNonTextureImage() ?? snapshot;
}

/**
 * Returns the flattened face for a surface: from memory, else from the saved
 * PNG in SQLite, else rendered from the saved artwork (and then saved).
 */
export function loadSurfaceRaster(db: SQLiteDatabase, spec: SurfaceRasterSpec): Promise<SkImage | null> {
  const key = getSurfaceRasterKey(spec);
  const cached = getCachedSurfaceRaster(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingSurfaceRasterLoads.get(key);
  if (pending) return pending;

  const { surfaceId } = spec;
  const variant = getSurfaceRasterVariant(spec);
  const generationAtStart = surfaceArtworkGenerations.get(surfaceId) ?? 0;
  const isCurrent = () => (surfaceArtworkGenerations.get(surfaceId) ?? 0) === generationAtStart;

  const load = (async () => {
    try {
      const row = await db.getFirstAsync<{ png_data: Uint8Array }>(
        'SELECT png_data FROM surface_artwork_rasters WHERE surface_id = ? AND variant = ?',
        surfaceId,
        variant
      );
      if (row?.png_data && isCurrent()) {
        const saved = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(row.png_data));
        if (saved) {
          cacheSurfaceRaster(key, saved);
          return saved;
        }
      }
    } catch (error) {
      console.warn('Could not load cached surface artwork:', surfaceId, error);
    }

    const artwork = await loadSurfaceArtwork(db, surfaceId);
    const image = rasterizeSurfaceArtwork(artwork, spec);
    if (!image || !isCurrent()) return image;
    cacheSurfaceRaster(key, image);
    try {
      await db.runAsync(
        `INSERT INTO surface_artwork_rasters
          (surface_id, variant, png_data, pixel_width, pixel_height, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(surface_id, variant) DO UPDATE SET
           png_data = excluded.png_data,
           pixel_width = excluded.pixel_width,
           pixel_height = excluded.pixel_height,
           updated_at = excluded.updated_at`,
        surfaceId,
        variant,
        image.encodeToBytes(ImageFormat.PNG),
        image.width(),
        image.height(),
        Date.now()
      );
    } catch (error) {
      console.warn('Could not save cached surface artwork:', surfaceId, error);
    }
    return image;
  })().catch((error) => {
    console.error('Could not render surface artwork:', surfaceId, error);
    return null;
  });

  pendingSurfaceRasterLoads.set(key, load);
  void load.finally(() => {
    if (pendingSurfaceRasterLoads.get(key) === load) pendingSurfaceRasterLoads.delete(key);
  });
  return load;
}

/** Calls `listener` whenever the saved artwork for `surfaceId` changes. */
export function subscribeToSurfaceArtwork(surfaceId: string, listener: () => void) {
  const listeners = surfaceArtworkListeners.get(surfaceId) ?? new Set<() => void>();
  listeners.add(listener);
  surfaceArtworkListeners.set(surfaceId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) surfaceArtworkListeners.delete(surfaceId);
  };
}

// Call after any write to a surface's strokes, images, or background so that
// previews already on screen (board pieces, piles, hand cards) redraw.
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
  for (const key of pendingSurfaceRasterLoads.keys()) {
    if (key.startsWith(`${surfaceId}|`)) pendingSurfaceRasterLoads.delete(key);
  }
  pendingSurfaceArtworkLoads.delete(surfaceId);
  surfaceArtworkListeners.get(surfaceId)?.forEach((listener) => listener());
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
