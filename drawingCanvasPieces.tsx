import { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas, Path, Skia, Circle, Group, Image as SkiaImage, Mask, Rect, ImageFormat, useCanvasRef } from '@shopify/react-native-skia';
import type { SkImage } from '@shopify/react-native-skia';
import { useSQLiteContext } from 'expo-sqlite';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type { Stroke } from './types';
import type {
  BoardTilePlacement,
  BoardTileVisual,
  DeckSpot,
  PlacedImage,
  TilePlacementPreview,
} from './drawingCanvasTypes';
import { getBoardTileSize, getDeckSpotSize, pointsToPath } from './drawingCanvasGeometry';
import {
  cacheSurfaceRaster,
  getCachedSurfaceRaster,
  loadCachedSurfaceRaster,
  loadSurfaceArtwork,
  pendingSurfaceRasterCaptures,
  subscribeToSurfaceRaster,
  surfaceArtworkGenerations,
  tileArtworkImageCache,
  tileArtworkPathCache,
} from './surfaceArtworkCache';
import type { DecodedTileArtwork } from './surfaceArtworkCache';
import { drawingCanvasStyles } from './drawingCanvasStyles';

// Renders a saved tile face at its physical shape and aspect ratio on the board.
type BoardTilePlacementVisual = (BoardTilePlacement | TilePlacementPreview) & { id?: number };

export const BoardTilePlacementView = memo(function BoardTilePlacementView({
  placement,
  transformScale,
  offsetX,
  offsetY,
  selected,
  ghost,
  dragging,
  animatedDrag,
  snapped,
  gameplayTilePositionStyle,
  gameplayTileRotationStyle,
}: {
  placement: BoardTilePlacementVisual;
  transformScale: number;
  offsetX: number;
  offsetY: number;
  selected: boolean;
  ghost: boolean;
  dragging: boolean;
  animatedDrag: boolean;
  snapped: boolean;
  gameplayTilePositionStyle: ReturnType<typeof useAnimatedStyle>;
  gameplayTileRotationStyle: ReturnType<typeof useAnimatedStyle>;
}) {
  const tileSize = getBoardTileSize(placement.tile);
  const width = placement.tile ? tileSize.width * transformScale : 92 * transformScale;
  const height = placement.tile ? tileSize.height * transformScale : 56 * transformScale;
  const left = placement.x * transformScale + offsetX - width / 2;
  const top = placement.y * transformScale + offsetY - height / 2;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        drawingCanvasStyles.boardTilePlacement,
        selected && drawingCanvasStyles.selectedBoardTilePlacement,
        { left, top, width, height, opacity: ghost && !dragging ? 0.55 : 1 },
        dragging && { zIndex: 50, elevation: 50 },
        animatedDrag
          ? gameplayTilePositionStyle
          // Explicitly clear the previous animated translation when the
          // saved layout position takes over. Native views can retain the
          // last animated transform when that style is simply removed.
          : { transform: [{ translateX: 0 }, { translateY: 0 }] },
      ]}
    >
      <Animated.View style={[{
        width, height, alignItems: 'center', justifyContent: 'center',
      }, animatedDrag
        ? gameplayTileRotationStyle
        : { transform: [{ rotate: `${placement.orientation}deg` }] }]}>
        {placement.deckId !== null && placement.tile
          && (placement.tile.shape === 'square' || placement.tile.shape === 'circle') && (
            <View style={[
              drawingCanvasStyles.tileDeckStackLayer,
              { width, height, borderRadius: placement.tile.shape === 'circle' ? Math.max(width, height) / 2 : 0 },
            ]} />
          )}
        {placement.tile ? (
          <BoardTileArtworkPreview
            tile={placement.tile}
            width={width}
            height={height}
            faceUp={placement.faceUp}
            selected={selected}
          />
        ) : (
          <View style={[drawingCanvasStyles.emptyTileDeck, selected && drawingCanvasStyles.selectedEmptyTileDeck]}>
            <Text numberOfLines={1} style={drawingCanvasStyles.emptyTileDeckName}>{placement.deckName ?? 'Tile deck'}</Text>
            <Text style={drawingCanvasStyles.emptyTileDeckCount}>{placement.tileCount} tiles</Text>
          </View>
        )}
        {placement.deckId !== null && placement.tile && (
          <View style={drawingCanvasStyles.tileDeckCountBadge}>
            <Text style={drawingCanvasStyles.tileDeckCountText}>{placement.tileCount}</Text>
          </View>
        )}
        {ghost && snapped && (
          <View style={drawingCanvasStyles.snappedTileBadge}><Text style={drawingCanvasStyles.snappedTileBadgeText}>Snap</Text></View>
        )}
      </Animated.View>
    </Animated.View>
  );
});

