import { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas, Path, Image as SkiaImage } from '@shopify/react-native-skia';
import type { SkImage } from '@shopify/react-native-skia';
import { useSQLiteContext } from 'expo-sqlite';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type {
  BoardTilePlacement,
  BoardTileVisual,
  DeckSpot,
  TilePlacementPreview,
} from './drawingCanvasTypes';
import { getBoardTileSize, getDeckSpotSize, makeTileShapePath } from './drawingCanvasGeometry';
import {
  getCachedSurfaceRaster,
  getSurfaceRasterKey,
  loadSurfaceRaster,
  subscribeToSurfaceArtwork,
} from './surfaceArtworkCache';
import type { SurfaceRasterSpec } from './surfaceArtworkCache';
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
  const artworkSurfaceId = !faceUp && tile.backSurfaceId
    ? tile.backSurfaceId
    : tile.frontSurfaceId;
  const rasterSpec = useMemo<SurfaceRasterSpec>(() => ({
    surfaceId: artworkSurfaceId,
    shape: tile.shape,
    widthInches: tile.widthInches,
    heightInches: tile.heightInches,
    fallbackColor: tile.color,
    drawErasers,
  }), [artworkSurfaceId, drawErasers, tile.color, tile.heightInches, tile.shape, tile.widthInches]);
  const rasterKey = getSurfaceRasterKey(rasterSpec);
  // Every placement of the same face shares one flattened image, drawn once
  // from the saved artwork and then reused from memory or SQLite.
  const [flattened, setFlattened] = useState<{ key: string; image: SkImage | null }>(() => ({
    key: rasterKey,
    image: getCachedSurfaceRaster(rasterKey),
  }));

  // Bumped when this face is edited, so a preview that stays mounted (for
  // example on the board behind an editor) re-renders the new artwork.
  const [artworkRevision, setArtworkRevision] = useState(0);
  useEffect(
    () => subscribeToSurfaceArtwork(artworkSurfaceId, () => setArtworkRevision((revision) => revision + 1)),
    [artworkSurfaceId]
  );

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedSurfaceRaster(rasterKey);
    if (cached) {
      setFlattened((current) => current.key === rasterKey && current.image === cached
        ? current
        : { key: rasterKey, image: cached });
      return;
    }
    setFlattened((current) => current.key === rasterKey ? current : { key: rasterKey, image: null });
    void loadSurfaceRaster(db, rasterSpec).then((image) => {
      if (!cancelled && image) setFlattened({ key: rasterKey, image });
    });
    return () => { cancelled = true; };
  }, [artworkRevision, db, rasterKey, rasterSpec]);

  const flattenedArtwork = flattened.key === rasterKey ? flattened.image : null;
  const tileShapePath = useMemo(
    () => makeTileShapePath(tile.shape, width, height),
    [height, tile.shape, width]
  );

  const outlineColor = selected ? '#315EFB' : '#4B5563';
  return (
    <View pointerEvents="none" style={{
      width,
      height,
      backgroundColor: 'transparent',
    }}>
      <Canvas style={StyleSheet.absoluteFill}>
        {flattenedArtwork ? (
          <SkiaImage image={flattenedArtwork} x={0} y={0} width={width} height={height} fit="fill" />
        ) : (
          // Plain face while the artwork loads.
          <Path path={tileShapePath} color={tile.color} />
        )}
        {showOutline && (
          <Path path={tileShapePath} color={outlineColor} style="stroke" strokeWidth={selected ? 2.5 : 1.5} />
        )}
      </Canvas>
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