export const BoardTileArtworkPreview = memo(function BoardTileArtworkPreview({
  tile,
  width,
  height,
  faceUp,
  selected = false,
  showOutline = true,
  drawErasers = true,
}: {
  tile: BoardTileVisual;
  width: number;
  height: number;
  faceUp: boolean;
  selected?: boolean;
  showOutline?: boolean;
  drawErasers?: boolean;
}) {
  const db = useSQLiteContext();
  const canvasRef = useCanvasRef();
  const artworkSurfaceId = !faceUp && tile.backSurfaceId
    ? tile.backSurfaceId
    : tile.frontSurfaceId;
  const rasterVariant = `${tile.shape}|${tile.widthInches}|${tile.heightInches}|${tile.color}|erasers:${Number(drawErasers)}`;
  const rasterKey = `${artworkSurfaceId}|${rasterVariant}`;
  const [artwork, setArtwork] = useState<{
    backgroundColor: string;
    backgroundImage: { base64Data: string; mimeType: string } | null;
    strokes: Stroke[];
    images: PlacedImage[];
  } | null>(null);
  const [flattenedArtwork, setFlattenedArtwork] = useState<SkImage | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArtwork(null);
    setFlattenedArtwork(null);
    const loadArtwork = async () => {
      try {
        const loaded = await loadSurfaceArtwork(db, artworkSurfaceId);
        if (!cancelled) setArtwork({ ...loaded, backgroundColor: loaded.backgroundColor ?? tile.color });
      } catch (error) {
        console.error('Could not load tile artwork for the board:', error);
      }
    };
    void loadCachedSurfaceRaster(db, rasterKey, artworkSurfaceId, rasterVariant).then((cachedRaster) => {
      if (cancelled) return;
      if (cachedRaster) setFlattenedArtwork(cachedRaster);
      else void loadArtwork();
    });
    return () => { cancelled = true; };
  }, [artworkSurfaceId, db, rasterKey, rasterVariant, tile.color]);

  useEffect(() => {
    if (flattenedArtwork) return;
    const cached = getCachedSurfaceRaster(rasterKey);
    if (cached) {
      setFlattenedArtwork(cached);
      return;
    }
    return subscribeToSurfaceRaster(rasterKey, setFlattenedArtwork);
  }, [flattenedArtwork, rasterKey]);

  useEffect(() => {
    if (!artwork || flattenedArtwork || pendingSurfaceRasterCaptures.has(rasterKey)) return;
    pendingSurfaceRasterCaptures.add(rasterKey);
    let cancelled = false;
    let firstFrame = 0;
    let secondFrame = 0;
    const generationAtStart = surfaceArtworkGenerations.get(artworkSurfaceId) ?? 0;
    // Let Skia paint the full face once, then retain a single image for every
    // later placement and drag. The source strokes remain editable in SQLite.
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void canvasRef.current?.makeImageSnapshotAsync().then((image) => {
          if (cancelled || (surfaceArtworkGenerations.get(artworkSurfaceId) ?? 0) !== generationAtStart) return;
          cacheSurfaceRaster(rasterKey, image);
          const pngBytes = image.encodeToBytes(ImageFormat.PNG);
          void db.runAsync(
            `INSERT INTO surface_artwork_rasters
              (surface_id, variant, png_data, pixel_width, pixel_height, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(surface_id, variant) DO UPDATE SET
               png_data = excluded.png_data,
               pixel_width = excluded.pixel_width,
               pixel_height = excluded.pixel_height,
               updated_at = excluded.updated_at`,
            artworkSurfaceId,
            rasterVariant,
            pngBytes,
            image.width(),
            image.height(),
            Date.now()
          ).catch((error) => console.warn('Could not save cached surface artwork:', artworkSurfaceId, error));
          setFlattenedArtwork(image);
          setArtwork(null);
        }).catch(() => {
          // If the platform cannot snapshot this frame, keep drawing the live
          // Skia scene. The next mount can retry without affecting editing.
        }).finally(() => pendingSurfaceRasterCaptures.delete(rasterKey));
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      pendingSurfaceRasterCaptures.delete(rasterKey);
    };
  }, [artwork, artworkSurfaceId, canvasRef, db, flattenedArtwork, rasterKey, rasterVariant]);

  const pixelScale = width / tile.widthInches;
  const tileShapePath = useMemo(() => {
    const path = Skia.PathBuilder.Make();
    if (tile.shape === 'circle') {
      path.addOval({ x: 0, y: 0, width, height });
    } else if (tile.shape === 'square') {
      path.addRect({ x: 0, y: 0, width, height });
    } else {
      const points = tile.shape === 'hexagon'
        ? [
            { x: width * 0.25, y: 0 }, { x: width * 0.75, y: 0 }, { x: width, y: height * 0.5 },
            { x: width * 0.75, y: height }, { x: width * 0.25, y: height }, { x: 0, y: height * 0.5 },
          ]
        : [{ x: width * 0.5, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
      points.forEach((point, index) => {
        if (index === 0) path.moveTo(point.x, point.y);
        else path.lineTo(point.x, point.y);
      });
      path.close();
    }
    return path.build();
  }, [height, tile.shape, width]);

  // Decode the saved image bytes for Skia once. Keeping tile artwork in Skia
  // lets the polygon mask clip it transparently instead of painting the board
  // color into the corners (which could cover an adjacent tile underneath).
  const decodedArtwork = useMemo(() => {
    if (!artwork || flattenedArtwork) return null;
    const cached = tileArtworkImageCache.get(artwork.images);
    if (cached) return cached;
    const decode = (base64Data: string) => {
      try {
        return Skia.Image.MakeImageFromEncoded(Skia.Data.fromBase64(base64Data));
      } catch (error) {
        console.warn('Could not decode tile artwork image:', error);
        return null;
      }
    };
    const decoded: DecodedTileArtwork = {
      backgroundImage: artwork.backgroundImage ? decode(artwork.backgroundImage.base64Data) : null,
      images: artwork.images.map((image) => ({ ...image, decoded: decode(image.base64Data) })),
    };
    tileArtworkImageCache.set(artwork.images, decoded);
    return decoded;
  }, [artwork, flattenedArtwork]);
  // Build saved paths once per artwork load instead of rebuilding all tile
  // strokes whenever a neighboring piece or board control re-renders.
  const artworkStrokePaths = useMemo(
    () => {
       if (!artwork || flattenedArtwork) return [];
      const cached = tileArtworkPathCache.get(artwork.strokes);
      if (cached) return cached;
      const paths = artwork.strokes.map((stroke) => pointsToPath(stroke.points));
      tileArtworkPathCache.set(artwork.strokes, paths);
      return paths;
    },
    [artwork?.strokes, flattenedArtwork]
  );

  const outlineColor = selected ? '#315EFB' : '#4B5563';
  return (
    <View pointerEvents="none" style={{
      width,
      height,
      backgroundColor: 'transparent',
    }}>
      <Canvas ref={canvasRef} style={StyleSheet.absoluteFill}>
        {flattenedArtwork ? (
          <SkiaImage image={flattenedArtwork} x={0} y={0} width={width} height={height} fit="fill" />
        ) : (
          <Mask mask={<Path path={tileShapePath} color="#FFFFFF" />} mode="alpha">
            <Group>
              <Rect x={0} y={0} width={width} height={height} color={artwork?.backgroundColor ?? tile.color} />
              {decodedArtwork?.backgroundImage && (
                <SkiaImage
                  image={decodedArtwork.backgroundImage}
                  x={0}
                  y={0}
                  width={width}
                  height={height}
                  fit="cover"
                />
              )}
              <Group transform={[{ scale: pixelScale }]}>
                {artwork?.strokes.map((stroke, index) => !drawErasers && stroke.eraser ? null : (
                  <Path
                    key={`board-tile-stroke-${tile.id}-${index}`}
                    path={artworkStrokePaths[index]}
                    color={stroke.color}
                    style="stroke"
                    strokeWidth={stroke.width}
                    strokeCap="round"
                    strokeJoin="round"
                    blendMode={stroke.eraser ? 'clear' : 'srcOver'}
                  />
                ))}
              </Group>
              {decodedArtwork?.images.map((image) => image.decoded && (
                <SkiaImage
                  key={`board-tile-image-${image.id}`}
                  image={image.decoded}
                  x={(image.center.x - image.width / 2) * pixelScale}
                  y={(image.center.y - image.height / 2) * pixelScale}
                  width={image.width * pixelScale}
                  height={image.height * pixelScale}
                  fit="contain"
                />
              ))}
            </Group>
          </Mask>
        )}
      </Canvas>
      {showOutline && (
        <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Path path={tileShapePath} color={outlineColor} style="stroke" strokeWidth={selected ? 2.5 : 1.5} />
        </Canvas>
      )}
    </View>
  );
});

// A small, non-interactive thumbnail lets a saved deck spot show the actual top
// card. It reads the same strokes, images, and background that the card editor saves.
export const DeckSpotCardPreview = memo(function DeckSpotCardPreview({
  surfaceId,
  width,
  height,
  cardWidth,
  cardHeight,
}: {
  surfaceId: string;
  width: number;
  height: number;
  cardWidth: number;
  cardHeight: number;
}) {
  const cardTile: BoardTileVisual = {
    id: -1,
    name: 'Card face',
    shape: 'square',
    widthInches: cardWidth,
    heightInches: cardHeight,
    color: '#FFFFFF',
    frontSurfaceId: surfaceId,
    backSurfaceId: null,
  };
  return (
    <BoardTileArtworkPreview
      tile={cardTile}
      width={width}
      height={height}
      faceUp
      showOutline={false}
      drawErasers={false}
    />
  );
});

// Most pile markers are unchanged after a draw. Memoizing each marker means a
// draw only rerenders its source/destination preview and count badge.
export const DeckSpotMarkerView = memo(function DeckSpotMarkerView({
  spot,
  transformScale,
  offsetX,
  offsetY,
  selected,
  gameplayMode,
}: {
  spot: DeckSpot;
  transformScale: number;
  offsetX: number;
  offsetY: number;
  selected: boolean;
  gameplayMode: boolean;
}) {
  const cardSize = getDeckSpotSize(spot);
  const markerWidth = cardSize.width * transformScale;
  const markerHeight = cardSize.height * transformScale;
  const left = spot.x * transformScale + offsetX - markerWidth / 2;
  const top = spot.y * transformScale + offsetY - markerHeight / 2;
  const previewSurfaceId = spot.topCard
    ? spot.faceUp
      ? spot.topCard.frontSurfaceId
      : spot.topCard.backSurfaceId ?? spot.topCard.frontSurfaceId
    : null;

  return (
    <View
      pointerEvents="none"
      style={[
        drawingCanvasStyles.deckSpotMarker,
        selected && drawingCanvasStyles.selectedDeckSpotMarker,
        {
          left,
          top,
          width: markerWidth,
          height: markerHeight,
          transform: [{ rotate: `${spot.orientation}deg` }],
        },
      ]}
    >
      {previewSurfaceId && spot.topCard ? (
        <DeckSpotCardPreview
          surfaceId={previewSurfaceId}
          width={markerWidth - 4}
          height={markerHeight - 4}
          cardWidth={spot.topCard.widthInches}
          cardHeight={spot.topCard.heightInches}
        />
      ) : (
        <Text style={drawingCanvasStyles.emptyDeckSpotLabel}>Empty</Text>
      )}
      {gameplayMode && (
        <View style={drawingCanvasStyles.tileDeckCountBadge}>
          <Text style={drawingCanvasStyles.tileDeckCountText}>{spot.cardCount}</Text>
        </View>
      )}
    </View>
  );
});
