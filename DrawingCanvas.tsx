import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Alert, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Canvas, Path, Skia, Circle, Group, Image as SkiaImage, Mask, Rect, FillType } from '@shopify/react-native-skia';
import Slider from '@react-native-community/slider';
import { GestureDetector, usePanGesture, useSimultaneousGestures, usePinchGesture } from 'react-native-gesture-handler';
import ColorPicker, { BrightnessSlider, Panel3, Preview } from 'reanimated-color-picker';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import * as ImagePicker from 'expo-image-picker';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import type { HostInstance } from 'react-native';
import type { Point, SavedStrokeRow, Stroke } from './types';
import { styles } from './styles';
import { drawingCanvasStyles } from './drawingCanvasStyles';

const SYMBOL_CANVAS_SIZE = 300;
const DECK_SPOT_UNITS_PER_INCH = 24;
const DECK_SPOT_MAX_EDGE = 120;
const EMPTY_DECK_SPOT_SIZE_INCHES = 2.5;
const BOARD_TILE_UNITS_PER_INCH = 24;
const BOARD_TILE_MAX_EDGE = 240;
// pointsToPath converts a list of points into a Skia Path object.
// This is important because the drawing canvas does not draw freehand lines directly from
// an array of coordinates. Instead, it turns the points into a path that the Canvas can
// render as a smooth stroke.
function pointsToPath(points: Point[]) {
  const path = Skia.PathBuilder.Make();

  if (points.length > 0) {
    // Start the path at the first point, then connect every next point with a line.
    path.moveTo(points[0].x, points[0].y);

    for (const point of points.slice(1)) {
      path.lineTo(point.x, point.y);
    }
  }

  return path.build();
}

type StrokeBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type SymbolTransformSession = {
  groupId: string;
  baseStrokes: Stroke[];
  updatedStrokes: Stroke[];
  center: Point;
  startPoint: Point;
  /** Set when a corner handle starts a drag, so that drag scales instead of moves. */
  resizeStartDistance?: number;
  changed: boolean;
};

type PlacedImage = {
  id: number;
  base64Data: string;
  mimeType: string;
  center: Point;
  width: number;
  height: number;
};

type LoadedSurfaceArtwork = {
  backgroundColor: string | null;
  backgroundImage: { base64Data: string; mimeType: string } | null;
  strokes: Stroke[];
  images: PlacedImage[];
};

// Several placed copies can use one saved token, tile, or card face. Share an
// in-flight load so those previews do not all run the same three SQLite reads.
const pendingSurfaceArtworkLoads = new Map<string, Promise<LoadedSurfaceArtwork>>();

function loadSurfaceArtwork(db: SQLiteDatabase, surfaceId: string): Promise<LoadedSurfaceArtwork> {
  const pendingLoad = pendingSurfaceArtworkLoads.get(surfaceId);
  if (pendingLoad) return pendingLoad;

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
  }));

  pendingSurfaceArtworkLoads.set(surfaceId, load);
  void load.finally(() => {
    if (pendingSurfaceArtworkLoads.get(surfaceId) === load) {
      pendingSurfaceArtworkLoads.delete(surfaceId);
    }
  }).catch(() => {
    // The caller reports the read error. This catch only prevents an unhandled
    // rejection from the cleanup promise returned by finally().
  });
  return load;
}

type DeckSpotType = 'deck' | 'discard';

type DeckSpot = {
  id: number;
  x: number;
  y: number;
  orientation: number;
  spotType: DeckSpotType;
  deckId: number | null;
  faceUp: boolean;
  cardCount: number;
  topCard: {
    name: string;
    frontSurfaceId: string;
    backSurfaceId: string | null;
    widthInches: number;
    heightInches: number;
  } | null;
};

type DeckSpotDragSession = {
  spotId: number;
  baseSpot: DeckSpot;
  updatedSpot: DeckSpot;
  startPoint: Point;
  changed: boolean;
};

type TileSnapPoint = { id: number; x: number; y: number; orientation: number };
type TileSnapDragSession = {
  pointId: number;
  basePoint: TileSnapPoint;
  updatedPoint: TileSnapPoint;
  startPoint: Point;
  changed: boolean;
};

export type BoardTileVisual = {
  id: number;
  name: string;
  shape: 'hexagon' | 'square' | 'triangle' | 'circle';
  widthInches: number;
  heightInches: number;
  color: string;
  frontSurfaceId: string;
  backSurfaceId: string | null;
};

export type BoardDieFace = { sideNumber: number; surfaceId: string };

export type BoardDieVisual = {
  id: number;
  name: string;
  sideCount: number;
  widthInches: number;
  heightInches: number;
  color: string;
  faces: BoardDieFace[];
};

export type BoardTileDeckPlacement = {
  id: number;
  name: string;
  tileCount: number;
  topTile: BoardTileVisual | null;
};

export type BoardTokenSupply = {
  token: BoardTileVisual;
  /** null means this supply never runs out. */
  quantity: number | null;
};

type BoardTokenPlacement = {
  id: number;
  x: number;
  y: number;
  orientation: number;
  faceUp: boolean;
  token: BoardTileVisual;
};

type BoardDiePlacement = {
  id: number;
  x: number;
  y: number;
  orientation: number;
  faceNumber: number;
  die: BoardDieVisual;
};

type TokenMarkerDragSession = {
  kind: 'supply' | 'token' | 'die';
  id: number;
  startPoint: Point;
  startX: number;
  startY: number;
  updatedX: number;
  updatedY: number;
  changed: boolean;
};

type GameplayTakeDragSession = {
  kind: 'token' | 'tile';
  sourceId: number;
  startPoint: Point;
  updatedPoint: Point;
  changed: boolean;
};

type DeckCardDragSession = {
  sourceSpotId: number;
  startPoint: Point;
  updatedPoint: Point;
  screenY: number;
  changed: boolean;
};

type GameplayTakePreview = {
  kind: 'token' | 'tile';
  sourceId: number;
  tile: BoardTileVisual;
  startPoint: Point;
};

type BoardTilePlacement = {
  id: number;
  x: number;
  y: number;
  orientation: number;
  faceUp: boolean;
  tileId: number | null;
  deckId: number | null;
  deckName: string | null;
  tileCount: number;
  tile: BoardTileVisual | null;
};

type TokenSupplyPlacement = {
  id: number;
  x: number;
  y: number;
  orientation: number;
  quantity: number | null;
  token: BoardTileVisual;
};

type TilePlacementDragSession = {
  placementId: number;
  basePlacement: BoardTilePlacement;
  updatedPlacement: BoardTilePlacement;
  startPoint: Point;
  changed: boolean;
};

type TilePlacementPreview = {
  tile: BoardTileVisual | null;
  deckId: number | null;
  deckName: string | null;
  tileCount: number;
  faceUp: boolean;
  x: number;
  y: number;
  orientation: number;
  snapped: boolean;
};

type ImageTransformSession = {
  imageId: number;
  baseImage: PlacedImage;
  updatedImage: PlacedImage;
  center: Point;
  startPoint: Point;
  resizeStartDistance?: number;
  changed: boolean;
};

function getStrokeBounds(strokes: Stroke[]): StrokeBounds | null {
  let bounds: StrokeBounds | null = null;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (!bounds) {
        bounds = { left: point.x, top: point.y, right: point.x, bottom: point.y };
        continue;
      }
      bounds.left = Math.min(bounds.left, point.x);
      bounds.top = Math.min(bounds.top, point.y);
      bounds.right = Math.max(bounds.right, point.x);
      bounds.bottom = Math.max(bounds.bottom, point.y);
    }
  }
  return bounds;
}

type PlacedSymbolHitTarget = { groupId: string; strokes: Stroke[]; bounds: StrokeBounds };

function buildPlacedSymbolHitTargets(strokes: Stroke[]): PlacedSymbolHitTarget[] {
  const groups = new Map<string, Stroke[]>();
  for (const stroke of strokes) {
    if (!stroke.groupId) continue;
    const groupStrokes = groups.get(stroke.groupId);
    if (groupStrokes) groupStrokes.push(stroke);
    else groups.set(stroke.groupId, [stroke]);
  }
  return [...groups.entries()].reverse().flatMap(([groupId, groupStrokes]) => {
    const bounds = getStrokeBounds(groupStrokes);
    return bounds ? [{ groupId, strokes: groupStrokes, bounds }] : [];
  });
}

function findPlacedSymbolAtPoint(
  hitTargets: PlacedSymbolHitTarget[],
  point: Point,
  tolerance: number
): PlacedSymbolHitTarget | null {
  // Targets are prebuilt in topmost-first order. This check only compares a
  // point against cached rectangles, instead of rescanning every stroke group.
  for (const target of hitTargets) {
    const { bounds } = target;
    if (
      point.x >= bounds.left - tolerance &&
      point.x <= bounds.right + tolerance &&
      point.y >= bounds.top - tolerance &&
      point.y <= bounds.bottom + tolerance
    ) {
      return target;
    }
  }

  return null;
}

function transformSymbolStrokes(
  strokes: Stroke[],
  center: Point,
  scale: number,
  offset: Point = { x: 0, y: 0 },
  minimumWidth = 1
): Stroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({
      x: center.x + (point.x - center.x) * scale + offset.x,
      y: center.y + (point.y - center.y) * scale + offset.y,
    })),
    width: Math.max(minimumWidth, stroke.width * scale),
  }));
}

function findPlacedImageAtPoint(
  images: PlacedImage[],
  point: Point,
  tolerance: number
): PlacedImage | null {
  // Later images are drawn above earlier ones, so search backwards to pick the
  // image the user sees when two images overlap.
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const image = images[index];
    if (
      point.x >= image.center.x - image.width / 2 - tolerance &&
      point.x <= image.center.x + image.width / 2 + tolerance &&
      point.y >= image.center.y - image.height / 2 - tolerance &&
      point.y <= image.center.y + image.height / 2 + tolerance
    ) {
      return image;
    }
  }
  return null;
}

function findDeckSpotAtPoint(
  spots: DeckSpot[],
  point: Point,
  tolerance: number
): DeckSpot | null {
  for (let index = spots.length - 1; index >= 0; index -= 1) {
    const spot = spots[index];
    const size = getDeckSpotSize(spot);
    const hitRadius = Math.hypot(size.width / 2, size.height / 2) + tolerance;
    if (Math.hypot(point.x - spot.x, point.y - spot.y) <= hitRadius) {
      return spot;
    }
  }
  return null;
}

// Use stored inch dimensions to size each marker. A shared pixel scale makes
// ordinary cards feel consistent; the cap keeps oversized custom cards usable.
function getDeckSpotSize(spot: DeckSpot) {
  const cardWidth = spot.topCard?.widthInches ?? EMPTY_DECK_SPOT_SIZE_INCHES;
  const cardHeight = spot.topCard?.heightInches ?? EMPTY_DECK_SPOT_SIZE_INCHES;
  const scale = Math.min(
    DECK_SPOT_UNITS_PER_INCH,
    DECK_SPOT_MAX_EDGE / Math.max(cardWidth, cardHeight)
  );
  return {
    width: cardWidth * scale,
    height: cardHeight * scale,
  };
}

function getBoardTileSize(tile: BoardTileVisual | null) {
  const widthInches = tile?.widthInches ?? EMPTY_DECK_SPOT_SIZE_INCHES;
  // A regular flat-top hexagon is 2 / sqrt(3) times wider than it is tall.
  // Keep the stored width and derive its height so all six sides match.
  const heightInches = tile?.shape === 'hexagon'
    ? widthInches * Math.sqrt(3) / 2
    : tile?.heightInches ?? EMPTY_DECK_SPOT_SIZE_INCHES;
  const scale = Math.min(
    BOARD_TILE_UNITS_PER_INCH,
    BOARD_TILE_MAX_EDGE / Math.max(widthInches, heightInches)
  );
  return { width: widthInches * scale, height: heightInches * scale };
}

function getDieFaceTile(die: BoardDieVisual, faceNumber: number): BoardTileVisual {
  const face = die.faces.find((item) => item.sideNumber === faceNumber) ?? die.faces[0];
  return {
    id: die.id,
    name: `${die.name} · Side ${face?.sideNumber ?? 1}`,
    shape: 'square',
    widthInches: die.widthInches,
    heightInches: die.heightInches,
    color: die.color,
    frontSurfaceId: face?.surfaceId ?? '',
    backSurfaceId: null,
  };
}

function findNearestTileSnapPoint(
  snapPoints: TileSnapPoint[],
  point: Point,
  threshold: number
) {
  let nearest: TileSnapPoint | null = null;
  let nearestDistance = threshold;
  for (const snapPoint of snapPoints) {
    const distance = Math.hypot(point.x - snapPoint.x, point.y - snapPoint.y);
    if (distance <= nearestDistance) {
      nearest = snapPoint;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function findBoardTileAtPoint<T extends { x: number; y: number; orientation: number; tile: BoardTileVisual | null }>(
  placements: T[],
  point: Point,
  tolerance: number
): T | null {
  for (let index = placements.length - 1; index >= 0; index -= 1) {
    const placement = placements[index];
    const size = getBoardTileSize(placement.tile);
    const angle = -placement.orientation * Math.PI / 180;
    const dx = point.x - placement.x;
    const dy = point.y - placement.y;
    // Test in the tile's unrotated space, so the touch target follows the same
    // outline the player sees instead of selecting through the empty corners.
    const localPoint = {
      x: dx * Math.cos(angle) - dy * Math.sin(angle) + size.width / 2,
      y: dx * Math.sin(angle) + dy * Math.cos(angle) + size.height / 2,
    };
    if (placement.tile?.shape === 'circle') {
      const rx = size.width / 2 + tolerance;
      const ry = size.height / 2 + tolerance;
      if ((localPoint.x - size.width / 2) ** 2 / (rx * rx)
        + (localPoint.y - size.height / 2) ** 2 / (ry * ry) <= 1) return placement;
      continue;
    }

    const vertices: Point[] = placement.tile?.shape === 'hexagon'
      ? [
          { x: size.width * 0.25, y: 0 }, { x: size.width * 0.75, y: 0 },
          { x: size.width, y: size.height * 0.5 }, { x: size.width * 0.75, y: size.height },
          { x: size.width * 0.25, y: size.height }, { x: 0, y: size.height * 0.5 },
        ]
      : placement.tile?.shape === 'triangle'
        ? [
            { x: size.width * 0.5, y: 0 }, { x: size.width, y: size.height },
            { x: 0, y: size.height },
          ]
        : [
            { x: 0, y: 0 }, { x: size.width, y: 0 },
            { x: size.width, y: size.height }, { x: 0, y: size.height },
          ];
    const inside = vertices.every((start, vertexIndex) => {
      const end = vertices[(vertexIndex + 1) % vertices.length];
      const edgeX = end.x - start.x;
      const edgeY = end.y - start.y;
      const side = edgeX * (localPoint.y - start.y) - edgeY * (localPoint.x - start.x);
      return side >= -tolerance * Math.hypot(edgeX, edgeY);
    });
    if (inside) return placement;
  }
  return null;
}

// DrawingCanvas is the shared freehand drawing surface for board, symbol, and card work.
// It handles touch input, saves strokes, supports erasing, and provides canvas color,
// pen color, undo/redo, and line-width controls.
export type DrawingCanvasHandle = {
  /** Open the image picker for this drawing surface. */
  importImage: () => void;
  /** Refresh only the card-pile preview after a card moves during gameplay. */
  refreshGameplayPiles: () => void;
  /** Refresh board pieces after loading or resetting a saved game. */
  refreshGameplayState: () => void;
};

type DrawingCanvasProps = {
  bottomInset: number;
  /** Top offset for controls that should line up with the app's safe-area menu. */
  topInset?: number;
  transparentBackground?: boolean;
  defaultBackgroundColor?: string;
  compactToolbar?: boolean;
  /** Let small token previews center the compact toolbar beyond their bounds. */
  expandCompactToolbar?: boolean;
  /** Number of screen points represented by one stored drawing unit. */
  coordinateScale?: number;
  /** Clip the artwork to a polygonal tile boundary when editing a tile face. */
  surfaceShape?: 'hexagon' | 'triangle' | 'circle';
  /** Keep the compact drawing controls inside a hex tile's wide middle band. */
  hexagonToolbar?: boolean;
  surfaceId?: string;
  allowImageAsBackground?: boolean;
  symbolId?: number;
  placementSymbolId?: number;
  placementSymbolName?: string;
  placementDeckSpot?: { spotType: DeckSpotType; deckId: number | null; faceUp: boolean };
  placementTileSnapPoint?: boolean;
  placementTile?: BoardTileVisual;
  placementTileDeck?: BoardTileDeckPlacement;
  placementTokenSupply?: BoardTokenSupply;
  placementToken?: BoardTileVisual;
  placementDie?: BoardDieVisual;
  tilePlacementRevision?: number;
  repeatSymbolPlacement?: boolean;
  placementSymbolScale?: number;
  onSymbolPlaced?: () => void;
  onDeckSpotPlaced?: () => void;
  onCancelDeckSpotPlacement?: () => void;
  onTileSnapPointPlaced?: () => void;
  onCancelTileSnapPointPlacement?: () => void;
  onTilePlaced?: () => void;
  onTileDeckPlaced?: () => void;
  onCancelTilePlacement?: () => void;
  onCancelTokenSupplyPlacement?: () => void;
  onCancelTokenPlacement?: () => void;
  onCancelDiePlacement?: () => void;
  onBoardTileTypeChangeRequested?: (placementId: number) => void;
  isEditingSymbols?: boolean;
  onStopEditingSymbols?: () => void;
  gameplayMode?: boolean;
  gameplayDrawFaceUp?: boolean;
  onDeckCardDragRequest?: (sourceSpotId: number, targetSpotId: number | null, absoluteY: number) => void;
  handCardDropRequest?: { requestId: number; cardInstanceId: number; absoluteX: number; absoluteY: number };
  onHandCardDropResolved?: (request: { requestId: number; cardInstanceId: number }, deckSpotId: number | null) => void;
};

export const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(function DrawingCanvas({
    bottomInset,
    topInset = 12,
    transparentBackground = false,
    defaultBackgroundColor = '#DDE8D2',
    compactToolbar = false,
    expandCompactToolbar = false,
    coordinateScale = 1,
    surfaceShape,
    hexagonToolbar = false,
    surfaceId,
    allowImageAsBackground = false,
    symbolId,
    placementSymbolId,
    placementSymbolName,
    placementDeckSpot,
    placementTileSnapPoint = false,
    placementTile,
    placementTileDeck,
    placementTokenSupply,
    placementToken,
    placementDie,
    tilePlacementRevision = 0,
    repeatSymbolPlacement = false,
    placementSymbolScale = 0.35,
    onSymbolPlaced,
    onDeckSpotPlaced,
    onCancelDeckSpotPlacement,
    onTileSnapPointPlaced,
    onCancelTileSnapPointPlacement,
    onTilePlaced,
    onTileDeckPlaced,
    onCancelTilePlacement,
    onCancelTokenSupplyPlacement,
    onCancelTokenPlacement,
    onCancelDiePlacement,
    onBoardTileTypeChangeRequested,
    isEditingSymbols = false,
    onStopEditingSymbols,
    gameplayMode = false,
    gameplayDrawFaceUp = false,
    onDeckCardDragRequest,
    handCardDropRequest,
    onHandCardDropResolved,
  }: DrawingCanvasProps, ref) {

  const db = useSQLiteContext();
  // lineWidth controls stroke thickness for the pen tool.
  const [lineWidth, setLineWidth] = useState(4);

  // isErasing switches between pen mode and eraser mode.
  const [isErasing, setIsErasing] = useState(false);

  // strokes stores all completed lines that have been drawn and finalized.
  const [strokes, setStrokes] = useState<Stroke[]>([]);

  // Keep the chosen library symbol separate from map strokes until the user taps
  // the map. Including its ID prevents a previous symbol from being stamped while
  // a newly selected symbol is still loading.
  const [placementSymbolData, setPlacementSymbolData] = useState<{
    id: number;
    strokes: Stroke[];
  } | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [placedImages, setPlacedImages] = useState<PlacedImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<number | null>(null);
  const [deckSpots, setDeckSpots] = useState<DeckSpot[]>([]);
  const [gameplayRefreshRevision, setGameplayRefreshRevision] = useState(0);
  const [gameplayPileRevision, setGameplayPileRevision] = useState(0);
  const [deckCardDragPreview, setDeckCardDragPreview] = useState<{ spot: DeckSpot; startPoint: Point } | null>(null);
  const [selectedDeckSpotId, setSelectedDeckSpotId] = useState<number | null>(null);
  const [tileSnapPoints, setTileSnapPoints] = useState<TileSnapPoint[]>([]);
  const [selectedTileSnapPointId, setSelectedTileSnapPointId] = useState<number | null>(null);
  const [boardTilePlacements, setBoardTilePlacements] = useState<BoardTilePlacement[]>([]);
  const [selectedBoardTilePlacementId, setSelectedBoardTilePlacementId] = useState<number | null>(null);
  const [tokenSupplyPlacements, setTokenSupplyPlacements] = useState<TokenSupplyPlacement[]>([]);
  const [boardTokenPlacements, setBoardTokenPlacements] = useState<BoardTokenPlacement[]>([]);
  const [selectedTokenSupplyId, setSelectedTokenSupplyId] = useState<number | null>(null);
  const [selectedBoardTokenId, setSelectedBoardTokenId] = useState<number | null>(null);
  const [activeGameplayDragKey, setActiveGameplayDragKey] = useState<string | null>(null);
  const [gameplayTokenSupplyChoice, setGameplayTokenSupplyChoice] = useState<number | null>(null);
  const [gameplayTileDeckChoice, setGameplayTileDeckChoice] = useState<number | null>(null);
  const [gameplayTakePreview, setGameplayTakePreview] = useState<GameplayTakePreview | null>(null);
  const [boardDiePlacements, setBoardDiePlacements] = useState<BoardDiePlacement[]>([]);
  const [selectedBoardDieId, setSelectedBoardDieId] = useState<number | null>(null);
  const [selectedGameplayDieIds, setSelectedGameplayDieIds] = useState<number[]>([]);
  const [tilePlacementPreview, setTilePlacementPreview] = useState<TilePlacementPreview | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const rootViewRef = useRef<HostInstance | null>(null);
  const canvasWindowOriginRef = useRef({ x: 0, y: 0 });
  const symbolDragSessionRef = useRef<SymbolTransformSession | null>(null);
  const symbolPinchSessionRef = useRef<SymbolTransformSession | null>(null);
  const placedSymbolHitTargetsRef = useRef<{ strokes: Stroke[]; targets: PlacedSymbolHitTarget[] } | null>(null);
  const imageDragSessionRef = useRef<ImageTransformSession | null>(null);
  const imagePinchSessionRef = useRef<ImageTransformSession | null>(null);
  const deckSpotDragSessionRef = useRef<DeckSpotDragSession | null>(null);
  const tileSnapDragSessionRef = useRef<TileSnapDragSession | null>(null);
  const tilePlacementDragSessionRef = useRef<TilePlacementDragSession | null>(null);
  const tilePlacementSessionRef = useRef<TilePlacementPreview | null>(null);
  const tokenMarkerDragSessionRef = useRef<TokenMarkerDragSession | null>(null);
  const gameplayTakeDragSessionRef = useRef<GameplayTakeDragSession | null>(null);
  const deckCardDragSessionRef = useRef<DeckCardDragSession | null>(null);
  const tokenMarkerRenderFrameRef = useRef<number | null>(null);
  const lastTokenMarkerRenderAtRef = useRef(0);
  const lastTilePreviewRenderAtRef = useRef(0);
  // These values move the active piece on the UI thread while play mode is
  // dragging. That avoids rebuilding every stroke and marker on every touch.
  const activePieceOffsetX = useSharedValue(0);
  const activePieceOffsetY = useSharedValue(0);
  const activePieceRotation = useSharedValue(0);
  const activePieceDragStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: activePieceOffsetX.value },
      { translateY: activePieceOffsetY.value },
      { rotate: `${activePieceRotation.value}deg` },
    ],
  }));

  useEffect(() => {
    if (!gameplayMode) setSelectedGameplayDieIds([]);
  }, [gameplayMode, surfaceId]);

  useEffect(() => () => {
    if (tokenMarkerRenderFrameRef.current !== null) {
      cancelAnimationFrame(tokenMarkerRenderFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (placementTile === undefined && placementTileDeck === undefined && !tilePlacementDragSessionRef.current) {
      tilePlacementSessionRef.current = null;
      setTilePlacementPreview(null);
    }
  }, [placementTile, placementTileDeck]);

  // redoStrokes stores strokes removed by Undo. We take them from the end of this
  // array so redo restores them in the same order they were originally drawn.
  const [redoStrokes, setRedoStrokes] = useState<Stroke[][]>([]);
  const placementGroupCounterRef = useRef(0);

  // Database writes are queued so a fast Undo/Redo sequence cannot save operations
  // out of order (for example, a new stroke finishing after an undo deletion).
  const databaseActionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueDatabaseAction = useCallback((
    action: () => Promise<void>,
    errorMessage: string
  ) => {
    databaseActionQueueRef.current = databaseActionQueueRef.current
      .then(action)
      .catch((error) => {
        console.error(errorMessage, error);
      });
  }, []);

  // draft is the stroke currently being drawn while the user is touching the screen.
  // It is separate from strokes so we can show the live-in-progress path before it is saved.
  const [draft, setDraft] = useState<Stroke | null>(null);

  // draftRef keeps the current stroke in a ref so it can be updated quickly without forcing
  // a re-render for every movement. The path is rendered at most once per animation frame.
  const draftRef = useRef<Stroke | null>(null);
  const draftRenderFrameRef = useRef<number | null>(null);
  const draftPathNeedsRenderRef = useRef(false);
  const latestDraftPointRef = useRef<Point | null>(null);

  // eraserPosition tracks the current touch point while erasing so we can show a small
  // circular cursor on the canvas.
  const [eraserPosition, setEraserPosition] = useState<Point | null>(null);

  // backgroundColor is the color behind the drawing area.
  const [backgroundColor, setBackgroundColor] = useState(defaultBackgroundColor);
  const [surfaceBackgroundImage, setSurfaceBackgroundImage] = useState<{
    base64Data: string;
    mimeType: string;
  } | null>(null);

  // penColor is the color used by the pen tool.
  const [penColor, setPenColor] = useState('#111827');

  // colorPickerTarget tells us whether the color picker is for the board background or pen color.
  // When it is null, the modal is closed.
  const [colorPickerTarget, setColorPickerTarget] =
    useState<'background' | 'pen' | null>(null);

  const scheduleDraftRender = useCallback((renderDraftPath = true) => {
    if (renderDraftPath) {
      draftPathNeedsRenderRef.current = true;
    }

    if (draftRenderFrameRef.current !== null) {
      return;
    }

    draftRenderFrameRef.current = requestAnimationFrame(() => {
      draftRenderFrameRef.current = null;
      const current = draftRef.current;

      if (draftPathNeedsRenderRef.current && current) {
        // Reuse the mutable points array instead of copying all prior points per update.
        setDraft({ ...current });
      }

      draftPathNeedsRenderRef.current = false;

      if (current?.eraser && latestDraftPointRef.current) {
        setEraserPosition(latestDraftPointRef.current);
      }
    });
  }, []);

  useEffect(() => () => {
    if (draftRenderFrameRef.current !== null) {
      cancelAnimationFrame(draftRenderFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (surfaceId === undefined && symbolId === undefined) return;

    let cancelled = false;

    const loadSavedStrokes = async () => {
      try {
        // Board strokes belong to a project surface. Symbol strokes belong to the
        // shared symbol library, so each canvas loads from its matching table.
        let rows: SavedStrokeRow[];
        if (symbolId !== undefined) {
          rows = await db.getAllAsync<SavedStrokeRow>(
            `SELECT points_json, width, color, is_eraser
            FROM symbol_strokes
            WHERE symbol_id = ?
            ORDER BY order_index ASC`,
            symbolId
          );
        } else if (surfaceId !== undefined) {
          rows = await db.getAllAsync<SavedStrokeRow>(
            `SELECT points_json, width, color, is_eraser, group_id
            FROM strokes
            WHERE surface_id = ?
            ORDER BY order_index ASC`,
            surfaceId
          );
        } else {
          return;
        }

        if (!cancelled) {
          setStrokes(
            rows.map((row) => ({
              points: JSON.parse(row.points_json) as Point[],
              width: row.width,
              color: row.color,
              eraser: row.is_eraser === 1,
              groupId: row.group_id ?? undefined,
            }))
          );
        }
      } catch (error) {
        console.error(
          symbolId !== undefined
            ? 'Could not load symbol strokes:'
            : 'Could not load board strokes:',
          error
        );
      }
    };

    void loadSavedStrokes();

    return () => {
      cancelled = true;
    };
  }, [db, surfaceId, symbolId]);

  // Imported artwork lives on the same drawing surface as its card or board.
  // Keeping its position and size as numbers lets it move with zoom and pan.
  useEffect(() => {
    if (surfaceId === undefined) {
      setPlacedImages([]);
      setSelectedImageId(null);
      setDeckSpots([]);
      setSelectedDeckSpotId(null);
      return;
    }

    let cancelled = false;
    const loadSurfaceImages = async () => {
      try {
        const rows = await db.getAllAsync<{
          id: number;
          base64_data: string;
          mime_type: string;
          center_x: number;
          center_y: number;
          width: number;
          height: number;
        }>(
          `SELECT id, base64_data, mime_type, center_x, center_y, width, height
          FROM surface_images
          WHERE surface_id = ?
          ORDER BY order_index ASC`,
          surfaceId
        );

        if (!cancelled) {
          setPlacedImages(rows.map((row) => ({
            id: row.id,
            base64Data: row.base64_data,
            mimeType: row.mime_type,
            center: { x: row.center_x, y: row.center_y },
            width: row.width,
            height: row.height,
          })));
          setSelectedImageId(null);
        }
      } catch (error) {
        console.error('Could not load images for drawing surface:', error);
      }
    };

    void loadSurfaceImages();
    return () => {
      cancelled = true;
    };
  }, [db, surfaceId]);

  useEffect(() => {
    if (surfaceId === undefined) {
      setBoardTokenPlacements([]);
      return;
    }
    let cancelled = false;
    const loadBoardTokens = async () => {
      try {
        const rows = await db.getAllAsync<{
          id: number; x: number; y: number; orientation: number; face_up: number;
          token_id: number; name: string; shape: BoardTileVisual['shape'];
          width_inches: number; height_inches: number; color: string;
          front_surface_id: string; back_surface_id: string | null;
        }>(
          `SELECT placement.id,
            CASE WHEN ? = 1 THEN COALESCE(state.x, placement.x) ELSE placement.x END AS x,
            CASE WHEN ? = 1 THEN COALESCE(state.y, placement.y) ELSE placement.y END AS y,
            CASE WHEN ? = 1 THEN COALESCE(state.orientation, placement.orientation) ELSE placement.orientation END AS orientation,
            CASE WHEN ? = 1 THEN COALESCE(state.face_up, placement.face_up) ELSE placement.face_up END AS face_up,
            token.id AS token_id, token.name, token.shape, token.width_inches,
            token.height_inches, token.color, token.surface_id AS front_surface_id,
            token.back_surface_id
           FROM token_board_placements AS placement
           LEFT JOIN gameplay_token_placement_states AS state
            ON state.placement_id = placement.id AND state.project_id = ?
           JOIN game_tokens AS token ON token.id = placement.token_id
           WHERE placement.surface_id = ?
             AND (? = 0 OR COALESCE(state.is_returned, 0) = 0)
             AND (? = 1 OR COALESCE(state.is_added, 0) = 0)
           ORDER BY placement.id`,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0,
          surfaceId.replace(/-board$/, ''),
          surfaceId,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0
        );
        if (!cancelled) setBoardTokenPlacements(rows.map((row) => ({
          id: row.id,
          x: row.x,
          y: row.y,
          orientation: row.orientation,
          faceUp: row.face_up !== 0,
          token: {
            id: row.token_id,
            name: row.name,
            shape: row.shape,
            widthInches: row.width_inches,
            heightInches: row.height_inches,
            color: row.color,
            frontSurfaceId: row.front_surface_id,
            backSurfaceId: row.back_surface_id,
          },
        })));
      } catch (error) {
        console.error('Could not load placed tokens:', error);
      }
    };
    void loadBoardTokens();
    return () => { cancelled = true; };
  }, [db, gameplayMode, gameplayRefreshRevision, surfaceId]);

  useEffect(() => {
    if (surfaceId === undefined) {
      setBoardDiePlacements([]);
      return;
    }
    let cancelled = false;
    const loadPlacedDice = async () => {
      try {
        const rows = await db.getAllAsync<{
          id: number; x: number; y: number; orientation: number; face_number: number;
          die_id: number; name: string; side_count: number; width_inches: number;
          height_inches: number; color: string;
        }>(
          `SELECT placement.id, placement.x, placement.y, placement.orientation,
            CASE WHEN ? = 1 THEN COALESCE(game_state.face_number, placement.face_number)
              ELSE placement.face_number END AS face_number,
            die.id AS die_id, die.name, die.side_count,
            die.width_inches, die.height_inches, die.color
           FROM die_board_placements AS placement
           JOIN game_dice AS die ON die.id = placement.die_id
           LEFT JOIN gameplay_die_placement_states AS game_state
             ON game_state.project_id = ? AND game_state.placement_id = placement.id
           WHERE placement.surface_id = ? ORDER BY placement.id`,
          gameplayMode ? 1 : 0,
          surfaceId.replace(/-board$/, ''),
          surfaceId
        );
        const faces = await db.getAllAsync<{ die_id: number; side_number: number; surface_id: string }>(
          `SELECT face.die_id, face.side_number, face.surface_id
           FROM game_die_faces AS face JOIN game_dice AS die ON die.id = face.die_id
           WHERE die.project_id = ? ORDER BY face.side_number`,
          surfaceId.replace(/-board$/, '')
        );
        if (!cancelled) setBoardDiePlacements(rows.map((row) => ({
          id: row.id,
          x: row.x,
          y: row.y,
          orientation: row.orientation,
          faceNumber: row.face_number,
          die: {
            id: row.die_id,
            name: row.name,
            sideCount: row.side_count,
            widthInches: row.width_inches,
            heightInches: row.height_inches,
            color: row.color,
            faces: faces.filter((face) => face.die_id === row.die_id).map((face) => ({
              sideNumber: face.side_number,
              surfaceId: face.surface_id,
            })),
          },
        })));
      } catch (error) {
        console.error('Could not load placed dice:', error);
      }
    };
    void loadPlacedDice();
    return () => { cancelled = true; };
  }, [db, gameplayMode, gameplayRefreshRevision, surfaceId]);

  // Load both individual tiles and deck piles from the board. A deck placement
  // also resolves its first remaining tile so the pile can show a useful preview.
  useEffect(() => {
    if (surfaceId === undefined) {
      setBoardTilePlacements([]);
      setSelectedBoardTilePlacementId(null);
      return;
    }
    let cancelled = false;
    const loadTilePlacements = async () => {
      try {
        const rows = await db.getAllAsync<{
          id: number; x: number; y: number; orientation: number; face_up: number;
          tile_id: number | null; deck_id: number | null; deck_name: string | null;
          tile_count: number; visual_tile_id: number | null; tile_name: string | null;
          tile_shape: BoardTileVisual['shape'] | null; width_inches: number | null;
          height_inches: number | null; color: string | null; front_surface_id: string | null;
          back_surface_id: string | null;
        }>(
          `SELECT placement.id,
            CASE WHEN ? = 1 THEN COALESCE(state.x, placement.x) ELSE placement.x END AS x,
            CASE WHEN ? = 1 THEN COALESCE(state.y, placement.y) ELSE placement.y END AS y,
            CASE WHEN ? = 1 THEN COALESCE(state.orientation, placement.orientation) ELSE placement.orientation END AS orientation,
            CASE WHEN ? = 1 THEN COALESCE(state.face_up, placement.face_up) ELSE placement.face_up END AS face_up,
            placement.tile_id, placement.deck_id, deck.name AS deck_name,
            CASE WHEN ? = 1 THEN
              COALESCE((SELECT SUM(item.quantity) FROM tile_deck_items AS item
                WHERE item.deck_id = placement.deck_id), 0) +
              COALESCE((SELECT SUM(returned.quantity) FROM gameplay_tile_deck_returns AS returned
                WHERE returned.deck_id = placement.deck_id AND returned.project_id = deck.project_id), 0) -
              COALESCE((SELECT SUM(taken.quantity) FROM gameplay_tile_deck_takes AS taken
                WHERE taken.deck_id = placement.deck_id AND taken.project_id = deck.project_id), 0)
            ELSE COALESCE((SELECT SUM(item.quantity) FROM tile_deck_items AS item
                WHERE item.deck_id = placement.deck_id), 0) END AS tile_count,
            COALESCE(tile.id, top_tile.id) AS visual_tile_id,
            COALESCE(tile.name, top_tile.name) AS tile_name,
            COALESCE(tile.shape, top_tile.shape) AS tile_shape,
            COALESCE(tile.width_inches, top_tile.width_inches) AS width_inches,
            COALESCE(tile.height_inches, top_tile.height_inches) AS height_inches,
            COALESCE(tile.color, top_tile.color) AS color,
            COALESCE(tile.surface_id, top_tile.surface_id) AS front_surface_id,
            COALESCE(tile.back_surface_id, top_tile.back_surface_id) AS back_surface_id
          FROM tile_board_placements AS placement
          LEFT JOIN gameplay_tile_placement_states AS state
            ON state.placement_id = placement.id AND state.project_id = ?
          LEFT JOIN game_tiles AS tile ON tile.id = placement.tile_id
          LEFT JOIN tile_decks AS deck ON deck.id = placement.deck_id
          LEFT JOIN game_tiles AS top_tile ON top_tile.id = (
            SELECT item.tile_id FROM tile_deck_items AS item
            WHERE item.deck_id = placement.deck_id AND item.quantity + CASE WHEN ? = 1 THEN
              COALESCE((SELECT SUM(returned.quantity) FROM gameplay_tile_deck_returns AS returned
                WHERE returned.project_id = deck.project_id AND returned.deck_id = item.deck_id
                  AND returned.tile_id = item.tile_id), 0) -
              COALESCE((SELECT SUM(taken.quantity) FROM gameplay_tile_deck_takes AS taken
                WHERE taken.project_id = deck.project_id AND taken.deck_id = item.deck_id
                  AND taken.tile_id = item.tile_id), 0)
              ELSE 0 END > 0
            ORDER BY item.tile_id LIMIT 1
          )
          WHERE placement.surface_id = ?
            AND (? = 0 OR COALESCE(state.is_returned, 0) = 0)
            AND (? = 1 OR COALESCE(state.is_added, 0) = 0)
          ORDER BY placement.id`,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0,
          surfaceId.replace(/-board$/, ''),
          surfaceId,
          gameplayMode ? 1 : 0,
          gameplayMode ? 1 : 0
        );
        if (!cancelled) {
          setBoardTilePlacements(rows.map((row) => ({
            id: row.id,
            x: row.x,
            y: row.y,
            orientation: row.orientation,
            faceUp: row.face_up !== 0,
            tileId: row.tile_id,
            deckId: row.deck_id,
            deckName: row.deck_name,
            tileCount: row.tile_count,
            tile: row.visual_tile_id !== null && row.tile_name && row.tile_shape &&
              row.width_inches && row.height_inches && row.front_surface_id
              ? {
                  id: row.visual_tile_id,
                  name: row.tile_name,
                  shape: row.tile_shape,
                  widthInches: row.width_inches,
                  heightInches: row.height_inches,
                  color: row.color ?? '#E9C46A',
                  frontSurfaceId: row.front_surface_id,
                  backSurfaceId: row.back_surface_id,
                }
              : null,
          })));
          setSelectedBoardTilePlacementId(null);
        }
      } catch (error) {
        console.error('Could not load board tiles:', error);
      }
    };
    void loadTilePlacements();
    return () => { cancelled = true; };
  }, [db, gameplayMode, gameplayRefreshRevision, surfaceId, tilePlacementRevision]);

  useEffect(() => {
    if (surfaceId === undefined) {
      setTokenSupplyPlacements([]);
      return;
    }
    let cancelled = false;
    const loadTokenSupplies = async () => {
      try {
        const rows = await db.getAllAsync<{
          id: number; x: number; y: number; orientation: number; quantity: number | null;
          token_id: number; name: string; shape: BoardTileVisual['shape'];
          width_inches: number; height_inches: number; color: string; token_surface_id: string;
          token_back_surface_id: string | null;
        }>(
          `SELECT supply.id, supply.x, supply.y, supply.orientation, supply.quantity,
            token.id AS token_id, token.name, token.shape, token.width_inches,
            token.height_inches, token.color, token.surface_id AS token_surface_id,
            token.back_surface_id AS token_back_surface_id
           FROM token_supply_placements AS supply
           JOIN game_tokens AS token ON token.id = supply.token_id
           WHERE supply.surface_id = ? ORDER BY supply.id`,
          surfaceId
        );
        if (!cancelled) {
          const [returnedRows, takenRows]: [
            { supply_id: number; quantity: number }[],
            { supply_id: number; quantity: number }[],
          ] = gameplayMode
            ? await Promise.all([
                db.getAllAsync<{ supply_id: number; quantity: number }>(
                  `SELECT returned.supply_id, SUM(returned.quantity) AS quantity
                   FROM gameplay_token_supply_returns AS returned
                   WHERE returned.project_id = ? GROUP BY returned.supply_id`,
                  surfaceId.replace(/-board$/, '')
                ),
                db.getAllAsync<{ supply_id: number; quantity: number }>(
                  `SELECT taken.supply_id, SUM(taken.quantity) AS quantity
                   FROM gameplay_token_supply_takes AS taken
                   WHERE taken.project_id = ? GROUP BY taken.supply_id`,
                  surfaceId.replace(/-board$/, '')
                ),
              ])
            : [[], []];
          // A newer refresh may have started while the stock queries were in
          // flight. Do not let an older response overwrite its placement list.
          if (cancelled) return;
          const returnedBySupply = new Map(returnedRows.map((row) => [row.supply_id, row.quantity]));
          const takenBySupply = new Map(takenRows.map((row) => [row.supply_id, row.quantity]));
          setTokenSupplyPlacements(rows.map((row) => ({
            id: row.id,
            x: row.x,
            y: row.y,
            orientation: row.orientation,
            quantity: row.quantity === null ? null : Math.max(
              0,
              row.quantity + (returnedBySupply.get(row.id) ?? 0) - (takenBySupply.get(row.id) ?? 0)
            ),
            token: {
              id: row.token_id,
              name: row.name,
              shape: row.shape,
              widthInches: row.width_inches,
              heightInches: row.height_inches,
              color: row.color,
              frontSurfaceId: row.token_surface_id,
              backSurfaceId: row.token_back_surface_id,
            },
          })));
        }
      } catch (error) {
        console.error('Could not load token supplies:', error);
      }
    };
    void loadTokenSupplies();
    return () => { cancelled = true; };
  }, [db, gameplayMode, gameplayRefreshRevision, surfaceId]);

  // Store each deck marker in the board's drawing units so it follows pan and
  // zoom exactly like strokes, symbols, and imported images.
  useEffect(() => {
    if (surfaceId === undefined) return;

    let cancelled = false;
    const loadDeckSpots = async () => {
      try {
        const rows = await db.getAllAsync<{
          id: number;
          x: number;
          y: number;
          orientation: number;
          spot_type: DeckSpotType;
          deck_id: number | null;
          face_up: number;
          top_card_name: string | null;
          front_surface_id: string | null;
          back_surface_id: string | null;
          width_inches: number | null;
          height_inches: number | null;
          card_count: number;
          top_face_up: number | null;
        }>(
          gameplayMode
            ? `SELECT spot.id, spot.x, spot.y, spot.orientation, spot.spot_type,
                spot.deck_id, spot.face_up,
                card.name AS top_card_name, card.surface_id AS front_surface_id,
                card.back_surface_id, card.width_inches, card.height_inches,
                (SELECT COUNT(*) FROM play_card_instances AS instance
                  WHERE instance.deck_spot_id = spot.id AND instance.player_id IS NULL) AS card_count,
                (SELECT instance.face_up FROM play_card_instances AS instance
                  WHERE instance.deck_spot_id = spot.id AND instance.player_id IS NULL
                  ORDER BY instance.pile_order, instance.id LIMIT 1) AS top_face_up
              FROM deck_spots AS spot
              LEFT JOIN play_card_instances AS top_instance ON top_instance.id = (
                SELECT instance.id FROM play_card_instances AS instance
                WHERE instance.deck_spot_id = spot.id AND instance.player_id IS NULL
                ORDER BY instance.pile_order, instance.id LIMIT 1
              )
              LEFT JOIN cards AS card ON card.id = top_instance.card_id
              WHERE spot.surface_id = ? ORDER BY spot.id ASC`
            : `SELECT spot.id, spot.x, spot.y, spot.orientation, spot.spot_type,
                spot.deck_id, spot.face_up,
                card.name AS top_card_name, card.surface_id AS front_surface_id,
                card.back_surface_id, card.width_inches, card.height_inches,
                COALESCE((SELECT SUM(item.quantity) FROM card_deck_items AS item
                  WHERE item.deck_id = spot.deck_id), 0) AS card_count,
                spot.face_up AS top_face_up
              FROM deck_spots AS spot
              LEFT JOIN cards AS card ON card.id = (
                SELECT item.card_id FROM card_deck_items AS item
                WHERE item.deck_id = spot.deck_id AND item.quantity > 0
                ORDER BY item.card_id ASC LIMIT 1
              )
              WHERE spot.surface_id = ? ORDER BY spot.id ASC`,
          surfaceId
        );

        if (!cancelled) {
          setDeckSpots(rows.map((row) => ({
            id: row.id,
            x: row.x,
            y: row.y,
            orientation: row.orientation,
            spotType: row.spot_type,
            deckId: row.deck_id,
            faceUp: row.top_face_up === 1,
            cardCount: row.card_count,
            topCard: row.top_card_name && row.front_surface_id && row.width_inches && row.height_inches
              ? {
                  name: row.top_card_name,
                  frontSurfaceId: row.front_surface_id,
                  backSurfaceId: row.back_surface_id,
                  widthInches: row.width_inches,
                  heightInches: row.height_inches,
                }
              : null,
          })));
          setSelectedDeckSpotId(null);
        }
      } catch (error) {
        console.error('Could not load deck spots:', error);
      }
    };

    void loadDeckSpots();
    return () => {
      cancelled = true;
    };
  }, [db, gameplayMode, gameplayPileRevision, surfaceId]);

  // Snap anchors are saved in map drawing units so they stay lined up with all
  // other board content as the user pans or zooms the canvas.
  useEffect(() => {
    if (surfaceId === undefined) {
      setTileSnapPoints([]);
      setSelectedTileSnapPointId(null);
      return;
    }
    let cancelled = false;
    const loadSnapPoints = async () => {
      try {
        const rows = await db.getAllAsync<TileSnapPoint>(
          'SELECT id, x, y, orientation FROM tile_snap_points WHERE surface_id = ? ORDER BY id',
          surfaceId
        );
        if (!cancelled) {
          setTileSnapPoints(rows);
          setSelectedTileSnapPointId(null);
        }
      } catch (error) {
        console.error('Could not load tile snap points:', error);
      }
    };
    void loadSnapPoints();
    return () => { cancelled = true; };
  }, [db, surfaceId]);

  // Board background belongs to its project surface. Load it separately from
  // strokes so changing projects restores that project's own map color.
  useEffect(() => {
    if (surfaceId === undefined) {
      setSurfaceBackgroundImage(null);
      return;
    }

    let cancelled = false;
    const loadBackgroundColor = async () => {
      try {
        const row = await db.getFirstAsync<{
          background_color: string | null;
          background_image_data: string | null;
          background_image_mime_type: string | null;
        }>(
          `SELECT background_color, background_image_data, background_image_mime_type
          FROM drawing_surfaces WHERE id = ?`,
          surfaceId
        );
        if (!cancelled) {
          setBackgroundColor(row?.background_color ?? defaultBackgroundColor);
          setSurfaceBackgroundImage(
            row?.background_image_data && row.background_image_mime_type
              ? {
                  base64Data: row.background_image_data,
                  mimeType: row.background_image_mime_type,
                }
              : null
          );
        }
      } catch (error) {
        console.error('Could not load board background color:', error);
      }
    };

    void loadBackgroundColor();
    return () => {
      cancelled = true;
    };
  }, [db, defaultBackgroundColor, surfaceId]);

  useEffect(() => {
    if (placementSymbolId === undefined) {
      setPlacementSymbolData(null);
      return;
    }

    let cancelled = false;
    const loadPlacementSymbol = async () => {
      try {
        const rows = await db.getAllAsync<SavedStrokeRow>(
          `SELECT points_json, width, color, is_eraser
          FROM symbol_strokes
          WHERE symbol_id = ?
          ORDER BY order_index ASC`,
          placementSymbolId
        );

        if (!cancelled) {
          setPlacementSymbolData({
            id: placementSymbolId,
            strokes: rows.map((row) => ({
              points: JSON.parse(row.points_json) as Point[],
              width: row.width,
              color: row.color,
              eraser: row.is_eraser === 1,
            })),
          });
        }
      } catch (error) {
        console.error('Could not load symbol for placement:', error);
      }
    };

    void loadPlacementSymbol();
    return () => {
      cancelled = true;
    };
  }, [db, placementSymbolId]);

  // Save a completed or redone stroke using the same order-index rule. The database
  // operation is queued with undo/redo operations to keep persistent history aligned
  // with what is shown on the canvas.
  const queueStrokeSave = useCallback((stroke: Stroke) => {
    const saveStroke = async () => {
      if (symbolId !== undefined) {
        await db.runAsync(
          `INSERT INTO symbol_strokes
            (symbol_id, points_json, width, color, is_eraser, order_index)
          VALUES (
            ?, ?, ?, ?, ?,
            COALESCE(
              (SELECT MAX(order_index) + 1
              FROM symbol_strokes
              WHERE symbol_id = ?),
              0
            )
          )`,
          symbolId,
          JSON.stringify(stroke.points),
          stroke.width,
          stroke.color,
          stroke.eraser ? 1 : 0,
          symbolId
        );
      } else if (surfaceId) {
        await db.runAsync(
          `INSERT INTO strokes
            (surface_id, points_json, width, color, is_eraser, order_index, group_id)
          VALUES (
            ?, ?, ?, ?, ?,
            COALESCE(
              (SELECT MAX(order_index) + 1 FROM strokes WHERE surface_id = ?),
              0
            ), ?
          )`,
          surfaceId,
          JSON.stringify(stroke.points),
          stroke.width,
          stroke.color,
          stroke.eraser ? 1 : 0,
          surfaceId,
          stroke.groupId ?? null
        );
      }
    };

    enqueueDatabaseAction(
      saveStroke,
      symbolId !== undefined
        ? 'Could not save symbol stroke:'
        : 'Could not save board stroke:'
    );
  }, [db, enqueueDatabaseAction, surfaceId, symbolId]);

  // Moving or resizing changes every line in a stamp together. Rewrite those rows
  // in one transaction so the new geometry stays together after the app restarts.
  const queueSymbolTransformSave = useCallback((session: SymbolTransformSession) => {
    if (surfaceId === undefined) return;

    enqueueDatabaseAction(async () => {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          'DELETE FROM strokes WHERE surface_id = ? AND group_id = ?',
          surfaceId,
          session.groupId
        );

        for (const stroke of session.updatedStrokes) {
          await db.runAsync(
            `INSERT INTO strokes
              (surface_id, points_json, width, color, is_eraser, order_index, group_id)
            VALUES (
              ?, ?, ?, ?, ?,
              COALESCE(
                (SELECT MAX(order_index) + 1 FROM strokes WHERE surface_id = ?),
                0
              ), ?
            )`,
            surfaceId,
            JSON.stringify(stroke.points),
            stroke.width,
            stroke.color,
            stroke.eraser ? 1 : 0,
            surfaceId,
            session.groupId
          );
        }
      });
    }, 'Could not save symbol position or size:');
  }, [db, enqueueDatabaseAction, surfaceId]);

  const queueImageTransformSave = useCallback((image: PlacedImage) => {
    if (surfaceId === undefined) return;

    enqueueDatabaseAction(async () => {
      await db.runAsync(
        `UPDATE surface_images
        SET center_x = ?, center_y = ?, width = ?, height = ?
        WHERE id = ? AND surface_id = ?`,
        image.center.x,
        image.center.y,
        image.width,
        image.height,
        image.id,
        surfaceId
      );
    }, 'Could not save image position or size:');
  }, [db, enqueueDatabaseAction, surfaceId]);

  const finishImageDrag = useCallback(() => {
    const session = imageDragSessionRef.current;
    imageDragSessionRef.current = null;
    if (session?.changed) {
      queueImageTransformSave(session.updatedImage);
    }
  }, [queueImageTransformSave]);

  const finishImagePinch = useCallback(() => {
    const session = imagePinchSessionRef.current;
    imagePinchSessionRef.current = null;
    if (session?.changed) {
      queueImageTransformSave(session.updatedImage);
    }
  }, [queueImageTransformSave]);

  const queueDeckSpotSave = useCallback((spot: DeckSpot) => {
    if (surfaceId === undefined) return;
    enqueueDatabaseAction(async () => {
      await db.runAsync(
        `UPDATE deck_spots
        SET x = ?, y = ?, orientation = ?, deck_id = ?, face_up = ?
        WHERE id = ? AND surface_id = ?`,
        spot.x,
        spot.y,
        spot.orientation,
        spot.deckId,
        spot.faceUp ? 1 : 0,
        spot.id,
        surfaceId
      );
    }, 'Could not save deck spot:');
  }, [db, enqueueDatabaseAction, surfaceId]);

  const finishDeckSpotDrag = useCallback(() => {
    const session = deckSpotDragSessionRef.current;
    deckSpotDragSessionRef.current = null;
    if (session?.changed) {
      queueDeckSpotSave(session.updatedSpot);
    }
  }, [queueDeckSpotSave]);

  const removeSelectedDeckSpot = useCallback(() => {
    if (selectedDeckSpotId === null) return;
    const spotId = selectedDeckSpotId;
    setDeckSpots((current) => current.filter((spot) => spot.id !== spotId));
    setSelectedDeckSpotId(null);
    if (surfaceId !== undefined) {
      enqueueDatabaseAction(async () => {
        await db.runAsync(
          'DELETE FROM deck_spots WHERE id = ? AND surface_id = ?',
          spotId,
          surfaceId
        );
      }, 'Could not remove deck spot:');
    }
  }, [db, enqueueDatabaseAction, selectedDeckSpotId, surfaceId]);

  const rotateSelectedDeckSpot = useCallback(() => {
    if (selectedDeckSpotId === null) return;
    const updatedSpot = deckSpots.find((spot) => spot.id === selectedDeckSpotId);
    if (!updatedSpot) return;
    const rotatedSpot = {
      ...updatedSpot,
      orientation: (updatedSpot.orientation + 15) % 360,
    };
    setDeckSpots((current) => current.map((spot) =>
      spot.id === selectedDeckSpotId ? rotatedSpot : spot
    ));
    queueDeckSpotSave(rotatedSpot);
  }, [deckSpots, queueDeckSpotSave, selectedDeckSpotId]);

  const queueSnapPointSave = useCallback((snapPoint: TileSnapPoint) => {
    if (surfaceId === undefined) return;
    enqueueDatabaseAction(async () => {
      await db.runAsync(
        'UPDATE tile_snap_points SET x = ?, y = ?, orientation = ? WHERE id = ? AND surface_id = ?',
        snapPoint.x, snapPoint.y, snapPoint.orientation, snapPoint.id, surfaceId
      );
    }, 'Could not save tile snap point:');
  }, [db, enqueueDatabaseAction, surfaceId]);

  const finishSnapPointDrag = useCallback(() => {
    const session = tileSnapDragSessionRef.current;
    tileSnapDragSessionRef.current = null;
    if (session?.changed) queueSnapPointSave(session.updatedPoint);
  }, [queueSnapPointSave]);

  const placeTileSnapPoint = useCallback((point: Point) => {
    if (surfaceId === undefined) return;
    void db.runAsync(
      'INSERT INTO tile_snap_points (surface_id, x, y, orientation) VALUES (?, ?, ?, 0)',
      surfaceId, point.x, point.y
    ).then((result) => {
      const newPoint = { id: result.lastInsertRowId, ...point, orientation: 0 };
      setTileSnapPoints((current) => [...current, newPoint]);
      setSelectedTileSnapPointId(newPoint.id);
      onTileSnapPointPlaced?.();
    }).catch((error) => {
      console.error('Could not place tile snap point:', error);
      Alert.alert('Could not place snap point', 'Please try again.');
    });
  }, [db, onTileSnapPointPlaced, surfaceId]);

  const removeSelectedSnapPoint = useCallback(() => {
    if (selectedTileSnapPointId === null) return;
    const id = selectedTileSnapPointId;
    setTileSnapPoints((current) => current.filter((item) => item.id !== id));
    setSelectedTileSnapPointId(null);
    if (surfaceId !== undefined) {
      enqueueDatabaseAction(async () => {
        await db.runAsync('DELETE FROM tile_snap_points WHERE id = ? AND surface_id = ?', id, surfaceId);
      }, 'Could not remove tile snap point:');
    }
  }, [db, enqueueDatabaseAction, selectedTileSnapPointId, surfaceId]);

  const rotateSelectedSnapPoint = useCallback(() => {
    const snapPoint = tileSnapPoints.find((item) => item.id === selectedTileSnapPointId);
    if (!snapPoint) return;
    const updated = { ...snapPoint, orientation: (snapPoint.orientation + 15) % 360 };
    setTileSnapPoints((current) => current.map((item) => item.id === updated.id ? updated : item));
    queueSnapPointSave(updated);
  }, [queueSnapPointSave, selectedTileSnapPointId, tileSnapPoints]);

  const placeBoardTileAtPoint = useCallback((
    point: Point,
    tile: BoardTileVisual | null,
    deck: BoardTileDeckPlacement | null
  ) => {
    if (surfaceId === undefined || (!tile && !deck)) return;
    const snapThreshold = Math.max(24, Math.min(getBoardTileSize(tile).width, getBoardTileSize(tile).height) * 0.45);
    const snapPoint = findNearestTileSnapPoint(tileSnapPoints, point, snapThreshold);
    const placementPoint = snapPoint ? { x: snapPoint.x, y: snapPoint.y } : point;
    const orientation = snapPoint?.orientation ?? 0;
    const tileId = deck ? null : tile?.id ?? null;
    const deckId = deck?.id ?? null;
    void db.runAsync(
      `INSERT INTO tile_board_placements (surface_id, tile_id, deck_id, x, y, orientation)
       VALUES (?, ?, ?, ?, ?, ?)`,
      surfaceId, tileId, deckId, placementPoint.x, placementPoint.y, orientation
    ).then((result) => {
      const newPlacement: BoardTilePlacement = {
        id: result.lastInsertRowId,
        x: placementPoint.x,
        y: placementPoint.y,
        orientation,
        faceUp: true,
        tileId,
        deckId,
        deckName: deck?.name ?? null,
        tileCount: deck?.tileCount ?? 0,
        tile: deck?.topTile ?? tile,
      };
      setBoardTilePlacements((current) => [...current, newPlacement]);
      if (deck) onTileDeckPlaced?.();
      else onTilePlaced?.();
    }).catch((error) => {
      console.error('Could not place tile on the board:', error);
      Alert.alert('Could not place tile', 'Please try again.');
    });
  }, [db, onTileDeckPlaced, onTilePlaced, surfaceId, tileSnapPoints]);

  const placeTokenSupply = useCallback((point: Point, supply: BoardTokenSupply) => {
    if (surfaceId === undefined) return;
    void db.runAsync(
      `INSERT INTO token_supply_placements (surface_id, token_id, x, y, orientation, quantity)
       VALUES (?, ?, ?, ?, 0, ?)`,
      surfaceId, supply.token.id, point.x, point.y, supply.quantity
    ).then((result) => {
      setTokenSupplyPlacements((current) => [...current, {
        id: result.lastInsertRowId,
        x: point.x,
        y: point.y,
        orientation: 0,
        quantity: supply.quantity,
        token: supply.token,
      }]);
    }).catch((error) => {
      console.error('Could not place token supply:', error);
      Alert.alert('Could not place token supply', 'Please try again.');
    });
  }, [db, surfaceId]);

  const placeBoardToken = useCallback((point: Point, token: BoardTileVisual) => {
    if (surfaceId === undefined) return;
    void db.runAsync(
      `INSERT INTO token_board_placements (surface_id, token_id, x, y, orientation, face_up)
       VALUES (?, ?, ?, ?, 0, 1)`,
      surfaceId, token.id, point.x, point.y
    ).then((result) => {
      setBoardTokenPlacements((current) => [...current, {
        id: result.lastInsertRowId,
        x: point.x,
        y: point.y,
        orientation: 0,
        faceUp: true,
        token,
      }]);
    }).catch((error) => {
      console.error('Could not place token:', error);
      Alert.alert('Could not place token', 'Please try again.');
    });
  }, [db, surfaceId]);

  // Play mode withdraws exactly one token from the chosen supply and places it
  // where the player taps. The added marker and its stock change are saved as
  // gameplay state so Start Fresh can still restore the original board.
  const takeGameplayTokenFromSupply = useCallback(async (point: Point, supplyId: number) => {
    if (surfaceId === undefined) return;
    const supply = tokenSupplyPlacements.find((item) => item.id === supplyId);
    if (!supply) return;
    const projectId = surfaceId.replace(/-board$/, '');
    try {
      const addedTokenResult: { value: BoardTokenPlacement | null } = { value: null };
      await db.withTransactionAsync(async () => {
        const stock = await db.getFirstAsync<{
          quantity: number | null; returned: number; taken: number;
        }>(
          `SELECT supply.quantity,
            COALESCE((SELECT SUM(returned.quantity) FROM gameplay_token_supply_returns AS returned
              WHERE returned.project_id = ? AND returned.supply_id = supply.id), 0) AS returned,
            COALESCE((SELECT SUM(taken.quantity) FROM gameplay_token_supply_takes AS taken
              WHERE taken.project_id = ? AND taken.supply_id = supply.id), 0) AS taken
           FROM token_supply_placements AS supply WHERE supply.id = ? AND supply.surface_id = ?`,
          projectId, projectId, supplyId, surfaceId
        );
        if (!stock || (stock.quantity !== null && stock.quantity + stock.returned - stock.taken <= 0)) {
          throw new Error('This token supply is empty.');
        }
        const result = await db.runAsync(
          `INSERT INTO token_board_placements (surface_id, token_id, x, y, orientation, face_up)
           VALUES (?, ?, ?, ?, 0, 1)`,
          surfaceId, supply.token.id, point.x, point.y
        );
        const id = result.lastInsertRowId;
        await db.runAsync(
          `INSERT INTO gameplay_token_placement_states
            (project_id, placement_id, x, y, orientation, face_up, is_added)
           VALUES (?, ?, ?, ?, 0, 1, 1)`,
          projectId, id, point.x, point.y
        );
        if (stock.quantity !== null) {
          await db.runAsync(
            `INSERT INTO gameplay_token_supply_takes (project_id, supply_id, quantity, updated_at)
             VALUES (?, ?, 1, ?) ON CONFLICT(project_id, supply_id) DO UPDATE SET
             quantity = gameplay_token_supply_takes.quantity + 1, updated_at = excluded.updated_at`,
            projectId, supplyId, Date.now()
          );
        }
        addedTokenResult.value = {
          id, x: point.x, y: point.y, orientation: 0, faceUp: true, token: supply.token,
        };
      });
      const addedToken = addedTokenResult.value;
      if (addedToken) {
        setBoardTokenPlacements((current) => [...current, addedToken]);
        if (supply.quantity !== null) {
          setTokenSupplyPlacements((current) => current.map((item) => item.id === supplyId
            ? { ...item, quantity: Math.max(0, (item.quantity ?? 0) - 1) } : item));
        }
        setSelectedBoardTokenId(addedToken.id);
        setSelectedBoardTilePlacementId(null);
        setGameplayTokenSupplyChoice(null);
      }
    } catch (error) {
      console.error('Could not take token from supply:', error);
      Alert.alert('Could not take token', error instanceof Error ? error.message : 'Please try again.');
    }
  }, [db, surfaceId, tokenSupplyPlacements]);

  // Tile decks use the recipe plus live returns minus prior draws to determine
  // both the visible next tile and how many tiles remain.
  const takeGameplayTileFromDeck = useCallback(async (point: Point, deckId: number) => {
    if (surfaceId === undefined) return;
    const projectId = surfaceId.replace(/-board$/, '');
    const sourcePile = boardTilePlacements.find((item) => item.deckId === deckId);
    const sourceSize = getBoardTileSize(sourcePile?.tile ?? null);
    const snapThreshold = Math.max(24, Math.min(sourceSize.width, sourceSize.height) * 0.45);
    const snapPoint = findNearestTileSnapPoint(tileSnapPoints, point, snapThreshold);
    const placeAt = snapPoint ? { x: snapPoint.x, y: snapPoint.y } : point;
    const orientation = snapPoint?.orientation ?? 0;
    const tileQuery = `SELECT tile.id, tile.name, tile.shape, tile.width_inches, tile.height_inches,
        tile.color, tile.surface_id AS front_surface_id, tile.back_surface_id
      FROM tile_deck_items AS item JOIN game_tiles AS tile ON tile.id = item.tile_id
      WHERE item.deck_id = ? AND item.quantity +
        COALESCE((SELECT SUM(returned.quantity) FROM gameplay_tile_deck_returns AS returned
          WHERE returned.project_id = ? AND returned.deck_id = item.deck_id AND returned.tile_id = item.tile_id), 0) -
        COALESCE((SELECT SUM(taken.quantity) FROM gameplay_tile_deck_takes AS taken
          WHERE taken.project_id = ? AND taken.deck_id = item.deck_id AND taken.tile_id = item.tile_id), 0) > 0
      ORDER BY item.tile_id LIMIT 1`;
    try {
      const tileResult: { value: BoardTileVisual | null } = { value: null };
      const placementResult: { value: number | null } = { value: null };
      const remainingCountResult = { value: 0 };
      const nextTileResult: { value: BoardTileVisual | null } = { value: null };
      await db.withTransactionAsync(async () => {
        const tileRow = await db.getFirstAsync<{
          id: number; name: string; shape: BoardTileVisual['shape']; width_inches: number;
          height_inches: number; color: string; front_surface_id: string; back_surface_id: string | null;
        }>(tileQuery, deckId, projectId, projectId);
        if (!tileRow) throw new Error('This tile deck is empty.');
        tileResult.value = {
          id: tileRow.id, name: tileRow.name, shape: tileRow.shape,
          widthInches: tileRow.width_inches, heightInches: tileRow.height_inches,
          color: tileRow.color, frontSurfaceId: tileRow.front_surface_id,
          backSurfaceId: tileRow.back_surface_id,
        };
        const result = await db.runAsync(
          `INSERT INTO tile_board_placements (surface_id, tile_id, deck_id, x, y, orientation, face_up)
           VALUES (?, ?, NULL, ?, ?, ?, 1)`,
          surfaceId, tileRow.id, placeAt.x, placeAt.y, orientation
        );
        placementResult.value = result.lastInsertRowId;
        await db.runAsync(
          `INSERT INTO gameplay_tile_placement_states
            (project_id, placement_id, x, y, orientation, face_up, is_added)
           VALUES (?, ?, ?, ?, ?, 1, 1)`,
          projectId, placementResult.value, placeAt.x, placeAt.y, orientation
        );
        await db.runAsync(
          `INSERT INTO gameplay_tile_deck_takes (project_id, deck_id, tile_id, quantity, updated_at)
           VALUES (?, ?, ?, 1, ?) ON CONFLICT(project_id, deck_id, tile_id) DO UPDATE SET
           quantity = gameplay_tile_deck_takes.quantity + 1, updated_at = excluded.updated_at`,
          projectId, deckId, tileRow.id, Date.now()
        );
        const countRow = await db.getFirstAsync<{ quantity: number }>(
          `SELECT COALESCE((SELECT SUM(item.quantity) FROM tile_deck_items AS item WHERE item.deck_id = ?), 0) +
            COALESCE((SELECT SUM(returned.quantity) FROM gameplay_tile_deck_returns AS returned
              WHERE returned.project_id = ? AND returned.deck_id = ?), 0) -
            COALESCE((SELECT SUM(taken.quantity) FROM gameplay_tile_deck_takes AS taken
              WHERE taken.project_id = ? AND taken.deck_id = ?), 0) AS quantity`,
          deckId, projectId, deckId, projectId, deckId
        );
        remainingCountResult.value = Math.max(0, countRow?.quantity ?? 0);
        const nextRow = await db.getFirstAsync<{
          id: number; name: string; shape: BoardTileVisual['shape']; width_inches: number;
          height_inches: number; color: string; front_surface_id: string; back_surface_id: string | null;
        }>(tileQuery, deckId, projectId, projectId);
        nextTileResult.value = nextRow ? {
          id: nextRow.id, name: nextRow.name, shape: nextRow.shape,
          widthInches: nextRow.width_inches, heightInches: nextRow.height_inches,
          color: nextRow.color, frontSurfaceId: nextRow.front_surface_id,
          backSurfaceId: nextRow.back_surface_id,
        } : null;
      });
      const addedTile = tileResult.value;
      const placementId = placementResult.value;
      const remainingCount = remainingCountResult.value;
      const nextTile = nextTileResult.value;
      if (addedTile && placementId !== null) {
        setBoardTilePlacements((current) => [
          ...current.map((item) => item.deckId === deckId
            ? { ...item, tileCount: remainingCount, tile: nextTile } : item),
          {
            id: placementId!, x: placeAt.x, y: placeAt.y, orientation, faceUp: true,
            tileId: addedTile!.id, deckId: null, deckName: null, tileCount: 0, tile: addedTile,
          },
        ]);
        setSelectedBoardTilePlacementId(placementId);
        setSelectedBoardTokenId(null);
        setGameplayTileDeckChoice(null);
      }
    } catch (error) {
      console.error('Could not take tile from deck:', error);
      Alert.alert('Could not take tile', error instanceof Error ? error.message : 'Please try again.');
    }
  }, [boardTilePlacements, db, surfaceId, tileSnapPoints]);

  const placeBoardDie = useCallback((point: Point, die: BoardDieVisual) => {
    if (surfaceId === undefined) return;
    void db.runAsync(
      'INSERT INTO die_board_placements (surface_id, die_id, face_number, x, y, orientation) VALUES (?, ?, 1, ?, ?, 0)',
      surfaceId, die.id, point.x, point.y
    ).then((result) => {
      setBoardDiePlacements((current) => [...current, {
        id: result.lastInsertRowId,
        x: point.x,
        y: point.y,
        orientation: 0,
        faceNumber: 1,
        die,
      }]);
    }).catch((error) => {
      console.error('Could not place die:', error);
      Alert.alert('Could not place die', 'Please try again.');
    });
  }, [db, surfaceId]);

  const queueTokenMarkerSave = useCallback((session: TokenMarkerDragSession) => {
    if (surfaceId === undefined) return;
    enqueueDatabaseAction(async () => {
      if (session.kind === 'supply') {
        await db.runAsync(
          'UPDATE token_supply_placements SET x = ?, y = ? WHERE id = ? AND surface_id = ?',
          session.updatedX, session.updatedY, session.id, surfaceId
        );
      } else if (session.kind === 'token') {
        if (gameplayMode) {
          const token = boardTokenPlacements.find((item) => item.id === session.id);
          if (!token) return;
          await db.runAsync(
            `INSERT INTO gameplay_token_placement_states
              (project_id, placement_id, x, y, orientation, face_up)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, placement_id) DO UPDATE SET
             x = excluded.x, y = excluded.y, orientation = excluded.orientation,
             face_up = excluded.face_up, is_returned = 0`,
            surfaceId.replace(/-board$/, ''), session.id, session.updatedX, session.updatedY,
            token.orientation, token.faceUp ? 1 : 0
          );
        } else {
          await db.runAsync(
            'UPDATE token_board_placements SET x = ?, y = ? WHERE id = ? AND surface_id = ?',
            session.updatedX, session.updatedY, session.id, surfaceId
          );
        }
      } else {
        await db.runAsync(
          'UPDATE die_board_placements SET x = ?, y = ? WHERE id = ? AND surface_id = ?',
          session.updatedX, session.updatedY, session.id, surfaceId
        );
      }
    }, 'Could not save token position:');
  }, [boardTokenPlacements, db, enqueueDatabaseAction, gameplayMode, surfaceId]);

  const queueBoardTokenPlacementSave = useCallback((placement: BoardTokenPlacement) => {
    if (surfaceId === undefined) return;
    enqueueDatabaseAction(async () => {
      if (gameplayMode) {
        await db.runAsync(
          `INSERT INTO gameplay_token_placement_states
            (project_id, placement_id, x, y, orientation, face_up)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, placement_id) DO UPDATE SET
           x = excluded.x, y = excluded.y, orientation = excluded.orientation,
           face_up = excluded.face_up, is_returned = 0`,
          surfaceId.replace(/-board$/, ''), placement.id, placement.x, placement.y,
          placement.orientation, placement.faceUp ? 1 : 0
        );
      } else {
        await db.runAsync(
          'UPDATE token_board_placements SET x = ?, y = ?, orientation = ?, face_up = ? WHERE id = ? AND surface_id = ?',
          placement.x, placement.y, placement.orientation, placement.faceUp ? 1 : 0, placement.id, surfaceId
        );
      }
    }, 'Could not save token changes:');
  }, [db, enqueueDatabaseAction, gameplayMode, surfaceId]);

  const finishTokenMarkerDrag = useCallback(() => {
    const session = tokenMarkerDragSessionRef.current;
    tokenMarkerDragSessionRef.current = null;
    if (!session) return;
    if (tokenMarkerRenderFrameRef.current !== null) {
      cancelAnimationFrame(tokenMarkerRenderFrameRef.current);
      tokenMarkerRenderFrameRef.current = null;
    }
    if (session.kind === 'supply') {
      setTokenSupplyPlacements((current) => current.map((item) => item.id === session.id
        ? { ...item, x: session.updatedX, y: session.updatedY } : item));
    } else if (session.kind === 'token') {
      setBoardTokenPlacements((current) => current.map((item) => item.id === session.id
        ? { ...item, x: session.updatedX, y: session.updatedY } : item));
      if (gameplayMode) {
        setActiveGameplayDragKey(null);
        activePieceOffsetX.value = 0;
        activePieceOffsetY.value = 0;
      }
    } else {
      setBoardDiePlacements((current) => current.map((item) => item.id === session.id
        ? { ...item, x: session.updatedX, y: session.updatedY } : item));
    }
    if (session.changed) queueTokenMarkerSave(session);
  }, [activePieceOffsetX, activePieceOffsetY, gameplayMode, queueTokenMarkerSave]);

  const removeSelectedTokenMarker = useCallback(() => {
    const supplyId = selectedTokenSupplyId;
    const tokenId = selectedBoardTokenId;
    const dieId = selectedBoardDieId;
    if (surfaceId === undefined) return;
    if (supplyId !== null) {
      setTokenSupplyPlacements((current) => current.filter((item) => item.id !== supplyId));
      setSelectedTokenSupplyId(null);
      enqueueDatabaseAction(async () => {
        await db.runAsync('DELETE FROM token_supply_placements WHERE id = ? AND surface_id = ?', supplyId, surfaceId);
      }, 'Could not remove token supply:');
    } else if (tokenId !== null) {
      setBoardTokenPlacements((current) => current.filter((item) => item.id !== tokenId));
      setSelectedBoardTokenId(null);
      enqueueDatabaseAction(async () => {
        await db.runAsync('DELETE FROM token_board_placements WHERE id = ? AND surface_id = ?', tokenId, surfaceId);
      }, 'Could not remove token:');
    } else if (dieId !== null) {
      setBoardDiePlacements((current) => current.filter((item) => item.id !== dieId));
      setSelectedBoardDieId(null);
      enqueueDatabaseAction(async () => {
        await db.runAsync('DELETE FROM die_board_placements WHERE id = ? AND surface_id = ?', dieId, surfaceId);
      }, 'Could not remove die:');
    }
  }, [db, enqueueDatabaseAction, selectedBoardDieId, selectedBoardTokenId, selectedTokenSupplyId, surfaceId]);

  const flipSelectedBoardToken = useCallback(() => {
    const placement = boardTokenPlacements.find((item) => item.id === selectedBoardTokenId);
    if (!placement?.token.backSurfaceId || surfaceId === undefined) return;
    const updated = { ...placement, faceUp: !placement.faceUp };
    setBoardTokenPlacements((current) => current.map((item) => item.id === updated.id ? updated : item));
    queueBoardTokenPlacementSave(updated);
  }, [boardTokenPlacements, queueBoardTokenPlacementSave, selectedBoardTokenId, surfaceId]);

  // Returning a token changes this gameplay's supply count without changing
  // the saved starting quantity. When there are several matching supplies,
  // return it to the closest one so the action feels predictable on the map.
  const returnSelectedTokenToSupply = useCallback(() => {
    const token = boardTokenPlacements.find((item) => item.id === selectedBoardTokenId);
    if (!token || surfaceId === undefined) return;
    const matchingSupplies = tokenSupplyPlacements
      .filter((supply) => supply.token.id === token.token.id)
      .sort((a, b) => Math.hypot(a.x - token.x, a.y - token.y) - Math.hypot(b.x - token.x, b.y - token.y));
    const supply = matchingSupplies[0];
    if (!supply) {
      Alert.alert('No matching supply', `There is no ${token.token.name} supply on this board.`);
      return;
    }
    const projectId = surfaceId.replace(/-board$/, '');
    setBoardTokenPlacements((current) => current.filter((item) => item.id !== token.id));
    setSelectedBoardTokenId(null);
    if (supply.quantity !== null) {
      setTokenSupplyPlacements((current) => current.map((item) => item.id === supply.id
        ? { ...item, quantity: (item.quantity ?? 0) + 1 } : item));
    }
    enqueueDatabaseAction(async () => {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT INTO gameplay_token_supply_returns (project_id, supply_id, quantity, updated_at)
           VALUES (?, ?, 1, ?) ON CONFLICT(project_id, supply_id) DO UPDATE SET
           quantity = gameplay_token_supply_returns.quantity + 1, updated_at = excluded.updated_at`,
          projectId, supply.id, Date.now()
        );
        await db.runAsync(
          `INSERT INTO gameplay_token_placement_states
            (project_id, placement_id, x, y, orientation, face_up, is_returned, returned_supply_id)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(project_id, placement_id) DO UPDATE SET
           x = excluded.x, y = excluded.y, orientation = excluded.orientation,
           face_up = excluded.face_up, is_returned = 1, returned_supply_id = excluded.returned_supply_id`,
          projectId, token.id, token.x, token.y, token.orientation, token.faceUp ? 1 : 0, supply.id
        );
      });
    }, 'Could not return token to supply:');
  }, [boardTokenPlacements, db, enqueueDatabaseAction, selectedBoardTokenId, surfaceId, tokenSupplyPlacements]);

  const rotateSelectedTokenMarker = useCallback(() => {
    if (surfaceId === undefined) return;
    if (selectedBoardDieId !== null) {
      const placement = boardDiePlacements.find((item) => item.id === selectedBoardDieId);
      if (!placement) return;
      const rotated = { ...placement, orientation: (placement.orientation + 15) % 360 };
      setBoardDiePlacements((current) => current.map((item) => item.id === rotated.id ? rotated : item));
      enqueueDatabaseAction(async () => {
        await db.runAsync('UPDATE die_board_placements SET orientation = ? WHERE id = ? AND surface_id = ?', rotated.orientation, rotated.id, surfaceId);
      }, 'Could not rotate die:');
      return;
    }
    if (selectedBoardTokenId !== null) {
      const placement = boardTokenPlacements.find((item) => item.id === selectedBoardTokenId);
      if (!placement) return;
      const rotated = { ...placement, orientation: (placement.orientation + 15) % 360 };
      setBoardTokenPlacements((current) => current.map((item) => item.id === rotated.id ? rotated : item));
      queueBoardTokenPlacementSave(rotated);
      return;
    }
    if (selectedTokenSupplyId !== null) {
      const placement = tokenSupplyPlacements.find((item) => item.id === selectedTokenSupplyId);
      if (!placement) return;
      const rotated = { ...placement, orientation: (placement.orientation + 15) % 360 };
      setTokenSupplyPlacements((current) => current.map((item) => item.id === rotated.id ? rotated : item));
      enqueueDatabaseAction(async () => {
        await db.runAsync('UPDATE token_supply_placements SET orientation = ? WHERE id = ? AND surface_id = ?', rotated.orientation, rotated.id, surfaceId);
      }, 'Could not rotate token supply:');
    }
  }, [boardDiePlacements, boardTokenPlacements, db, enqueueDatabaseAction, queueBoardTokenPlacementSave, selectedBoardDieId, selectedBoardTokenId, selectedTokenSupplyId, surfaceId, tokenSupplyPlacements]);

  const changeSelectedDieFace = useCallback((direction: number) => {
    const placement = boardDiePlacements.find((item) => item.id === selectedBoardDieId);
    if (!placement || surfaceId === undefined) return;
    const faceNumber = ((placement.faceNumber - 1 + direction + placement.die.sideCount) % placement.die.sideCount) + 1;
    const updated = { ...placement, faceNumber };
    setBoardDiePlacements((current) => current.map((item) => item.id === updated.id ? updated : item));
    enqueueDatabaseAction(async () => {
      await db.runAsync('UPDATE die_board_placements SET face_number = ? WHERE id = ? AND surface_id = ?', faceNumber, updated.id, surfaceId);
    }, 'Could not change die face:');
  }, [boardDiePlacements, db, enqueueDatabaseAction, selectedBoardDieId, surfaceId]);

  // A play-mode roll updates every selected die together and saves each result,
  // so the shown faces remain part of the current game state.
  const rollSelectedGameplayDice = useCallback(() => {
    if (surfaceId === undefined || selectedGameplayDieIds.length === 0) return;
    const selectedIds = new Set(selectedGameplayDieIds);
    const rolledDice = boardDiePlacements
      .filter((placement) => selectedIds.has(placement.id))
      .map((placement) => ({
        ...placement,
        faceNumber: Math.floor(Math.random() * Math.max(placement.die.sideCount, 1)) + 1,
      }));
    if (rolledDice.length === 0) return;

    const rolledById = new Map(rolledDice.map((placement) => [placement.id, placement]));
    setBoardDiePlacements((current) => current.map((placement) => rolledById.get(placement.id) ?? placement));
    enqueueDatabaseAction(async () => {
      await db.withTransactionAsync(async () => {
        for (const placement of rolledDice) {
          await db.runAsync(
            `INSERT INTO gameplay_die_placement_states (project_id, placement_id, face_number, updated_at)
             VALUES (?, ?, ?, ?) ON CONFLICT(project_id, placement_id) DO UPDATE SET
             face_number = excluded.face_number, updated_at = excluded.updated_at`,
            surfaceId.replace(/-board$/, ''),
            placement.id,
            placement.faceNumber,
            Date.now()
          );
        }
      });
    }, 'Could not save die rolls:');
  }, [boardDiePlacements, db, enqueueDatabaseAction, selectedGameplayDieIds, surfaceId]);

  const finishTilePlacementPreview = useCallback(() => {
    const preview = tilePlacementSessionRef.current;
    tilePlacementSessionRef.current = null;
    setTilePlacementPreview(null);
    if (!preview) return;
    const tile = preview.deckId === null ? placementTile ?? null : null;
    const deck = preview.deckId === null
      ? null
      : placementTileDeck ?? null;
    placeBoardTileAtPoint({ x: preview.x, y: preview.y }, tile, deck);
  }, [placeBoardTileAtPoint, placementTile, placementTileDeck]);

  const queueBoardTilePlacementSave = useCallback((placement: BoardTilePlacement) => {
    if (surfaceId === undefined) return;
    enqueueDatabaseAction(async () => {
      if (gameplayMode) {
        await db.runAsync(
          `INSERT INTO gameplay_tile_placement_states
            (project_id, placement_id, x, y, orientation, face_up)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, placement_id) DO UPDATE SET
           x = excluded.x, y = excluded.y, orientation = excluded.orientation,
           face_up = excluded.face_up, is_returned = 0`,
          surfaceId.replace(/-board$/, ''), placement.id, placement.x, placement.y,
          placement.orientation, placement.faceUp ? 1 : 0
        );
      } else {
        await db.runAsync(
          'UPDATE tile_board_placements SET x = ?, y = ?, orientation = ?, face_up = ? WHERE id = ? AND surface_id = ?',
          placement.x, placement.y, placement.orientation, placement.faceUp ? 1 : 0, placement.id, surfaceId
        );
      }
    }, 'Could not save tile position:');
  }, [db, enqueueDatabaseAction, gameplayMode, surfaceId]);

  const finishBoardTileDrag = useCallback(() => {
    const session = tilePlacementDragSessionRef.current;
    tilePlacementDragSessionRef.current = null;
    setTilePlacementPreview(null);
    if (session?.changed) {
      setBoardTilePlacements((current) => current.map((item) =>
        item.id === session.updatedPlacement.id ? session.updatedPlacement : item
      ));
      queueBoardTilePlacementSave(session.updatedPlacement);
    }
    if (gameplayMode) {
      setActiveGameplayDragKey(null);
      activePieceOffsetX.value = 0;
      activePieceOffsetY.value = 0;
      activePieceRotation.value = 0;
    }
  }, [activePieceOffsetX, activePieceOffsetY, activePieceRotation, gameplayMode, queueBoardTilePlacementSave]);

  const removeSelectedBoardTile = useCallback(() => {
    if (selectedBoardTilePlacementId === null) return;
    const id = selectedBoardTilePlacementId;
    setBoardTilePlacements((current) => current.filter((placement) => placement.id !== id));
    setSelectedBoardTilePlacementId(null);
    if (surfaceId !== undefined) {
      enqueueDatabaseAction(async () => {
        await db.runAsync('DELETE FROM tile_board_placements WHERE id = ? AND surface_id = ?', id, surfaceId);
      }, 'Could not remove tile from the board:');
    }
  }, [db, enqueueDatabaseAction, selectedBoardTilePlacementId, surfaceId]);

  const rotateSelectedBoardTile = useCallback(() => {
    const placement = boardTilePlacements.find((item) => item.id === selectedBoardTilePlacementId);
    if (!placement) return;
    const rotated = { ...placement, orientation: (placement.orientation + 15) % 360 };
    setBoardTilePlacements((current) => current.map((item) => item.id === rotated.id ? rotated : item));
    queueBoardTilePlacementSave(rotated);
  }, [boardTilePlacements, queueBoardTilePlacementSave, selectedBoardTilePlacementId]);

  const flipSelectedBoardTile = useCallback(() => {
    const placement = boardTilePlacements.find((item) => item.id === selectedBoardTilePlacementId);
    if (!placement?.tile?.backSurfaceId) return;
    const flipped = { ...placement, faceUp: !placement.faceUp };
    setBoardTilePlacements((current) => current.map((item) => item.id === flipped.id ? flipped : item));
    queueBoardTilePlacementSave(flipped);
  }, [boardTilePlacements, queueBoardTilePlacementSave, selectedBoardTilePlacementId]);

  // Individual tiles can return only to a deck that contains that tile type.
  // The available choices come from the saved recipe; the returned copy is
  // recorded separately so a fresh game still starts with the original deck.
  const returnSelectedBoardTileToDeck = useCallback(async () => {
    const placement = boardTilePlacements.find((item) => item.id === selectedBoardTilePlacementId);
    if (!placement || placement.tileId === null || surfaceId === undefined) return;
    const projectId = surfaceId.replace(/-board$/, '');
    try {
      const decks = await db.getAllAsync<{ id: number; name: string }>(
        `SELECT DISTINCT deck.id, deck.name FROM tile_decks AS deck
         JOIN tile_deck_items AS item ON item.deck_id = deck.id
         WHERE deck.project_id = ? AND item.tile_id = ? ORDER BY deck.name`,
        projectId, placement.tileId
      );
      if (decks.length === 0) {
        Alert.alert('No matching deck', 'This tile is not included in any saved tile deck.');
        return;
      }

      const returnToDeck = (deckId: number) => {
        setBoardTilePlacements((current) => current.filter((item) => item.id !== placement.id));
        setSelectedBoardTilePlacementId(null);
        setBoardTilePlacements((current) => current.map((item) => item.deckId === deckId
          ? { ...item, tileCount: item.tileCount + 1, tile: placement.tile }
          : item));
        enqueueDatabaseAction(async () => {
          await db.withTransactionAsync(async () => {
            await db.runAsync(
              `INSERT INTO gameplay_tile_deck_returns (project_id, deck_id, tile_id, quantity, updated_at)
               VALUES (?, ?, ?, 1, ?) ON CONFLICT(project_id, deck_id, tile_id) DO UPDATE SET
               quantity = gameplay_tile_deck_returns.quantity + 1, updated_at = excluded.updated_at`,
              projectId, deckId, placement.tileId, Date.now()
            );
            await db.runAsync(
              `INSERT INTO gameplay_tile_placement_states
                (project_id, placement_id, x, y, orientation, face_up, is_returned, returned_deck_id)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(project_id, placement_id) DO UPDATE SET
               x = excluded.x, y = excluded.y, orientation = excluded.orientation,
               face_up = excluded.face_up, is_returned = 1, returned_deck_id = excluded.returned_deck_id`,
              projectId, placement.id, placement.x, placement.y, placement.orientation,
              placement.faceUp ? 1 : 0, deckId
            );
          });
        }, 'Could not return tile to deck:');
      };

      if (decks.length === 1) {
        returnToDeck(decks[0].id);
      } else {
        Alert.alert('Return tile to deck', 'Choose which deck should receive this tile.', [
          ...decks.slice(0, 3).map((deck) => ({ text: deck.name, onPress: () => returnToDeck(deck.id) })),
          { text: 'Cancel', style: 'cancel' as const },
        ]);
      }
    } catch (error) {
      console.error('Could not find a matching tile deck:', error);
      Alert.alert('Could not return tile', 'Please try again.');
    }
  }, [boardTilePlacements, db, enqueueDatabaseAction, selectedBoardTilePlacementId, surfaceId]);

  const placeDeckSpot = useCallback((
    point: Point,
    setup: { spotType: DeckSpotType; deckId: number | null; faceUp: boolean }
  ) => {
    if (surfaceId === undefined) return;
    void db.runAsync(
      `INSERT INTO deck_spots
        (surface_id, x, y, orientation, spot_type, deck_id, face_up)
      VALUES (?, ?, ?, 0, ?, ?, ?)`,
      surfaceId,
      point.x,
      point.y,
      setup.spotType,
      setup.deckId,
      setup.faceUp ? 1 : 0
    ).then(async (result) => {
      const topCardRow = setup.deckId === null
        ? null
        : await db.getFirstAsync<{
            name: string;
            surface_id: string;
            back_surface_id: string | null;
            width_inches: number;
            height_inches: number;
          }>(
            `SELECT card.name, card.surface_id, card.back_surface_id,
              card.width_inches, card.height_inches
            FROM card_deck_items AS item
            JOIN cards AS card ON card.id = item.card_id
            WHERE item.deck_id = ? AND item.quantity > 0
            ORDER BY item.card_id ASC LIMIT 1`,
            setup.deckId
          );
      const newSpot: DeckSpot = {
        id: result.lastInsertRowId,
        x: point.x,
        y: point.y,
        orientation: 0,
        spotType: setup.spotType,
        deckId: setup.deckId,
        faceUp: setup.faceUp,
        cardCount: 0,
        topCard: topCardRow
          ? {
              name: topCardRow.name,
              frontSurfaceId: topCardRow.surface_id,
              backSurfaceId: topCardRow.back_surface_id,
              widthInches: topCardRow.width_inches,
              heightInches: topCardRow.height_inches,
            }
          : null,
      };
      setDeckSpots((current) => [...current, newSpot]);
      setSelectedDeckSpotId(newSpot.id);
      onDeckSpotPlaced?.();
    }).catch((error) => {
      console.error('Could not place deck spot:', error);
      Alert.alert('Could not place deck spot', 'Please try again.');
    });
  }, [db, onDeckSpotPlaced, surfaceId]);

  const selectedDeckSpot = deckSpots.find((spot) => spot.id === selectedDeckSpotId);
  const selectedTileSnapPoint = tileSnapPoints.find((point) => point.id === selectedTileSnapPointId);
  const selectedBoardTilePlacement = boardTilePlacements.find((item) => item.id === selectedBoardTilePlacementId);
  const selectedTokenSupply = tokenSupplyPlacements.find((item) => item.id === selectedTokenSupplyId);
  const selectedBoardToken = boardTokenPlacements.find((item) => item.id === selectedBoardTokenId);
  const selectedBoardDie = boardDiePlacements.find((item) => item.id === selectedBoardDieId);

  const removeSelectedSymbol = useCallback(() => {
    if (!selectedGroupId) return;
    const groupId = selectedGroupId;
    setStrokes((current) => current.filter((stroke) => stroke.groupId !== groupId));
    setRedoStrokes([]);
    setSelectedGroupId(null);
    if (surfaceId !== undefined && symbolId === undefined) {
      enqueueDatabaseAction(async () => {
        await db.runAsync(
          'DELETE FROM strokes WHERE surface_id = ? AND group_id = ?',
          surfaceId,
          groupId
        );
      }, 'Could not remove placed symbol:');
    }
  }, [db, enqueueDatabaseAction, selectedGroupId, surfaceId, symbolId]);

  const removeSelectedImage = useCallback(() => {
    if (selectedImageId === null) return;
    const imageId = selectedImageId;
    setPlacedImages((current) => current.filter((image) => image.id !== imageId));
    setSelectedImageId(null);
    if (surfaceId !== undefined) {
      enqueueDatabaseAction(async () => {
        await db.runAsync(
          'DELETE FROM surface_images WHERE id = ? AND surface_id = ?',
          imageId,
          surfaceId
        );
      }, 'Could not remove image:');
    }
  }, [db, enqueueDatabaseAction, selectedImageId, surfaceId]);

  // A card background uses the image file itself rather than a movable layer.
  // Saving it on the drawing surface keeps the front and back independent.
  const setSelectedImageAsBackground = useCallback(() => {
    if (!allowImageAsBackground || surfaceId === undefined || selectedImageId === null) return;
    const selectedImage = placedImages.find((image) => image.id === selectedImageId);
    if (!selectedImage) return;

    enqueueDatabaseAction(async () => {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          `UPDATE drawing_surfaces
          SET background_image_data = ?, background_image_mime_type = ?
          WHERE id = ?`,
          selectedImage.base64Data,
          selectedImage.mimeType,
          surfaceId
        );
        await db.runAsync(
          'DELETE FROM surface_images WHERE id = ? AND surface_id = ?',
          selectedImage.id,
          surfaceId
        );
      });
      setSurfaceBackgroundImage({
        base64Data: selectedImage.base64Data,
        mimeType: selectedImage.mimeType,
      });
      setPlacedImages((current) => current.filter((image) => image.id !== selectedImage.id));
      setSelectedImageId(null);
    }, 'Could not set card background image:');
  }, [allowImageAsBackground, db, enqueueDatabaseAction, placedImages, selectedImageId, surfaceId]);

  const clearSurfaceBackgroundImage = useCallback(() => {
    if (!allowImageAsBackground || surfaceId === undefined) return;
    setSurfaceBackgroundImage(null);
    enqueueDatabaseAction(async () => {
      await db.runAsync(
        `UPDATE drawing_surfaces
        SET background_image_data = NULL, background_image_mime_type = NULL
        WHERE id = ?`,
        surfaceId
      );
    }, 'Could not remove card background image:');
  }, [allowImageAsBackground, db, enqueueDatabaseAction, surfaceId]);

  const importImage = async () => {
    if (surfaceId === undefined) return;

    try {
      // Launch directly from this button press so web browsers allow the picker.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        base64: true,
        quality: 0.75,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      if (!asset?.base64) {
        Alert.alert('Image could not be imported', 'Please choose another image and try again.');
        return;
      }

      const sourceWidth = asset.width || 300;
      const sourceHeight = asset.height || 300;
      const maxScreenSide = Math.max(
        48,
        Math.min(canvasSize.width, canvasSize.height) * 0.42
      );
      const fitScale = maxScreenSide / Math.max(sourceWidth, sourceHeight);
      const transformScale = zoomRef.current * coordinateScale;
      const imageWidth = (sourceWidth * fitScale) / transformScale;
      const imageHeight = (sourceHeight * fitScale) / transformScale;
      const imageCenter = {
        x: (canvasSize.width / 2 - boardOffsetRef.current.x) / transformScale,
        y: (canvasSize.height / 2 - boardOffsetRef.current.y) / transformScale,
      };
      const mimeType = 'image/jpeg';
      const insertResult = await db.runAsync(
        `INSERT INTO surface_images
          (surface_id, base64_data, mime_type, center_x, center_y,
            width, height, order_index)
        VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          COALESCE((SELECT MAX(order_index) + 1 FROM surface_images WHERE surface_id = ?), 0)
        )`,
        surfaceId,
        asset.base64,
        mimeType,
        imageCenter.x,
        imageCenter.y,
        imageWidth,
        imageHeight,
        surfaceId
      );

      const newImage: PlacedImage = {
        id: insertResult.lastInsertRowId,
        base64Data: asset.base64,
        mimeType,
        center: imageCenter,
        width: imageWidth,
        height: imageHeight,
      };
      setPlacedImages((current) => [...current, newImage]);
      setSelectedImageId(newImage.id);
      setSelectedGroupId(null);
    } catch (error) {
      console.error('Could not import image:', error);
      Alert.alert('Image import failed', 'Please try again with a different image.');
    }
  };

  useImperativeHandle(ref, () => ({
    // Calling the picker through this handle keeps it inside the menu-button
    // press event, which is required by some browsers.
    importImage: () => {
      void importImage();
    },
    refreshGameplayPiles: () => {
      setGameplayPileRevision((revision) => revision + 1);
    },
    refreshGameplayState: () => {
      setGameplayRefreshRevision((revision) => revision + 1);
      setGameplayPileRevision((revision) => revision + 1);
    },
  }), [importImage]);

  const finishSymbolDrag = useCallback(() => {
    const session = symbolDragSessionRef.current;
    symbolDragSessionRef.current = null;
    if (session?.changed) {
      queueSymbolTransformSave(session);
    }
  }, [queueSymbolTransformSave]);

  const finishSymbolPinch = useCallback(() => {
    const session = symbolPinchSessionRef.current;
    symbolPinchSessionRef.current = null;
    if (session?.changed) {
      queueSymbolTransformSave(session);
    }
  }, [queueSymbolTransformSave]);

  // Undo removes the newest stroke from the canvas and the matching newest database
  // row. A subquery finds the row by order_index, so no extra ID needs to be stored
  // in the in-memory stroke objects.
  const undoStroke = useCallback(() => {
    const lastStroke = strokes[strokes.length - 1];
    if (!lastStroke) return;

    // All lines in a placed symbol share a group ID. Remove that whole group so
    // one Undo removes one stamp instead of only deleting its final line.
    const strokesToUndo = lastStroke.groupId
      ? strokes.filter((stroke) => stroke.groupId === lastStroke.groupId)
      : [lastStroke];
    const groupId = lastStroke.groupId;

    if (groupId && selectedGroupId === groupId) {
      setSelectedGroupId(null);
    }

    setStrokes((current) => groupId
      ? current.filter((stroke) => stroke.groupId !== groupId)
      : current.slice(0, -1)
    );
    setRedoStrokes((current) => [...current, strokesToUndo]);

    if (symbolId !== undefined) {
      enqueueDatabaseAction(async () => {
        await db.runAsync(
          `DELETE FROM symbol_strokes
          WHERE id = (
            SELECT id FROM symbol_strokes
            WHERE symbol_id = ?
            ORDER BY order_index DESC
            LIMIT 1
          )`,
          symbolId
        );
      }, 'Could not undo symbol stroke:');
    } else if (surfaceId && groupId) {
      enqueueDatabaseAction(async () => {
        await db.runAsync(
          'DELETE FROM strokes WHERE surface_id = ? AND group_id = ?',
          surfaceId,
          groupId
        );
      }, 'Could not undo symbol placement:');
    } else if (surfaceId) {
      enqueueDatabaseAction(async () => {
        await db.runAsync(
          `DELETE FROM strokes
          WHERE id = (
            SELECT id FROM strokes
            WHERE surface_id = ?
            ORDER BY order_index DESC
            LIMIT 1
          )`,
          surfaceId
        );
      }, 'Could not undo board stroke:');
    }
  }, [db, enqueueDatabaseAction, selectedGroupId, strokes, surfaceId, symbolId]);

  // Redo restores the most recently undone stroke and appends it after any strokes
  // that remain. Saving it assigns a fresh order_index after the current last row.
  const redoStroke = useCallback(() => {
    const strokesToRedo = redoStrokes[redoStrokes.length - 1];
    if (!strokesToRedo) return;

    setRedoStrokes((current) => current.slice(0, -1));
    setStrokes((current) => [...current, ...strokesToRedo]);
    strokesToRedo.forEach(queueStrokeSave);
  }, [queueStrokeSave, redoStrokes]);

  // finishStroke saves the current draft as a finalized stroke when the user lifts their finger.
  // We only save it if it has more than one point, because a single tap would otherwise create
  // a tiny meaningless mark.
  const finishStroke = useCallback(() => {
    const finished = draftRef.current;

    if (draftRenderFrameRef.current !== null) {
      cancelAnimationFrame(draftRenderFrameRef.current);
      draftRenderFrameRef.current = null;
    }
    draftPathNeedsRenderRef.current = false;
    latestDraftPointRef.current = null;

    if (finished && finished.points.length > 1) {
      setStrokes((current) => [...current, finished]);
      // Drawing after an undo starts a new history branch, so older redo strokes
      // are no longer reachable and are cleared.
      setRedoStrokes([]);
      queueStrokeSave(finished);
    }

    draftRef.current = null;
    setDraft(null);
    setEraserPosition(null);
  }, [queueStrokeSave]);

  const [boardOffset, setBoardOffset] = useState({ x: 0, y: 0 });
  const boardOffsetRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });

  const updateBoardOffset = useCallback((x: number, y: number) => {
    const nextOffset = { x, y };
    boardOffsetRef.current = nextOffset;
    setBoardOffset(nextOffset);
  }, []);

  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const pinchStartRef = useRef(1);

  // Hand cards report screen coordinates when released. Convert that position
  // back into board coordinates so a card can be dropped on a deck marker.
  useEffect(() => {
    if (!gameplayMode || !handCardDropRequest || canvasSize.width <= 0 || canvasSize.height <= 0) return;
    const rootView = rootViewRef.current;
    if (!rootView) return;

    rootView.measureInWindow((originX, originY) => {
      const localX = handCardDropRequest.absoluteX - originX;
      const localY = handCardDropRequest.absoluteY - originY;
      const insideCanvas = localX >= 0 && localY >= 0 && localX <= canvasSize.width && localY <= canvasSize.height;
      const point = {
        x: (localX - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
        y: (localY - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
      };
      const spot = insideCanvas
        ? findDeckSpotAtPoint(deckSpots, point, 16 / (zoomRef.current * coordinateScale))
        : null;

      onHandCardDropResolved?.(
        { requestId: handCardDropRequest.requestId, cardInstanceId: handCardDropRequest.cardInstanceId },
        spot?.id ?? null
      );
    });
  }, [canvasSize.height, canvasSize.width, coordinateScale, deckSpots, gameplayMode, handCardDropRequest, onHandCardDropResolved]);

  // Match touch hit-testing to the visible polygon, so the corner cutouts do
  // not accept marks or placements the user cannot see.
  const isInsideTileShape = (x: number, y: number) => {
    if (!surfaceShape) return true;
    const { width, height } = canvasSize;
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) return false;
    if (surfaceShape === 'circle') {
      const normalizedX = (x - width / 2) / (width / 2);
      const normalizedY = (y - height / 2) / (height / 2);
      return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
    }
    const inset = surfaceShape === 'hexagon'
      ? width * 0.25 * 2 * Math.abs(y / height - 0.5)
      : width * 0.5 * (1 - y / height);
    return x >= inset && x <= width - inset;
  };

  // These hit-test views are reused for every tap. Building a new wrapper array
  // during each gesture made Move Mode increasingly slow on crowded boards.
  const boardDieHitTargets = useMemo(
    () => boardDiePlacements.map((item) => ({ ...item, tile: getDieFaceTile(item.die, item.faceNumber) })),
    [boardDiePlacements]
  );
  const boardTokenHitTargets = useMemo(
    () => boardTokenPlacements.map((item) => ({ ...item, tile: item.token })),
    [boardTokenPlacements]
  );
  const tokenSupplyHitTargets = useMemo(
    () => tokenSupplyPlacements.map((item) => ({ ...item, tile: item.token })),
    [tokenSupplyPlacements]
  );

  // PanResponder handles touch gestures for drawing.
  // It listens for start, move, and release events so the app can collect points while the
  // user drags across the canvas.
  const drawGesture = usePanGesture({
    minPointers: 1,
    maxPointers: 1,
    runOnJS: true,
    activateAfterLongPress: 0,

    onBegin: ({ x, y }) => {
      if (gameplayMode) {
        if (!isInsideTileShape(x, y)) return;
        const point = {
          x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
          y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
        };
        if (gameplayTokenSupplyChoice !== null) {
          void takeGameplayTokenFromSupply(point, gameplayTokenSupplyChoice);
          return;
        }
        if (gameplayTileDeckChoice !== null) {
          void takeGameplayTileFromDeck(point, gameplayTileDeckChoice);
          return;
        }
        // Tapping dice adds or removes them from the current multi-die roll.
        // Dice render above tokens, so check them first when markers overlap.
        const gameplayDieHit = findBoardTileAtPoint(
          boardDieHitTargets,
          point,
          10 / (zoomRef.current * coordinateScale)
        );
        if (gameplayDieHit) {
          setSelectedGameplayDieIds((current) => current.includes(gameplayDieHit.id)
            ? current.filter((id) => id !== gameplayDieHit.id)
            : [...current, gameplayDieHit.id]);
          setSelectedBoardDieId(null);
          setSelectedBoardTokenId(null);
          setSelectedBoardTilePlacementId(null);
          setSelectedTokenSupplyId(null);
          setActiveGameplayDragKey(null);
          return;
        }
        // Placed tokens are drawn above supply markers, so they win hit tests
        // whenever the two overlap on the map.
        const tokenHit = findBoardTileAtPoint(
          boardTokenHitTargets,
          point,
          24 / (zoomRef.current * coordinateScale)
        );
        if (tokenHit) {
          setSelectedGameplayDieIds([]);
          setSelectedBoardTokenId(tokenHit.id);
          setActiveGameplayDragKey(`token-${tokenHit.id}`);
          setSelectedBoardTilePlacementId(null);
          setSelectedBoardDieId(null);
          setSelectedTokenSupplyId(null);
          tilePlacementDragSessionRef.current = null;
          setTilePlacementPreview(null);
          const token = boardTokenPlacements.find((item) => item.id === tokenHit.id)!;
          activePieceOffsetX.value = 0;
          activePieceOffsetY.value = 0;
          activePieceRotation.value = token.orientation;
          tokenMarkerDragSessionRef.current = {
            kind: 'token', id: token.id, startPoint: point,
            startX: token.x, startY: token.y, updatedX: token.x, updatedY: token.y, changed: false,
          };
          return;
        }
        const supplyHit = findBoardTileAtPoint(
          tokenSupplyHitTargets,
          point,
          24 / (zoomRef.current * coordinateScale)
        );
        if (supplyHit) {
          if (supplyHit.quantity === 0) {
            Alert.alert('Token supply is empty', `There are no ${supplyHit.token.name} tokens left.`);
            return;
          }
          setGameplayTokenSupplyChoice(supplyHit.id);
          setSelectedGameplayDieIds([]);
          setGameplayTileDeckChoice(null);
          setSelectedBoardTokenId(null);
          setSelectedBoardTilePlacementId(null);
          gameplayTakeDragSessionRef.current = {
            kind: 'token', sourceId: supplyHit.id,
            startPoint: point, updatedPoint: point, changed: false,
          };
          setGameplayTakePreview({ kind: 'token', sourceId: supplyHit.id, tile: supplyHit.token, startPoint: point });
          activePieceOffsetX.value = 0;
          activePieceOffsetY.value = 0;
          activePieceRotation.value = supplyHit.orientation;
          return;
        }
        const tileDeckHit = findBoardTileAtPoint(
          boardTilePlacements.filter((item) => item.deckId !== null),
          point,
          14 / (zoomRef.current * coordinateScale)
        );
        if (tileDeckHit?.deckId !== null && tileDeckHit?.deckId !== undefined) {
          if (tileDeckHit.tileCount <= 0 || !tileDeckHit.tile) {
            Alert.alert('Tile deck is empty', `${tileDeckHit.deckName ?? 'This deck'} has no tiles left.`);
            return;
          }
          setGameplayTileDeckChoice(tileDeckHit.deckId);
          setSelectedGameplayDieIds([]);
          setGameplayTokenSupplyChoice(null);
          setSelectedBoardTokenId(null);
          setSelectedBoardTilePlacementId(null);
          gameplayTakeDragSessionRef.current = {
            kind: 'tile', sourceId: tileDeckHit.deckId,
            startPoint: point, updatedPoint: point, changed: false,
          };
          setGameplayTakePreview({ kind: 'tile', sourceId: tileDeckHit.deckId, tile: tileDeckHit.tile, startPoint: point });
          activePieceOffsetX.value = 0;
          activePieceOffsetY.value = 0;
          activePieceRotation.value = tileDeckHit.orientation;
          return;
        }
        // Play mode still supports direct manipulation of game pieces. Start
        // these same lightweight drag sessions used by the editor so position
        // updates are saved with the normal placement records.
        const tileHit = findBoardTileAtPoint(
          // A tile deck is a single pile marker, not a loose tile. Keep it
          // anchored during play so touching it can't drag the whole stack.
          boardTilePlacements.filter((item) => !gameplayMode || item.tileId !== null),
          point,
          10 / (zoomRef.current * coordinateScale)
        );
        if (tileHit) {
          setSelectedGameplayDieIds([]);
          setSelectedBoardTilePlacementId(tileHit.id);
          setActiveGameplayDragKey(`tile-${tileHit.id}`);
          setSelectedBoardTokenId(null);
          setSelectedBoardDieId(null);
          setSelectedTokenSupplyId(null);
          tokenMarkerDragSessionRef.current = null;
          activePieceOffsetX.value = 0;
          activePieceOffsetY.value = 0;
          activePieceRotation.value = tileHit.orientation;
          tilePlacementDragSessionRef.current = {
            placementId: tileHit.id,
            basePlacement: tileHit,
            updatedPlacement: tileHit,
            startPoint: point,
            changed: false,
          };
          setTilePlacementPreview({
            tile: tileHit.tile,
            deckId: tileHit.deckId,
            deckName: tileHit.deckName,
            tileCount: tileHit.tileCount,
            faceUp: tileHit.faceUp,
            x: tileHit.x,
            y: tileHit.y,
            orientation: tileHit.orientation,
            snapped: false,
          });
          return;
        }
        const spot = findDeckSpotAtPoint(deckSpots, point, 14 / (zoomRef.current * coordinateScale));
        if (spot?.cardCount && spot.topCard) {
          setSelectedGameplayDieIds([]);
          // The card moves as a lightweight preview; the pile itself stays put
          // until a valid drop destination is found on release.
          deckCardDragSessionRef.current = {
            sourceSpotId: spot.id,
            startPoint: point,
            updatedPoint: point,
            screenY: y,
            changed: false,
          };
          setDeckCardDragPreview({ spot, startPoint: point });
          activePieceOffsetX.value = 0;
          activePieceOffsetY.value = 0;
          activePieceRotation.value = spot.orientation;
          return;
        }
        setSelectedBoardTokenId(null);
        setSelectedBoardTilePlacementId(null);
        setSelectedGameplayDieIds([]);
        setActiveGameplayDragKey(null);
        return;
      }
      if (!isInsideTileShape(x, y)) return;
      const point = {
        x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
        y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
      };

      if (placementTokenSupply) {
        placeTokenSupply(point, placementTokenSupply);
        return;
      }

      if (placementToken) {
        placeBoardToken(point, placementToken);
        return;
      }

      if (placementDie) {
        placeBoardDie(point, placementDie);
        return;
      }

      if (placementTile !== undefined || placementTileDeck !== undefined) {
        const tile = placementTile ?? placementTileDeck?.topTile ?? null;
        const snapThreshold = Math.max(24, Math.min(getBoardTileSize(tile).width, getBoardTileSize(tile).height) * 0.45);
        const snapPoint = findNearestTileSnapPoint(tileSnapPoints, point, snapThreshold);
        const preview: TilePlacementPreview = {
          tile,
          deckId: placementTileDeck?.id ?? null,
          deckName: placementTileDeck?.name ?? null,
          tileCount: placementTileDeck?.tileCount ?? 0,
          faceUp: true,
          x: snapPoint?.x ?? point.x,
          y: snapPoint?.y ?? point.y,
          orientation: snapPoint?.orientation ?? 0,
          snapped: snapPoint !== null,
        };
        tilePlacementSessionRef.current = preview;
        setTilePlacementPreview(preview);
        return;
      }

      if (placementTileSnapPoint) {
        placeTileSnapPoint(point);
        return;
      }

      if (placementDeckSpot !== undefined) {
        placeDeckSpot(point, placementDeckSpot);
        return;
      }

      if (placementSymbolId !== undefined) {
        const selectedSymbol = placementSymbolData;
        if (
          selectedSymbol?.id !== placementSymbolId ||
          selectedSymbol.strokes.length === 0
        ) {
          return;
        }

        // Symbols are drawn in a 300 x 300 editor. Scale them to about 105 x 105
        // drawing units and center the saved artwork around the tap location.
        const symbolScale = placementSymbolScale;
        const groupId = `symbol-${Date.now()}-${placementGroupCounterRef.current++}`;
        const placedStrokes = selectedSymbol.strokes.map((stroke) => ({
          ...stroke,
          points: stroke.points.map((symbolPoint) => ({
            x: point.x + (symbolPoint.x - SYMBOL_CANVAS_SIZE / 2) * symbolScale,
            y: point.y + (symbolPoint.y - SYMBOL_CANVAS_SIZE / 2) * symbolScale,
          })),
          width: Math.max(1 / coordinateScale, stroke.width * symbolScale),
          groupId,
        }));

        setStrokes((current) => [...current, ...placedStrokes]);
        setRedoStrokes([]);
        placedStrokes.forEach(queueStrokeSave);
        if (!repeatSymbolPlacement) onSymbolPlaced?.();
        return;
      }

      if (isEditingSymbols) {
        // Dice, tokens, and supplies render over the other board markers. Check
        // their visible shapes first so drags begin on the item that was tapped.
        const dieHit = findBoardTileAtPoint(
          boardDieHitTargets,
          point,
          10 / (zoomRef.current * coordinateScale)
        );
        if (dieHit) {
          setSelectedBoardDieId(dieHit.id);
          setSelectedBoardTokenId(null);
          setSelectedTokenSupplyId(null);
          setSelectedBoardTilePlacementId(null);
          setSelectedTileSnapPointId(null);
          setSelectedDeckSpotId(null);
          setSelectedImageId(null);
          setSelectedGroupId(null);
          tilePlacementDragSessionRef.current = null;
          tileSnapDragSessionRef.current = null;
          deckSpotDragSessionRef.current = null;
          imageDragSessionRef.current = null;
          symbolDragSessionRef.current = null;
          const base = boardDiePlacements.find((item) => item.id === dieHit.id)!;
          tokenMarkerDragSessionRef.current = {
            kind: 'die', id: base.id, startPoint: point,
            startX: base.x, startY: base.y, updatedX: base.x, updatedY: base.y, changed: false,
          };
          return;
        }
        const tokenHit = findBoardTileAtPoint(
          boardTokenHitTargets,
          point,
          10 / (zoomRef.current * coordinateScale)
        );
        if (tokenHit) {
          setSelectedBoardDieId(null);
          setSelectedBoardTokenId(tokenHit.id);
          setSelectedTokenSupplyId(null);
          setSelectedBoardTilePlacementId(null);
          setSelectedTileSnapPointId(null);
          setSelectedDeckSpotId(null);
          setSelectedImageId(null);
          setSelectedGroupId(null);
          tilePlacementDragSessionRef.current = null;
          tileSnapDragSessionRef.current = null;
          deckSpotDragSessionRef.current = null;
          imageDragSessionRef.current = null;
          symbolDragSessionRef.current = null;
          const base = boardTokenPlacements.find((item) => item.id === tokenHit.id)!;
          tokenMarkerDragSessionRef.current = {
            kind: 'token', id: base.id, startPoint: point,
            startX: base.x, startY: base.y, updatedX: base.x, updatedY: base.y, changed: false,
          };
          return;
        }
        const supplyHit = findBoardTileAtPoint(
          tokenSupplyHitTargets,
          point,
          10 / (zoomRef.current * coordinateScale)
        );
        if (supplyHit) {
          setSelectedBoardDieId(null);
          setSelectedTokenSupplyId(supplyHit.id);
          setSelectedBoardTokenId(null);
          setSelectedBoardTilePlacementId(null);
          setSelectedTileSnapPointId(null);
          setSelectedDeckSpotId(null);
          setSelectedImageId(null);
          setSelectedGroupId(null);
          tilePlacementDragSessionRef.current = null;
          tileSnapDragSessionRef.current = null;
          deckSpotDragSessionRef.current = null;
          imageDragSessionRef.current = null;
          symbolDragSessionRef.current = null;
          const base = tokenSupplyPlacements.find((item) => item.id === supplyHit.id)!;
          tokenMarkerDragSessionRef.current = {
            kind: 'supply', id: base.id, startPoint: point,
            startX: base.x, startY: base.y, updatedX: base.x, updatedY: base.y, changed: false,
          };
          return;
        }
        tokenMarkerDragSessionRef.current = null;
        setSelectedBoardDieId(null);
        setSelectedTokenSupplyId(null);
        setSelectedBoardTokenId(null);
        const selectedBoardTile = findBoardTileAtPoint(
          boardTilePlacements,
          point,
          10 / (zoomRef.current * coordinateScale)
        );
        if (selectedBoardTile) {
          setSelectedBoardTilePlacementId(selectedBoardTile.id);
          setSelectedTileSnapPointId(null);
          setSelectedDeckSpotId(null);
          setSelectedImageId(null);
          setSelectedGroupId(null);
          imageDragSessionRef.current = null;
          symbolDragSessionRef.current = null;
          deckSpotDragSessionRef.current = null;
          tileSnapDragSessionRef.current = null;
          tilePlacementDragSessionRef.current = {
            placementId: selectedBoardTile.id,
            basePlacement: selectedBoardTile,
            updatedPlacement: selectedBoardTile,
            startPoint: point,
            changed: false,
          };
          setTilePlacementPreview({
            tile: selectedBoardTile.tile,
            deckId: selectedBoardTile.deckId,
            deckName: selectedBoardTile.deckName,
            tileCount: selectedBoardTile.tileCount,
            faceUp: selectedBoardTile.faceUp,
            x: selectedBoardTile.x,
            y: selectedBoardTile.y,
            orientation: selectedBoardTile.orientation,
            snapped: tileSnapPoints.some((snapPoint) =>
              Math.hypot(snapPoint.x - selectedBoardTile.x, snapPoint.y - selectedBoardTile.y) < 0.5
            ),
          });
          return;
        }
        setSelectedBoardTilePlacementId(null);
        tilePlacementDragSessionRef.current = null;
        setTilePlacementPreview(null);
        const selectedSnapPoint = [...tileSnapPoints].reverse().find((item) =>
          Math.hypot(point.x - item.x, point.y - item.y) <= 16 / (zoomRef.current * coordinateScale)
        );
        if (selectedSnapPoint) {
          setSelectedTileSnapPointId(selectedSnapPoint.id);
          setSelectedBoardTilePlacementId(null);
          setSelectedDeckSpotId(null);
          setSelectedImageId(null);
          setSelectedGroupId(null);
          imageDragSessionRef.current = null;
          symbolDragSessionRef.current = null;
          deckSpotDragSessionRef.current = null;
          tileSnapDragSessionRef.current = {
            pointId: selectedSnapPoint.id,
            basePoint: selectedSnapPoint,
            updatedPoint: selectedSnapPoint,
            startPoint: point,
            changed: false,
          };
          return;
        }
        setSelectedTileSnapPointId(null);
        tileSnapDragSessionRef.current = null;
        const selectedSpot = findDeckSpotAtPoint(
          deckSpots,
          point,
          8 / (zoomRef.current * coordinateScale)
        );
        if (selectedSpot) {
          setSelectedDeckSpotId(selectedSpot.id);
          setSelectedBoardTilePlacementId(null);
          setSelectedTileSnapPointId(null);
          setSelectedImageId(null);
          setSelectedGroupId(null);
          imageDragSessionRef.current = null;
          symbolDragSessionRef.current = null;
          deckSpotDragSessionRef.current = {
            spotId: selectedSpot.id,
            baseSpot: selectedSpot,
            updatedSpot: selectedSpot,
            startPoint: point,
            changed: false,
          };
          return;
        }

        setSelectedDeckSpotId(null);
        deckSpotDragSessionRef.current = null;
        const selectedImage = findPlacedImageAtPoint(
          placedImages,
          point,
          14 / (zoomRef.current * coordinateScale)
        );
        if (selectedImage) {
          const center = selectedImage.center;
          const handleTolerance = 16 / (zoomRef.current * coordinateScale);
          const corners = [
            { x: center.x - selectedImage.width / 2, y: center.y - selectedImage.height / 2 },
            { x: center.x + selectedImage.width / 2, y: center.y - selectedImage.height / 2 },
            { x: center.x + selectedImage.width / 2, y: center.y + selectedImage.height / 2 },
            { x: center.x - selectedImage.width / 2, y: center.y + selectedImage.height / 2 },
          ];
          const startedOnHandle = corners.some(
            (corner) => Math.hypot(point.x - corner.x, point.y - corner.y) <= handleTolerance
          );

          setSelectedImageId(selectedImage.id);
          setSelectedBoardTilePlacementId(null);
          setSelectedGroupId(null);
          symbolDragSessionRef.current = null;
          imageDragSessionRef.current = {
            imageId: selectedImage.id,
            baseImage: selectedImage,
            updatedImage: selectedImage,
            center,
            startPoint: point,
            resizeStartDistance: startedOnHandle
              ? Math.max(1, Math.hypot(point.x - center.x, point.y - center.y))
              : undefined,
            changed: false,
          };
          return;
        }

        setSelectedImageId(null);
        imageDragSessionRef.current = null;
        setSelectedBoardTilePlacementId(null);
        let symbolHitTargets = placedSymbolHitTargetsRef.current;
        if (!symbolHitTargets || symbolHitTargets.strokes !== strokes) {
          symbolHitTargets = { strokes, targets: buildPlacedSymbolHitTargets(strokes) };
          placedSymbolHitTargetsRef.current = symbolHitTargets;
        }
        const selected = findPlacedSymbolAtPoint(
          symbolHitTargets.targets,
          point,
          14 / (zoomRef.current * coordinateScale)
        );

        if (!selected) {
          setSelectedGroupId(null);
          setSelectedBoardTilePlacementId(null);
          symbolDragSessionRef.current = null;
          return;
        }

        setSelectedGroupId(selected.groupId);
        setSelectedBoardTilePlacementId(null);
        const center = {
          x: (selected.bounds.left + selected.bounds.right) / 2,
          y: (selected.bounds.top + selected.bounds.bottom) / 2,
        };
        const handleTolerance = 16 / (zoomRef.current * coordinateScale);
        const corners = [
          { x: selected.bounds.left, y: selected.bounds.top },
          { x: selected.bounds.right, y: selected.bounds.top },
          { x: selected.bounds.right, y: selected.bounds.bottom },
          { x: selected.bounds.left, y: selected.bounds.bottom },
        ];
        const startedOnHandle = corners.some(
          (corner) =>
            Math.hypot(point.x - corner.x, point.y - corner.y) <= handleTolerance
        );

        symbolDragSessionRef.current = {
          groupId: selected.groupId,
          baseStrokes: selected.strokes,
          updatedStrokes: selected.strokes,
          center,
          startPoint: point,
          resizeStartDistance: startedOnHandle
            ? Math.max(
                1,
                Math.hypot(point.x - center.x, point.y - center.y)
              )
            : undefined,
          changed: false,
        };
        return;
      }

      const newStroke: Stroke = {
        points: [point],
        width: lineWidth / coordinateScale,
        eraser: isErasing,
        color: penColor,
      };

      draftRef.current = newStroke;
      setDraft(newStroke);
      latestDraftPointRef.current = point;
      setEraserPosition(isErasing ? point : null);
    },

    onUpdate: ({ x, y }) => {
      const placementPreview = tilePlacementSessionRef.current;
      if (placementPreview) {
        const point = {
          x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
          y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
        };
        const snapThreshold = Math.max(24, Math.min(getBoardTileSize(placementPreview.tile).width, getBoardTileSize(placementPreview.tile).height) * 0.45);
        const snapPoint = findNearestTileSnapPoint(tileSnapPoints, point, snapThreshold);
        const updatedPreview = {
          ...placementPreview,
          x: snapPoint?.x ?? point.x,
          y: snapPoint?.y ?? point.y,
          orientation: snapPoint?.orientation ?? 0,
          snapped: snapPoint !== null,
        };
        tilePlacementSessionRef.current = updatedPreview;
        setTilePlacementPreview(updatedPreview);
        return;
      }
      if (isEditingSymbols || gameplayMode) {
        const deckCardSession = deckCardDragSessionRef.current;
        if (gameplayMode && deckCardSession) {
          const point = {
            x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
            y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
          };
          deckCardSession.updatedPoint = point;
          deckCardSession.screenY = y;
          deckCardSession.changed = Math.hypot(
            point.x - deckCardSession.startPoint.x,
            point.y - deckCardSession.startPoint.y
          ) > 8 / (zoomRef.current * coordinateScale);
          activePieceOffsetX.value = (point.x - deckCardSession.startPoint.x) * zoomRef.current * coordinateScale;
          activePieceOffsetY.value = (point.y - deckCardSession.startPoint.y) * zoomRef.current * coordinateScale;
          return;
        }
        const takeSession = gameplayTakeDragSessionRef.current;
        if (gameplayMode && takeSession) {
          const point = {
            x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
            y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
          };
          takeSession.updatedPoint = point;
          takeSession.changed = Math.hypot(
            point.x - takeSession.startPoint.x,
            point.y - takeSession.startPoint.y
          ) > 8 / (zoomRef.current * coordinateScale);
          activePieceOffsetX.value = (point.x - takeSession.startPoint.x) * zoomRef.current * coordinateScale;
          activePieceOffsetY.value = (point.y - takeSession.startPoint.y) * zoomRef.current * coordinateScale;
          return;
        }
        const markerSession = tokenMarkerDragSessionRef.current;
        if (markerSession) {
          const point = {
            x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
            y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
          };
          const nextX = markerSession.startX + point.x - markerSession.startPoint.x;
          const nextY = markerSession.startY + point.y - markerSession.startPoint.y;
          markerSession.updatedX = nextX;
          markerSession.updatedY = nextY;
          markerSession.changed = Math.hypot(nextX - markerSession.startX, nextY - markerSession.startY) > 0.5;
          if (gameplayMode && markerSession.kind === 'token') {
            activePieceOffsetX.value = (nextX - markerSession.startX) * zoomRef.current * coordinateScale;
            activePieceOffsetY.value = (nextY - markerSession.startY) * zoomRef.current * coordinateScale;
            return;
          }
          // Gesture events can arrive faster than the screen can render. Keep
          // only the latest point and redraw this marker at most once per frame.
          // Re-rendering the complete canvas for every pointer event is costly
          // on phones. Drawing at about 30 fps keeps pieces responsive while
          // the final exact coordinate is still committed on release.
          if (tokenMarkerRenderFrameRef.current === null && Date.now() - lastTokenMarkerRenderAtRef.current >= 32) {
            tokenMarkerRenderFrameRef.current = requestAnimationFrame(() => {
              tokenMarkerRenderFrameRef.current = null;
              lastTokenMarkerRenderAtRef.current = Date.now();
              const latest = tokenMarkerDragSessionRef.current;
              if (!latest) return;
              if (latest.kind === 'supply') {
                setTokenSupplyPlacements((current) => current.map((item) => item.id === latest.id
                  ? { ...item, x: latest.updatedX, y: latest.updatedY } : item));
              } else if (latest.kind === 'token') {
                setBoardTokenPlacements((current) => current.map((item) => item.id === latest.id
                  ? { ...item, x: latest.updatedX, y: latest.updatedY } : item));
              } else {
                setBoardDiePlacements((current) => current.map((item) => item.id === latest.id
                  ? { ...item, x: latest.updatedX, y: latest.updatedY } : item));
              }
            });
          }
          return;
        }
        const tileSession = tilePlacementDragSessionRef.current;
        if (tileSession) {
          const point = {
            x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
            y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
          };
          const offset = {
            x: point.x - tileSession.startPoint.x,
            y: point.y - tileSession.startPoint.y,
          };
          const candidate = {
            ...tileSession.basePlacement,
            x: tileSession.basePlacement.x + offset.x,
            y: tileSession.basePlacement.y + offset.y,
          };
          const tileSize = getBoardTileSize(candidate.tile);
          const snapPoint = findNearestTileSnapPoint(
            tileSnapPoints,
            { x: candidate.x, y: candidate.y },
            Math.max(24, Math.min(tileSize.width, tileSize.height) * 0.45)
          );
          const updated = snapPoint
            ? { ...candidate, x: snapPoint.x, y: snapPoint.y, orientation: snapPoint.orientation }
            : candidate;
          tileSession.updatedPlacement = updated;
          tileSession.changed = Math.hypot(offset.x, offset.y) > 0.5 / (zoomRef.current * coordinateScale);
          if (gameplayMode) {
            activePieceOffsetX.value = (updated.x - tileSession.basePlacement.x) * zoomRef.current * coordinateScale;
            activePieceOffsetY.value = (updated.y - tileSession.basePlacement.y) * zoomRef.current * coordinateScale;
            activePieceRotation.value = updated.orientation;
          } else if (Date.now() - lastTilePreviewRenderAtRef.current >= 32) {
            lastTilePreviewRenderAtRef.current = Date.now();
            setTilePlacementPreview({
              tile: updated.tile,
              deckId: updated.deckId,
              deckName: updated.deckName,
              tileCount: updated.tileCount,
              faceUp: updated.faceUp,
              x: updated.x,
              y: updated.y,
              orientation: updated.orientation,
              snapped: snapPoint !== null,
            });
          }
          return;
        }
        const snapSession = tileSnapDragSessionRef.current;
        if (snapSession) {
          const point = {
            x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
            y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
          };
          const offset = {
            x: point.x - snapSession.startPoint.x,
            y: point.y - snapSession.startPoint.y,
          };
          const updatedPoint = {
            ...snapSession.basePoint,
            x: snapSession.basePoint.x + offset.x,
            y: snapSession.basePoint.y + offset.y,
          };
          snapSession.updatedPoint = updatedPoint;
          snapSession.changed = Math.hypot(offset.x, offset.y) > 0.5 / (zoomRef.current * coordinateScale);
          setTileSnapPoints((current) => current.map((item) => item.id === snapSession.pointId ? updatedPoint : item));
          return;
        }
        const spotSession = deckSpotDragSessionRef.current;
        if (spotSession) {
          const point = {
            x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
            y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
          };
          const offset = {
            x: point.x - spotSession.startPoint.x,
            y: point.y - spotSession.startPoint.y,
          };
          const updatedSpot = {
            ...spotSession.baseSpot,
            x: spotSession.baseSpot.x + offset.x,
            y: spotSession.baseSpot.y + offset.y,
          };
          spotSession.updatedSpot = updatedSpot;
          spotSession.changed = Math.hypot(offset.x, offset.y) >
            0.5 / (zoomRef.current * coordinateScale);
          setDeckSpots((current) => current.map((spot) =>
            spot.id === spotSession.spotId ? updatedSpot : spot
          ));
          return;
        }

        const imageSession = imageDragSessionRef.current;
        if (imageSession) {
          const point = {
            x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
            y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
          };
          let updatedImage: PlacedImage;

          if (imageSession.resizeStartDistance !== undefined) {
            const distance = Math.hypot(
              point.x - imageSession.center.x,
              point.y - imageSession.center.y
            );
            const scale = Math.max(
              0.2,
              Math.min(5, distance / imageSession.resizeStartDistance)
            );
            updatedImage = {
              ...imageSession.baseImage,
              width: imageSession.baseImage.width * scale,
              height: imageSession.baseImage.height * scale,
            };
            imageSession.changed = Math.abs(scale - 1) > 0.01;
          } else {
            const offset = {
              x: point.x - imageSession.startPoint.x,
              y: point.y - imageSession.startPoint.y,
            };
            const moveThreshold = 0.5 / (zoomRef.current * coordinateScale);
            if (
              Math.abs(offset.x) < moveThreshold &&
              Math.abs(offset.y) < moveThreshold
            ) return;
            updatedImage = {
              ...imageSession.baseImage,
              center: {
                x: imageSession.baseImage.center.x + offset.x,
                y: imageSession.baseImage.center.y + offset.y,
              },
            };
            imageSession.changed = true;
          }

          imageSession.updatedImage = updatedImage;
          setPlacedImages((current) => current.map((image) =>
            image.id === imageSession.imageId ? updatedImage : image
          ));
          return;
        }

        const session = symbolDragSessionRef.current;
        if (!session) return;

        const point = {
          x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
          y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
        };
        if (session.resizeStartDistance !== undefined) {
          const currentDistance = Math.hypot(
            point.x - session.center.x,
            point.y - session.center.y
          );
          const scale = Math.max(
            0.25,
            Math.min(4, currentDistance / session.resizeStartDistance)
          );
          const resizedStrokes = transformSymbolStrokes(
            session.baseStrokes,
            session.center,
            scale,
            { x: 0, y: 0 },
            1 / coordinateScale
          );
          session.updatedStrokes = resizedStrokes;
          session.changed = Math.abs(scale - 1) > 0.01;
          if (session.changed) setRedoStrokes([]);

          setStrokes((current) => [
            ...current.filter((stroke) => stroke.groupId !== session.groupId),
            ...resizedStrokes,
          ]);
          return;
        }

        const offset = {
          x: point.x - session.startPoint.x,
          y: point.y - session.startPoint.y,
        };
        const moveThreshold = 0.5 / (zoomRef.current * coordinateScale);
        if (
          Math.abs(offset.x) < moveThreshold &&
          Math.abs(offset.y) < moveThreshold
        ) return;

        const movedStrokes = transformSymbolStrokes(
          session.baseStrokes,
          session.center,
          1,
          offset,
          1 / coordinateScale
        );
        session.updatedStrokes = movedStrokes;
        session.changed = true;
        setRedoStrokes([]);

        // Moving a symbol brings its complete stroke group to the front of the map.
        setStrokes((current) => [
          ...current.filter((stroke) => stroke.groupId !== session.groupId),
          ...movedStrokes,
        ]);
        return;
      }

      const current = draftRef.current;
      if (!current) return;

      const point = {
        x: (x - boardOffsetRef.current.x) / zoomRef.current / coordinateScale,
        y: (y - boardOffsetRef.current.y) / zoomRef.current / coordinateScale,
      };
  
      const lastPoint = current.points[current.points.length - 1];
      const minDistance = 2 / (zoomRef.current * coordinateScale);

      const dx = point.x - lastPoint.x;
      const dy = point.y - lastPoint.y;

      if (dx * dx + dy * dy < minDistance * minDistance) {
        if (current.eraser) {
          latestDraftPointRef.current = point;
          scheduleDraftRender(false);
        }
        return;
      }

      current.points.push(point);
      latestDraftPointRef.current = point;
      scheduleDraftRender();

      // Keep every accepted point, but avoid rebuilding the visible path more than once
      // per animation frame when the gesture reports updates faster than the display.
    },

    onFinalize: () => {
      const deckCardSession = deckCardDragSessionRef.current;
      deckCardDragSessionRef.current = null;
      setDeckCardDragPreview(null);
      activePieceOffsetX.value = 0;
      activePieceOffsetY.value = 0;
      if (gameplayMode && deckCardSession?.changed) {
        const targetSpot = findDeckSpotAtPoint(
          deckSpots,
          deckCardSession.updatedPoint,
          16 / (zoomRef.current * coordinateScale)
        );
        rootViewRef.current?.measureInWindow((_originX, originY) => {
          onDeckCardDragRequest?.(
            deckCardSession.sourceSpotId,
            targetSpot?.id ?? null,
            originY + deckCardSession.screenY
          );
        });
      }
      const takeSession = gameplayTakeDragSessionRef.current;
      gameplayTakeDragSessionRef.current = null;
      if (gameplayMode) {
        setGameplayTakePreview(null);
        if (takeSession?.changed) {
          if (takeSession.kind === 'token') {
            void takeGameplayTokenFromSupply(takeSession.updatedPoint, takeSession.sourceId);
          } else {
            void takeGameplayTileFromDeck(takeSession.updatedPoint, takeSession.sourceId);
          }
        }
      }
      if (tilePlacementSessionRef.current) {
        finishTilePlacementPreview();
      } else if (isEditingSymbols || gameplayMode) {
        finishTokenMarkerDrag();
        finishBoardTileDrag();
        finishImageDrag();
        finishSnapPointDrag();
        finishDeckSpotDrag();
        finishSymbolDrag();
      } else {
        finishStroke();
      }
    },
  });

  const boardPanGesture = usePanGesture({
    minPointers: 2,
    maxPointers: 2,
    runOnJS: true,

    onActivate: (event) => {
      panStartRef.current = {
        x: boardOffsetRef.current.x - event.translationX,
        y: boardOffsetRef.current.y - event.translationY,
      };
    },

    onUpdate: (event) => {
      if (isEditingSymbols) return;
      updateBoardOffset(
        panStartRef.current.x + event.translationX,
        panStartRef.current.y + event.translationY
      );
    },
  });

  const zoomGesture = usePinchGesture({
    runOnJS: true,

    onActivate: () => {
      if (isEditingSymbols) {
        const selectedImage = placedImages.find(
          (image) => image.id === selectedImageId
        );
        if (selectedImage) {
          imagePinchSessionRef.current = {
            imageId: selectedImage.id,
            baseImage: selectedImage,
            updatedImage: selectedImage,
            center: selectedImage.center,
            startPoint: { x: 0, y: 0 },
            changed: false,
          };
          symbolPinchSessionRef.current = null;
          return;
        }

        const groupStrokes = selectedGroupId
          ? strokes.filter((stroke) => stroke.groupId === selectedGroupId)
          : [];
        const bounds = getStrokeBounds(groupStrokes);

        if (!selectedGroupId || !bounds) {
          symbolPinchSessionRef.current = null;
          return;
        }

        symbolPinchSessionRef.current = {
          groupId: selectedGroupId,
          baseStrokes: groupStrokes,
          updatedStrokes: groupStrokes,
          center: {
            x: (bounds.left + bounds.right) / 2,
            y: (bounds.top + bounds.bottom) / 2,
          },
          startPoint: { x: 0, y: 0 },
          changed: false,
        };
        return;
      }

      pinchStartRef.current = zoomRef.current;
    },

    onUpdate: (event) => {
      if (isEditingSymbols) {
        const imageSession = imagePinchSessionRef.current;
        if (imageSession) {
          const scale = Math.max(0.2, Math.min(5, event.scale));
          const updatedImage = {
            ...imageSession.baseImage,
            width: imageSession.baseImage.width * scale,
            height: imageSession.baseImage.height * scale,
          };
          imageSession.updatedImage = updatedImage;
          imageSession.changed = Math.abs(scale - 1) > 0.01;
          setPlacedImages((current) => current.map((image) =>
            image.id === imageSession.imageId ? updatedImage : image
          ));
          return;
        }

        const session = symbolPinchSessionRef.current;
        if (!session) return;

        const scale = Math.max(0.25, Math.min(4, event.scale));
        const resizedStrokes = transformSymbolStrokes(
          session.baseStrokes,
          session.center,
          scale,
          { x: 0, y: 0 },
          1 / coordinateScale
        );
        session.updatedStrokes = resizedStrokes;
        session.changed = Math.abs(scale - 1) > 0.01;
        if (session.changed) {
          setRedoStrokes([]);
        }

        setStrokes((current) => [
          ...current.filter((stroke) => stroke.groupId !== session.groupId),
          ...resizedStrokes,
        ]);
        return;
      }

      const nextZoom = Math.max(
        0.5,
        Math.min(3, pinchStartRef.current * event.scale)
      );

      zoomRef.current = nextZoom;
      setZoom(nextZoom);
    },

    onFinalize: () => {
      if (isEditingSymbols) {
        finishImagePinch();
        finishSymbolPinch();
      }
    },
  });

  const canvasGesture = useSimultaneousGestures(
    drawGesture,
    boardPanGesture,
    zoomGesture
  );

  // renderStroke takes a stroke object and converts it into a visible Skia path.
  // This keeps the render code repeatable for both saved strokes and the live draft.
  const renderStroke = useCallback((
    stroke: Stroke,
    key: string,
    path = pointsToPath(stroke.points)
  ) => (
    <Path
      key={key}
      path={path}
      color={stroke.color}
      style="stroke"
      strokeWidth={stroke.width}
      strokeCap="round"
      strokeJoin="round"
      blendMode={stroke.eraser ? 'clear' : 'srcOver'}
    />
  ), []);
  const completedStrokePaths = useMemo(
    () => strokes.map((stroke) => pointsToPath(stroke.points)),
    [strokes]
  );
  const draftPath = useMemo(() => draft ? pointsToPath(draft.points) : null, [draft]);

  // Render consecutive strokes with a group ID into an isolated Skia layer. This
  // lets eraser strokes inside a placed symbol clear only that symbol, not the map.
  const completedStrokeElements = useMemo(() => {
    const rendered = [];
    let index = 0;

    while (index < strokes.length) {
      const stroke = strokes[index];
      if (!stroke.groupId) {
        rendered.push(
          renderStroke(stroke, `stroke-${index}`, completedStrokePaths[index])
        );
        index += 1;
        continue;
      }

      const groupId = stroke.groupId;
      const groupChildren = [];
      while (index < strokes.length && strokes[index].groupId === groupId) {
        groupChildren.push(
          renderStroke(
            strokes[index],
            `${groupId}-stroke-${index}`,
            completedStrokePaths[index]
          )
        );
        index += 1;
      }

      rendered.push(
        <Group key={groupId} layer>
          {groupChildren}
        </Group>
      );
    }

    return rendered;
  }, [completedStrokePaths, renderStroke, strokes]);

  const selectedSymbolOutline = useMemo(() => {
    if (!isEditingSymbols || !selectedGroupId) return null;

    const groupStrokes = strokes.filter(
      (stroke) => stroke.groupId === selectedGroupId
    );
    const bounds = getStrokeBounds(groupStrokes);
    if (!bounds) return null;

    // Keep the outline and its resize handles a consistent size as the map zooms.
    const padding = 8 / (zoom * coordinateScale);
    const outline = {
      left: bounds.left - padding,
      top: bounds.top - padding,
      right: bounds.right + padding,
      bottom: bounds.bottom + padding,
    };
    const path = Skia.PathBuilder.Make();
    path.moveTo(outline.left, outline.top);
    path.lineTo(outline.right, outline.top);
    path.lineTo(outline.right, outline.bottom);
    path.lineTo(outline.left, outline.bottom);
    path.close();

    return { outline, path: path.build() };
  }, [coordinateScale, isEditingSymbols, selectedGroupId, strokes, zoom]);

  const tileShapeOverlay = useMemo(() => {
    if (!surfaceShape || canvasSize.width <= 0 || canvasSize.height <= 0) return null;
    const width = canvasSize.width;
    const height = canvasSize.height;
    const outlinePoints: Point[] = surfaceShape === 'hexagon'
      ? [
          { x: width * 0.25, y: 0 }, { x: width * 0.75, y: 0 },
          { x: width, y: height * 0.5 }, { x: width * 0.75, y: height },
          { x: width * 0.25, y: height }, { x: 0, y: height * 0.5 },
        ]
      : [
          { x: width * 0.5, y: 0 }, { x: width, y: height }, { x: 0, y: height },
        ];
    const maskPolygons: Point[][] = surfaceShape === 'hexagon'
      ? [
          [{ x: 0, y: 0 }, { x: width * 0.25, y: 0 }, { x: 0, y: height * 0.5 }],
          [{ x: width * 0.75, y: 0 }, { x: width, y: 0 }, { x: width, y: height * 0.5 }],
          [{ x: width, y: height * 0.5 }, { x: width, y: height }, { x: width * 0.75, y: height }],
          [{ x: 0, y: height * 0.5 }, { x: 0, y: height }, { x: width * 0.25, y: height }],
        ]
      : [
          [{ x: 0, y: 0 }, { x: width * 0.5, y: 0 }, { x: 0, y: height }],
          [{ x: width * 0.5, y: 0 }, { x: width, y: 0 }, { x: width, y: height }],
        ];
    const buildClosedPath = (points: Point[]) => {
      const builder = Skia.PathBuilder.Make();
      points.forEach((point, index) => {
        if (index === 0) builder.moveTo(point.x, point.y);
        else builder.lineTo(point.x, point.y);
      });
      builder.close();
      return builder.build();
    };
    if (surfaceShape === 'circle') {
      const outside = Skia.PathBuilder.Make();
      outside.addRect({ x: 0, y: 0, width, height });
      outside.addOval({ x: 0, y: 0, width, height });
      outside.setFillType(FillType.EvenOdd);
      const circle = Skia.PathBuilder.Make();
      circle.addOval({ x: 0, y: 0, width, height });
      return { masks: [outside.build()], outline: circle.build() };
    }
    return {
      masks: maskPolygons.map(buildClosedPath),
      outline: buildClosedPath(outlinePoints),
    };
  }, [canvasSize.height, canvasSize.width, surfaceShape]);

  const renderTokenSupplyPlacement = (placement: TokenSupplyPlacement, selected = false) => {
    const transformScale = zoom * coordinateScale;
    const tokenSize = getBoardTileSize(placement.token);
    const width = tokenSize.width * transformScale;
    const height = tokenSize.height * transformScale;
    const left = placement.x * transformScale + boardOffset.x - width / 2;
    const top = placement.y * transformScale + boardOffset.y - height / 2;
    return (
      <View
        key={`token-supply-${placement.id}`}
        pointerEvents="none"
        style={[
          drawingCanvasStyles.tokenSupplyMarker,
          selected && drawingCanvasStyles.selectedTokenMarker,
          { left, top, width, height, transform: [{ rotate: `${placement.orientation}deg` }] },
        ]}
      >
        <BoardTileArtworkPreview
          tile={placement.token}
          width={width}
          height={height}
          faceUp
        />
        <View style={[drawingCanvasStyles.tokenSupplyQuantity, {
          left: width + 4,
          top: height / 2 - 14,
          width: Math.max(34, String(placement.quantity ?? '∞').length * 10 + 14),
          height: 28,
          borderRadius: 14,
        }]}>
          <Text style={drawingCanvasStyles.tokenSupplyQuantityText}>
            {placement.quantity === null ? '∞' : placement.quantity}
          </Text>
        </View>
      </View>
    );
  };

  // Standalone tokens show the saved front art and have no supply-count badge.
  const renderBoardTokenPlacement = (placement: BoardTokenPlacement, selected = false) => {
    const transformScale = zoom * coordinateScale;
    const tokenSize = getBoardTileSize(placement.token);
    const width = tokenSize.width * transformScale;
    const height = tokenSize.height * transformScale;
    const left = placement.x * transformScale + boardOffset.x - width / 2;
    const top = placement.y * transformScale + boardOffset.y - height / 2;
    const isBeingDragged = gameplayMode && activeGameplayDragKey === `token-${placement.id}`;
    return (
      <Animated.View
        key={`board-token-${placement.id}`}
        pointerEvents="none"
        style={[{
          position: 'absolute', left, top, width, height,
          zIndex: selected ? 10 : 8, elevation: selected ? 10 : 8,
        }, isBeingDragged && activePieceDragStyle]}
      >
        <View style={[{
          width, height, alignItems: 'center', justifyContent: 'center',
          // Keep transform an array in both states; React Native's style diff
          // expects an array when switching an animated piece in and out.
          transform: isBeingDragged ? [] : [{ rotate: `${placement.orientation}deg` }],
        }, selected && drawingCanvasStyles.selectedTokenMarker]}>
          <BoardTileArtworkPreview tile={placement.token} width={width} height={height} faceUp={placement.faceUp} />
        </View>
      </Animated.View>
    );
  };

  const renderBoardDiePlacement = (placement: BoardDiePlacement, selected = false) => {
    const transformScale = zoom * coordinateScale;
    const faceTile = getDieFaceTile(placement.die, placement.faceNumber);
    const faceSize = getBoardTileSize(faceTile);
    const width = faceSize.width * transformScale;
    const height = faceSize.height * transformScale;
    const left = placement.x * transformScale + boardOffset.x - width / 2;
    const top = placement.y * transformScale + boardOffset.y - height / 2;
    return (
      <View key={`board-die-${placement.id}`} pointerEvents="none" style={[
        drawingCanvasStyles.tokenSupplyMarker,
        selected && drawingCanvasStyles.selectedTokenMarker,
        { left, top, width, height, transform: [{ rotate: `${placement.orientation}deg` }] },
      ]}>
        <BoardTileArtworkPreview tile={faceTile} width={width} height={height} faceUp />
      </View>
    );
  };

  const renderBoardTilePlacement = (
    placement: { id?: number; x: number; y: number; orientation: number; faceUp: boolean; tile: BoardTileVisual | null; deckId: number | null; deckName: string | null; tileCount: number },
    ghost = false,
    selected = false
  ) => {
    const transformScale = zoom * coordinateScale;
    const tileSize = getBoardTileSize(placement.tile);
    const width = placement.tile ? tileSize.width * transformScale : 92 * transformScale;
    const height = placement.tile ? tileSize.height * transformScale : 56 * transformScale;
    const left = placement.x * transformScale + boardOffset.x - width / 2;
    const top = placement.y * transformScale + boardOffset.y - height / 2;
    const isGameplayDragPreview = gameplayMode && ghost && activeGameplayDragKey !== null
      && activeGameplayDragKey.startsWith('tile-');
    return (
      <Animated.View
        key={ghost ? 'tile-placement-ghost' : `board-tile-placement-${placement.id}`}
        pointerEvents="none"
        style={[
          drawingCanvasStyles.boardTilePlacement,
          selected && drawingCanvasStyles.selectedBoardTilePlacement,
          {
            left,
            top,
            width,
            height,
            opacity: ghost && !isGameplayDragPreview ? 0.55 : 1,
          },
          isGameplayDragPreview && activePieceDragStyle,
        ]}
      >
        <View style={{
          width, height, alignItems: 'center', justifyContent: 'center',
          transform: isGameplayDragPreview ? [] : [{ rotate: `${placement.orientation}deg` }],
        }}>
        {placement.deckId !== null && placement.tile && (
          (placement.tile.shape === 'square' || placement.tile.shape === 'circle') && (
            <View style={[
              drawingCanvasStyles.tileDeckStackLayer,
              { width, height, borderRadius: placement.tile.shape === 'circle' ? Math.max(width, height) / 2 : 0 },
            ]} />
          )
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
        {ghost && tilePlacementPreview?.snapped && (
          <View style={drawingCanvasStyles.snappedTileBadge}><Text style={drawingCanvasStyles.snappedTileBadgeText}>Snap</Text></View>
        )}
        </View>
      </Animated.View>
    );
  };

  return (
    <View
      ref={rootViewRef}
      style={[
        drawingCanvasStyles.matCanvas,
        {
          backgroundColor: transparentBackground
            ? 'transparent'
            : backgroundColor,
        },
      ]}
>
      {/* This is the touchable drawing area. The PanResponder is attached to it so every
          drag creates points that become part of a stroke. */}
      <GestureDetector gesture={canvasGesture}>
        <View
          style={drawingCanvasStyles.drawingTouchArea}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setCanvasSize((current) =>
              current.width === width && current.height === height
                ? current
                : { width, height }
            );
          }}
        >
          {surfaceBackgroundImage && (
            <Image
              pointerEvents="none"
              source={{
                uri: `data:${surfaceBackgroundImage.mimeType};base64,${surfaceBackgroundImage.base64Data}`,
              }}
              resizeMode="cover"
              style={StyleSheet.absoluteFill}
            />
          )}
          <Canvas style={StyleSheet.absoluteFill}>
            <Group
              transform={[
                { translateX: boardOffset.x },
                { translateY: boardOffset.y },
                { scale: zoom * coordinateScale },
              ]}
            >
              {completedStrokeElements}

              {draft && renderStroke(draft, 'draft', draftPath ?? undefined)}

              {selectedSymbolOutline && (
                <>
                  <Path
                    path={selectedSymbolOutline.path}
                    color="#315EFB"
                    style="stroke"
                    strokeWidth={2 / (zoom * coordinateScale)}
                  />
                  {[
                    [selectedSymbolOutline.outline.left, selectedSymbolOutline.outline.top],
                    [selectedSymbolOutline.outline.right, selectedSymbolOutline.outline.top],
                    [selectedSymbolOutline.outline.right, selectedSymbolOutline.outline.bottom],
                    [selectedSymbolOutline.outline.left, selectedSymbolOutline.outline.bottom],
                  ].map(([cx, cy], index) => (
                    <Circle
                      key={`symbol-handle-${index}`}
                      cx={cx}
                      cy={cy}
                      r={5 / (zoom * coordinateScale)}
                      color="#FFFFFF"
                      style="stroke"
                      strokeWidth={2 / (zoom * coordinateScale)}
                    />
                  ))}
                </>
              )}

              {isErasing && eraserPosition && (
                <Circle
                  cx={eraserPosition.x}
                  cy={eraserPosition.y}
                  r={lineWidth / (2 * coordinateScale)}
                  color="#111827"
                  style="stroke"
                  strokeWidth={1.5 / coordinateScale}
                />
              )}
            </Group>
          </Canvas>

          {/* Image views follow the same zoom and pan values as Skia strokes. */}
          {placedImages.map((image) => {
            const transformScale = zoom * coordinateScale;
            const width = image.width * transformScale;
            const height = image.height * transformScale;
            const left = image.center.x * transformScale + boardOffset.x - width / 2;
            const top = image.center.y * transformScale + boardOffset.y - height / 2;

            return (
              <Image
                key={`surface-image-${image.id}`}
                pointerEvents="none"
                source={{ uri: `data:${image.mimeType};base64,${image.base64Data}` }}
                resizeMode="contain"
                style={{ position: 'absolute', left, top, width, height }}
              />
            );
          })}

          {/* This card-shaped marker uses its saved rotation as the deck's facing. */}
          {deckSpots.map((spot) => {
            const transformScale = zoom * coordinateScale;
            const cardSize = getDeckSpotSize(spot);
            const markerWidth = cardSize.width * transformScale;
            const markerHeight = cardSize.height * transformScale;
            const left = spot.x * transformScale + boardOffset.x - markerWidth / 2;
            const top = spot.y * transformScale + boardOffset.y - markerHeight / 2;
            const isSelected = isEditingSymbols && spot.id === selectedDeckSpotId;
            const cardPreviewSurface = spot.topCard
              ? spot.faceUp
                ? spot.topCard.frontSurfaceId
                : spot.topCard.backSurfaceId ?? spot.topCard.frontSurfaceId
              : null;

            return (
              <View
                key={`deck-spot-${spot.id}`}
                pointerEvents="none"
                style={[
                  drawingCanvasStyles.deckSpotMarker,
                  isSelected && drawingCanvasStyles.selectedDeckSpotMarker,
                  {
                    left,
                    top,
                    width: markerWidth,
                    height: markerHeight,
                    transform: [{ rotate: `${spot.orientation}deg` }],
                  },
                ]}
              >
                {cardPreviewSurface && spot.topCard ? (
                  <DeckSpotCardPreview
                    surfaceId={cardPreviewSurface}
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
          })}

          {/* A dragged card follows the finger while the physical pile remains in place. */}
          {gameplayMode && deckCardDragPreview?.spot.topCard && (() => {
            const { spot } = deckCardDragPreview;
            const card = spot.topCard!;
            const transformScale = zoom * coordinateScale;
            const size = getDeckSpotSize(spot);
            const width = size.width * transformScale;
            const height = size.height * transformScale;
            const left = deckCardDragPreview.startPoint.x * transformScale + boardOffset.x - width / 2;
            const top = deckCardDragPreview.startPoint.y * transformScale + boardOffset.y - height / 2;
            const surfaceId = gameplayDrawFaceUp
              ? card.frontSurfaceId
              : card.backSurfaceId ?? card.frontSurfaceId;
            return (
              <Animated.View
                pointerEvents="none"
                style={[
                  drawingCanvasStyles.deckSpotMarker,
                  { position: 'absolute', left, top, width, height, zIndex: 20, elevation: 8, opacity: 0.92 },
                  activePieceDragStyle,
                ]}
              >
                <DeckSpotCardPreview
                  surfaceId={surfaceId}
                  width={width - 4}
                  height={height - 4}
                  cardWidth={card.widthInches}
                  cardHeight={card.heightInches}
                />
              </Animated.View>
            );
          })()}

          {/* Each snap point stays a small anchor on screen; its arrow shows the
              saved orientation and rotates with the point. */}
          {tileSnapPoints.map((point) => {
            const transformScale = zoom * coordinateScale;
            const markerSize = 32 * transformScale;
            const isSelected = isEditingSymbols && point.id === selectedTileSnapPointId;
            return (
              <View
                key={`tile-snap-${point.id}`}
                pointerEvents="none"
                style={[
                  drawingCanvasStyles.tileSnapPoint,
                  isSelected && drawingCanvasStyles.selectedTileSnapPoint,
                  {
                    left: point.x * transformScale + boardOffset.x - markerSize / 2,
                    top: point.y * transformScale + boardOffset.y - markerSize / 2,
                    width: markerSize,
                    height: markerSize,
                    transform: [{ rotate: `${point.orientation}deg` }],
                  },
                ]}
              >
                <View style={drawingCanvasStyles.snapPointArrow} />
                <View style={drawingCanvasStyles.snapPointArrowHead} />
                <View style={drawingCanvasStyles.snapPointDot} />
              </View>
            );
          })}

          {boardTilePlacements
            .filter((placement) => !(gameplayMode && activeGameplayDragKey === `tile-${placement.id}`))
            .map((placement) => renderBoardTilePlacement(
            placement,
            false,
            ((isEditingSymbols || gameplayMode) && placement.id === selectedBoardTilePlacementId)
              || (gameplayMode && placement.deckId === gameplayTileDeckChoice)
          ))}
          {tilePlacementPreview && renderBoardTilePlacement(tilePlacementPreview, true)}
          {gameplayMode && gameplayTakePreview && (() => {
            const scale = zoom * coordinateScale;
            const size = getBoardTileSize(gameplayTakePreview.tile);
            const width = size.width * scale;
            const height = size.height * scale;
            return (
              <Animated.View
                pointerEvents="none"
                style={[{
                  position: 'absolute',
                  left: gameplayTakePreview.startPoint.x * scale + boardOffset.x - width / 2,
                  top: gameplayTakePreview.startPoint.y * scale + boardOffset.y - height / 2,
                  width, height, opacity: 0.78, zIndex: 20, elevation: 20,
                }, activePieceDragStyle]}
              >
                <BoardTileArtworkPreview tile={gameplayTakePreview.tile} width={width} height={height} faceUp />
              </Animated.View>
            );
          })()}
          {tokenSupplyPlacements.map((placement) => renderTokenSupplyPlacement(
            placement, (isEditingSymbols && placement.id === selectedTokenSupplyId)
              || (gameplayMode && placement.id === gameplayTokenSupplyChoice)
          ))}
          {boardTokenPlacements.map((placement) => renderBoardTokenPlacement(
            placement, (isEditingSymbols || gameplayMode) && placement.id === selectedBoardTokenId
          ))}
          {boardDiePlacements.map((placement) => renderBoardDiePlacement(
            placement,
            (isEditingSymbols && placement.id === selectedBoardDieId)
              || (gameplayMode && selectedGameplayDieIds.includes(placement.id))
          ))}

          {isEditingSymbols && selectedImageId !== null && (() => {
            const selectedImage = placedImages.find(
              (image) => image.id === selectedImageId
            );
            if (!selectedImage) return null;

            const transformScale = zoom * coordinateScale;
            const width = selectedImage.width * transformScale;
            const height = selectedImage.height * transformScale;
            const left = selectedImage.center.x * transformScale + boardOffset.x - width / 2;
            const top = selectedImage.center.y * transformScale + boardOffset.y - height / 2;
            const corners = [
              { left, top },
              { left: left + width, top },
              { left: left + width, top: top + height },
              { left, top: top + height },
            ];

            return (
              <>
                <View
                  pointerEvents="none"
                  style={[
                    drawingCanvasStyles.imageSelectionFrame,
                    { left, top, width, height },
                  ]}
                />
                {corners.map((corner, index) => (
                  <View
                    key={`image-handle-${selectedImage.id}-${index}`}
                    pointerEvents="none"
                    style={[
                      drawingCanvasStyles.imageSelectionHandle,
                      { left: corner.left - 5, top: corner.top - 5 },
                    ]}
                  />
                ))}
              </>
            );
          })()}

        </View>
      </GestureDetector>

      {/* Apply the polygon cutout against the measured canvas host, not the
          gesture child's content bounds. This keeps the whole drawing surface
          hidden outside the tile, including marks that continue past an edge. */}
      {tileShapeOverlay && (
        <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
          {tileShapeOverlay.masks.map((path, index) => (
            <Path key={`tile-shape-mask-${index}`} path={path} color="#E5E7EB" />
          ))}
          <Path path={tileShapeOverlay.outline} color="#6B7280" style="stroke" strokeWidth={2} />
        </Canvas>
      )}

      {placementSymbolId !== undefined && (
        <View style={drawingCanvasStyles.placementHint}>
          <Text style={drawingCanvasStyles.placementHintText}>
            {placementSymbolData?.id !== placementSymbolId
              ? `Loading ${placementSymbolName ?? 'symbol'}…`
              : placementSymbolData.strokes.length === 0
                ? `${placementSymbolName ?? 'This symbol'} has no artwork yet. Edit it before placing.`
                : repeatSymbolPlacement
                  ? `Tap the map to place ${placementSymbolName ?? 'symbol'} multiple times.`
                  : `Tap the map to place ${placementSymbolName ?? 'symbol'}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={repeatSymbolPlacement ? 'Finish symbol placement' : 'Cancel symbol placement'}
            style={drawingCanvasStyles.placementCancelButton}
            onPress={() => onSymbolPlaced?.()}
          >
            <Text>{repeatSymbolPlacement ? 'Done' : 'Cancel'}</Text>
          </Pressable>
        </View>
      )}

      {placementDeckSpot !== undefined && (
        <View style={drawingCanvasStyles.placementHint}>
          <Text style={drawingCanvasStyles.placementHintText}>
            {placementDeckSpot.spotType === 'deck'
              ? 'Tap the map to place this saved deck multiple times.'
              : 'Tap the map to place empty discard spots multiple times.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Finish deck spot placement"
            style={drawingCanvasStyles.placementCancelButton}
            onPress={() => onCancelDeckSpotPlacement?.()}
          >
            <Text>Done</Text>
          </Pressable>
        </View>
      )}

      {placementTileSnapPoint && (
        <View style={drawingCanvasStyles.placementHint}>
          <Text style={drawingCanvasStyles.placementHintText}>Tap the map to add oriented tile snap points. Tap Done when finished.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Finish tile snap point placement"
            style={drawingCanvasStyles.placementCancelButton}
            onPress={() => onCancelTileSnapPointPlacement?.()}
          >
            <Text>Done</Text>
          </Pressable>
        </View>
      )}

      {placementTokenSupply && (
        <View style={drawingCanvasStyles.placementHint}>
          <Text style={drawingCanvasStyles.placementHintText}>
            Tap the map to place {placementTokenSupply.token.name} supplies multiple times.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Finish token supply placement"
            style={drawingCanvasStyles.placementCancelButton}
            onPress={() => onCancelTokenSupplyPlacement?.()}
          >
            <Text>Done</Text>
          </Pressable>
        </View>
      )}

      {placementToken && (
        <View style={drawingCanvasStyles.placementHint}>
          <Text style={drawingCanvasStyles.placementHintText}>
            Tap the map to place {placementToken.name} tokens multiple times.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Finish token placement"
            style={drawingCanvasStyles.placementCancelButton}
            onPress={() => onCancelTokenPlacement?.()}
          >
            <Text>Done</Text>
          </Pressable>
        </View>
      )}

      {placementDie && (
        <View style={drawingCanvasStyles.placementHint}>
          <Text style={drawingCanvasStyles.placementHintText}>
            Tap the board to place {placementDie.name} showing side 1. Use Move to change the side shown.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Finish die placement"
            style={drawingCanvasStyles.placementCancelButton}
            onPress={() => onCancelDiePlacement?.()}
          >
            <Text>Done</Text>
          </Pressable>
        </View>
      )}

      {(placementTile !== undefined || placementTileDeck !== undefined) && (
        <View style={drawingCanvasStyles.placementHint}>
          <Text style={drawingCanvasStyles.placementHintText}>
            {placementTileDeck
              ? `Drag and release to place ${placementTileDeck.name} multiple times${tileSnapPoints.length ? ' on nearby snap points' : ''}.`
              : `Drag and release to place ${placementTile?.name ?? 'tile'} multiple times${tileSnapPoints.length ? ' on nearby snap points' : ''}.`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Finish tile placement"
            style={drawingCanvasStyles.placementCancelButton}
            onPress={() => onCancelTilePlacement?.()}
          >
            <Text>Done</Text>
          </Pressable>
        </View>
      )}

      {gameplayMode && gameplayTakePreview === null && gameplayTokenSupplyChoice !== null && (
        <View style={[drawingCanvasStyles.placementHint, { top: topInset + 98, zIndex: 60, elevation: 60 }]}>
          <Text style={drawingCanvasStyles.placementHintText}>Tap a destination, or drag directly from the supply to place one token.</Text>
          <Pressable accessibilityRole="button" style={drawingCanvasStyles.placementCancelButton} onPress={() => setGameplayTokenSupplyChoice(null)}>
            <Text>Cancel</Text>
          </Pressable>
        </View>
      )}
      {gameplayMode && gameplayTakePreview === null && gameplayTileDeckChoice !== null && (
        <View style={[drawingCanvasStyles.placementHint, { top: topInset + 98, zIndex: 60, elevation: 60 }]}>
          <Text style={drawingCanvasStyles.placementHintText}>Tap a destination, or drag directly from the deck to place its next tile.</Text>
          <Pressable accessibilityRole="button" style={drawingCanvasStyles.placementCancelButton} onPress={() => setGameplayTileDeckChoice(null)}>
            <Text>Cancel</Text>
          </Pressable>
        </View>
      )}

      {surfaceId !== undefined && placementSymbolId === undefined &&
        ((isEditingSymbols && !gameplayMode) || (gameplayMode && (selectedBoardToken || selectedBoardTilePlacement || selectedGameplayDieIds.length > 0))) && (
        <View style={[drawingCanvasStyles.moveControls, {
          // The play header is rendered in a sibling overlay above this canvas.
          // Put gameplay actions just below it and give them a higher native
          // stacking order so Game and Done don't cover the piece controls.
          top: gameplayMode ? topInset + 56 : topInset,
          ...(gameplayMode ? { zIndex: 60, elevation: 60 } : {}),
        }]}>
          {gameplayMode && selectedGameplayDieIds.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Roll ${selectedGameplayDieIds.length} selected ${selectedGameplayDieIds.length === 1 ? 'die' : 'dice'}`}
              style={drawingCanvasStyles.moveControlButton}
              onPress={rollSelectedGameplayDice}
            >
              <Text style={drawingCanvasStyles.moveControlButtonText}>
                Roll {selectedGameplayDieIds.length} {selectedGameplayDieIds.length === 1 ? 'Die' : 'Dice'}
              </Text>
            </Pressable>
          )}
          {(selectedBoardToken || (!gameplayMode && (selectedTokenSupply || selectedBoardDie))) && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={selectedBoardDie ? 'Rotate selected die clockwise' : selectedBoardToken ? 'Rotate selected token clockwise' : 'Rotate selected token supply clockwise'}
                style={drawingCanvasStyles.moveControlButton}
                onPress={rotateSelectedTokenMarker}
              >
                <Text style={drawingCanvasStyles.moveControlButtonText}>Rotate</Text>
              </Pressable>
              {selectedBoardToken?.token.backSurfaceId && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={selectedBoardToken.faceUp ? 'Flip selected token to its back' : 'Flip selected token to its front'}
                  style={drawingCanvasStyles.moveControlButton}
                  onPress={flipSelectedBoardToken}
                >
                  <Text style={drawingCanvasStyles.moveControlButtonText}>Flip</Text>
                </Pressable>
              )}
              {selectedBoardDie && <>
                <Pressable accessibilityRole="button" accessibilityLabel="Show previous die side" style={drawingCanvasStyles.moveControlButton} onPress={() => changeSelectedDieFace(-1)}>
                  <Text style={drawingCanvasStyles.moveControlButtonText}>‹ Face</Text>
                </Pressable>
                <View style={drawingCanvasStyles.moveControlButton}>
                  <Text style={drawingCanvasStyles.moveControlButtonText}>{selectedBoardDie.faceNumber}/{selectedBoardDie.die.sideCount}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Show next die side" style={drawingCanvasStyles.moveControlButton} onPress={() => changeSelectedDieFace(1)}>
                  <Text style={drawingCanvasStyles.moveControlButtonText}>Face ›</Text>
                </Pressable>
              </>}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gameplayMode && selectedBoardToken
                  ? 'Return selected token to its supply'
                  : selectedBoardDie ? 'Remove selected die' : selectedBoardToken ? 'Remove selected token' : 'Remove selected token supply'}
                style={drawingCanvasStyles.moveControlButton}
                onPress={gameplayMode && selectedBoardToken ? returnSelectedTokenToSupply : removeSelectedTokenMarker}
              >
                <Text style={drawingCanvasStyles.moveControlButtonText}>
                  {gameplayMode && selectedBoardToken ? 'Return to Supply' : 'Remove'}
                </Text>
              </Pressable>
            </>
          )}
          {selectedBoardTilePlacement && (
            <>
              {!gameplayMode && selectedBoardTilePlacement.tileId !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Change selected tile type"
                  style={drawingCanvasStyles.moveControlButton}
                  onPress={() => onBoardTileTypeChangeRequested?.(selectedBoardTilePlacement.id)}
                >
                  <Text style={drawingCanvasStyles.moveControlButtonText}>Tile Type</Text>
                </Pressable>
              )}
              {(!gameplayMode || selectedBoardTilePlacement.tileId !== null)
                && selectedBoardTilePlacement.tile?.backSurfaceId && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={selectedBoardTilePlacement.faceUp ? 'Flip selected tile to its back' : 'Flip selected tile to its front'}
                  style={drawingCanvasStyles.moveControlButton}
                  onPress={flipSelectedBoardTile}
                >
                  <Text style={drawingCanvasStyles.moveControlButtonText}>Flip</Text>
                </Pressable>
              )}
              <Pressable accessibilityRole="button" accessibilityLabel="Rotate selected tile" style={drawingCanvasStyles.moveControlButton} onPress={rotateSelectedBoardTile}>
                <Text style={drawingCanvasStyles.moveControlButtonText}>Rotate</Text>
              </Pressable>
              {gameplayMode && selectedBoardTilePlacement.tileId !== null ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Return selected tile to a deck"
                  style={drawingCanvasStyles.moveControlButton}
                  onPress={() => void returnSelectedBoardTileToDeck()}
                >
                  <Text style={drawingCanvasStyles.moveControlButtonText}>Return to Deck</Text>
                </Pressable>
              ) : !gameplayMode ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Remove selected tile or deck" style={drawingCanvasStyles.moveControlButton} onPress={removeSelectedBoardTile}>
                  <Text style={drawingCanvasStyles.moveControlButtonText}>Remove</Text>
                </Pressable>
              ) : null}
            </>
          )}
          {!gameplayMode && selectedTileSnapPoint && (
            <>
              <Pressable accessibilityRole="button" accessibilityLabel="Rotate selected tile snap point" style={drawingCanvasStyles.moveControlButton} onPress={rotateSelectedSnapPoint}>
                <Text style={drawingCanvasStyles.moveControlButtonText}>Rotate</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Remove selected tile snap point" style={drawingCanvasStyles.moveControlButton} onPress={removeSelectedSnapPoint}>
                <Text style={drawingCanvasStyles.moveControlButtonText}>Remove</Text>
              </Pressable>
            </>
          )}
          {!gameplayMode && selectedDeckSpot && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Rotate selected deck spot clockwise"
                style={drawingCanvasStyles.moveControlButton}
                onPress={rotateSelectedDeckSpot}
              >
                <Text style={drawingCanvasStyles.moveControlButtonText}>Rotate</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove selected deck spot"
                style={drawingCanvasStyles.moveControlButton}
                onPress={removeSelectedDeckSpot}
              >
                <Text style={drawingCanvasStyles.moveControlButtonText}>Remove</Text>
              </Pressable>
            </>
          )}
          {!gameplayMode && selectedImageId !== null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove selected image"
              style={drawingCanvasStyles.moveControlButton}
              onPress={removeSelectedImage}
            >
              <Text style={drawingCanvasStyles.moveControlButtonText}>Remove</Text>
            </Pressable>
          )}
          {!gameplayMode && selectedGroupId !== null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove selected placed symbol"
              style={drawingCanvasStyles.moveControlButton}
              onPress={removeSelectedSymbol}
            >
              <Text style={drawingCanvasStyles.moveControlButtonText}>Remove Symbol</Text>
            </Pressable>
          )}
          {!gameplayMode && allowImageAsBackground && selectedImageId !== null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Set selected image as card background"
              style={drawingCanvasStyles.moveControlButton}
              onPress={setSelectedImageAsBackground}
            >
              <Text style={drawingCanvasStyles.moveControlButtonText}>Set Background</Text>
            </Pressable>
          )}
          {!gameplayMode && allowImageAsBackground && surfaceBackgroundImage && selectedImageId === null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove card background image"
              style={drawingCanvasStyles.moveControlButton}
              onPress={clearSurfaceBackgroundImage}
            >
              <Text style={drawingCanvasStyles.moveControlButtonText}>Clear BG</Text>
            </Pressable>
          )}
          {!gameplayMode && <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done moving symbols"
            style={[drawingCanvasStyles.moveControlButton, drawingCanvasStyles.doneMoveButton]}
            onPress={() => onStopEditingSymbols?.()}
          >
            <Text style={[drawingCanvasStyles.moveControlButtonText, drawingCanvasStyles.doneMoveButtonText]}>Done</Text>
          </Pressable>}
        </View>
      )}

      {/* All controls stay in one fixed row. There is no horizontal ScrollView here,
          so the slider's horizontal gesture can only change brush width. */}
      {!gameplayMode && <View
        style={[
          drawingCanvasStyles.toolbarPosition,
          hexagonToolbar && drawingCanvasStyles.hexagonToolbarPosition,
          expandCompactToolbar && {
            left: Math.min(12, (canvasSize.width - 250) / 2),
            right: Math.min(12, (canvasSize.width - 250) / 2),
          },
          { bottom: bottomInset + 12 },
        ]}
      >
        <View
          style={[
            drawingCanvasStyles.toolbarPanel,
            compactToolbar && drawingCanvasStyles.compactToolbarPanel,
          hexagonToolbar && drawingCanvasStyles.hexagonToolbarPanel,
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Undo last stroke"
            accessibilityState={{ disabled: strokes.length === 0 }}
            disabled={strokes.length === 0}
            style={[
              drawingCanvasStyles.historyButton,
              compactToolbar && drawingCanvasStyles.compactHistoryButton,
              hexagonToolbar && drawingCanvasStyles.hexagonHistoryButton,
              strokes.length === 0 && drawingCanvasStyles.historyButtonDisabled,
            ]}
            onPress={undoStroke}
          >
            <Text
              style={[
                drawingCanvasStyles.historyButtonText,
                compactToolbar && drawingCanvasStyles.compactHistoryButtonText,
                hexagonToolbar && drawingCanvasStyles.hexagonHistoryButtonText,
                strokes.length === 0 && drawingCanvasStyles.historyButtonDisabledText,
              ]}
            >
              Undo
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Redo last undone stroke"
            accessibilityState={{ disabled: redoStrokes.length === 0 }}
            disabled={redoStrokes.length === 0}
            style={[
              drawingCanvasStyles.historyButton,
              compactToolbar && drawingCanvasStyles.compactHistoryButton,
              hexagonToolbar && drawingCanvasStyles.hexagonHistoryButton,
              redoStrokes.length === 0 && drawingCanvasStyles.historyButtonDisabled,
            ]}
            onPress={redoStroke}
          >
            <Text
              style={[
                drawingCanvasStyles.historyButtonText,
                compactToolbar && drawingCanvasStyles.compactHistoryButtonText,
                hexagonToolbar && drawingCanvasStyles.hexagonHistoryButtonText,
                redoStrokes.length === 0 && drawingCanvasStyles.historyButtonDisabledText,
              ]}
            >
              Redo
            </Text>
          </Pressable>

          {!transparentBackground && (
            <Pressable
              accessibilityRole="button"
            accessibilityLabel="Choose canvas background color"
              style={[
              drawingCanvasStyles.backgroundColorButton,
              compactToolbar && drawingCanvasStyles.compactColorButton,
              hexagonToolbar && drawingCanvasStyles.hexagonColorButton,
                { backgroundColor },
              ]}
              onPress={() => setColorPickerTarget('background')}
            />
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose pen color"
            style={[
              drawingCanvasStyles.backgroundColorButton,
              compactToolbar && drawingCanvasStyles.compactColorButton,
              hexagonToolbar && drawingCanvasStyles.hexagonColorButton,
              { backgroundColor: penColor },
            ]}
            onPress={() => setColorPickerTarget('pen')}
          />

          <Slider
            accessibilityLabel="Line width"
            style={[
              drawingCanvasStyles.lineWidthSlider,
              compactToolbar && drawingCanvasStyles.compactLineWidthSlider,
              hexagonToolbar && drawingCanvasStyles.hexagonLineWidthSlider,
            ]}
            minimumValue={1}
            maximumValue={50}
            step={1}
            value={lineWidth}
            onValueChange={setLineWidth}
            minimumTrackTintColor="#315EFB"
            maximumTrackTintColor="#9CA3AF"
            thumbTintColor="#111827"
          />

          {!compactToolbar && (
            <View style={drawingCanvasStyles.previewSlot}>
              <View
                style={[
                  drawingCanvasStyles.brushPreview,
                  isErasing && drawingCanvasStyles.eraserPreview,
                  {
                    width: lineWidth,
                    height: lineWidth,
                    borderRadius: lineWidth / 2,
                    backgroundColor: isErasing ? 'transparent' : penColor,
                  },
                ]}
              />
            </View>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isErasing ? 'Use pen' : 'Use eraser'}
            style={[
              drawingCanvasStyles.eraserButton,
              compactToolbar && drawingCanvasStyles.compactEraserButton,
              hexagonToolbar && drawingCanvasStyles.hexagonEraserButton,
              isErasing && drawingCanvasStyles.selectedTool,
            ]}
            onPress={() => setIsErasing((erasing) => !erasing)}
          >
            <Text style={hexagonToolbar ? drawingCanvasStyles.hexagonEraserText : undefined}>
              {hexagonToolbar ? (isErasing ? 'Erase ✓' : 'Erase') : (isErasing ? 'Eraser ✓' : 'Eraser')}
            </Text>
          </Pressable>
        </View>
      </View>}

      {/* The color picker is a modal popup that appears when the user taps a color swatch.
          It lets them choose the board or pen color without leaving the drawing screen. */}
      <Modal
        visible={colorPickerTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setColorPickerTarget(null)}
      >
        <View style={drawingCanvasStyles.colorPickerBackdrop}>
          <View style={drawingCanvasStyles.colorPickerDialog}>
            <Text style={styles.menuTitle}>
              {colorPickerTarget === 'pen' ? 'Pen color' : 'Canvas background'}
            </Text>

            <ColorPicker
              value={colorPickerTarget === 'pen' ? penColor : backgroundColor}
              onCompleteJS={({ hex }) => {
                // When the user picks a color, update the correct setting.
                if (colorPickerTarget === 'pen') {
                  setPenColor(hex);
                } else {
                  setBackgroundColor(hex);
                  if (surfaceId !== undefined) {
                    enqueueDatabaseAction(async () => {
                      await db.runAsync(
                        'UPDATE drawing_surfaces SET background_color = ? WHERE id = ?',
                        hex,
                        surfaceId
                      );
                    }, 'Could not save board background color:');
                  }
                }
              }}
              style={drawingCanvasStyles.colorPicker}
            >
              <Preview style={drawingCanvasStyles.colorPickerPreview} />
              <Panel3 style={drawingCanvasStyles.colorWheel} />
              <BrightnessSlider style={drawingCanvasStyles.colorWheelSlider} />
            </ColorPicker>

            <Pressable
              style={drawingCanvasStyles.colorPickerDone}
              onPress={() => setColorPickerTarget(null)}
            >
              <Text style={styles.buttonText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
});

// Renders a saved tile face at its physical shape and aspect ratio on the board.
export const BoardTileArtworkPreview = memo(function BoardTileArtworkPreview({
  tile,
  width,
  height,
  faceUp,
  selected = false,
}: {
  tile: BoardTileVisual;
  width: number;
  height: number;
  faceUp: boolean;
  selected?: boolean;
}) {
  const db = useSQLiteContext();
  const artworkSurfaceId = !faceUp && tile.backSurfaceId
    ? tile.backSurfaceId
    : tile.frontSurfaceId;
  const [artwork, setArtwork] = useState<{
    backgroundColor: string;
    backgroundImage: { base64Data: string; mimeType: string } | null;
    strokes: Stroke[];
    images: PlacedImage[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArtwork(null);
    const loadArtwork = async () => {
      try {
        const loaded = await loadSurfaceArtwork(db, artworkSurfaceId);
        if (!cancelled) setArtwork({ ...loaded, backgroundColor: loaded.backgroundColor ?? tile.color });
      } catch (error) {
        console.error('Could not load tile artwork for the board:', error);
      }
    };
    void loadArtwork();
    return () => { cancelled = true; };
  }, [artworkSurfaceId, db, tile.color]);

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
    if (!artwork) return null;
    const decode = (base64Data: string) => {
      try {
        return Skia.Image.MakeImageFromEncoded(Skia.Data.fromBase64(base64Data));
      } catch (error) {
        console.warn('Could not decode tile artwork image:', error);
        return null;
      }
    };
    return {
      backgroundImage: artwork.backgroundImage ? decode(artwork.backgroundImage.base64Data) : null,
      images: artwork.images.map((image) => ({ ...image, decoded: decode(image.base64Data) })),
    };
  }, [artwork]);
  // Build saved paths once per artwork load instead of rebuilding all tile
  // strokes whenever a neighboring piece or board control re-renders.
  const artworkStrokePaths = useMemo(
    () => artwork?.strokes.map((stroke) => pointsToPath(stroke.points)) ?? [],
    [artwork?.strokes]
  );

  const outlineColor = selected ? '#315EFB' : '#4B5563';
  return (
    <View pointerEvents="none" style={{
      width,
      height,
      backgroundColor: 'transparent',
    }}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Mask mask={<Path path={tileShapePath} color="#FFFFFF" />} mode="alpha">
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
        </Mask>
      </Canvas>
      <Canvas style={StyleSheet.absoluteFill}>
        <Mask mask={<Path path={tileShapePath} color="#FFFFFF" />} mode="alpha">
          <Group transform={[{ scale: pixelScale }]}>
            {artwork?.strokes.map((stroke, index) => (
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
        </Mask>
      </Canvas>
      <Canvas style={StyleSheet.absoluteFill}>
        <Mask mask={<Path path={tileShapePath} color="#FFFFFF" />} mode="alpha">
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
        </Mask>
      </Canvas>
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Path path={tileShapePath} color={outlineColor} style="stroke" strokeWidth={selected ? 2.5 : 1.5} />
      </Canvas>
    </View>
  );
});

// A small, non-interactive thumbnail lets a saved deck spot show the actual top
// card. It reads the same strokes, images, and background that the card editor saves.
const DeckSpotCardPreview = memo(function DeckSpotCardPreview({
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
  const db = useSQLiteContext();
  const [artwork, setArtwork] = useState<{
    backgroundColor: string;
    backgroundImage: { data: string; mimeType: string } | null;
    strokes: Stroke[];
    images: PlacedImage[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArtwork(null);
    const loadArtwork = async () => {
      try {
        const loaded = await loadSurfaceArtwork(db, surfaceId);
        if (!cancelled) {
          setArtwork({
            backgroundColor: loaded.backgroundColor ?? '#FFFFFF',
            backgroundImage: loaded.backgroundImage
              ? { data: loaded.backgroundImage.base64Data, mimeType: loaded.backgroundImage.mimeType }
              : null,
            strokes: loaded.strokes,
            images: loaded.images,
          });
        }
      } catch (error) {
        console.error('Could not load the card shown on a deck spot:', error);
      }
    };
    void loadArtwork();
    return () => {
      cancelled = true;
    };
  }, [db, surfaceId]);

  const scale = Math.min(width / cardWidth, height / cardHeight);
  const offsetX = (width - cardWidth * scale) / 2;
  const offsetY = (height - cardHeight * scale) / 2;
  const cardStrokePaths = useMemo(
    () => artwork?.strokes.map((stroke) => pointsToPath(stroke.points)) ?? [],
    [artwork?.strokes]
  );

  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: artwork?.backgroundColor ?? '#FFFFFF' },
      ]}
    >
      {artwork?.backgroundImage && (
        <Image
          source={{ uri: `data:${artwork.backgroundImage.mimeType};base64,${artwork.backgroundImage.data}` }}
          resizeMode="cover"
          style={StyleSheet.absoluteFill}
        />
      )}
      <Canvas style={StyleSheet.absoluteFill}>
        <Group transform={[
          { translateX: offsetX },
          { translateY: offsetY },
          { scale },
        ]}>
          {artwork?.strokes.map((stroke, index) => stroke.eraser ? null : (
            <Path
              key={`deck-card-stroke-${index}`}
              path={cardStrokePaths[index]}
              color={stroke.color}
              style="stroke"
              strokeWidth={stroke.width}
              strokeCap="round"
              strokeJoin="round"
            />
          ))}
        </Group>
      </Canvas>
      {artwork?.images.map((image) => {
        const imageWidth = image.width * scale;
        const imageHeight = image.height * scale;
        return (
          <Image
            key={`deck-card-image-${image.id}`}
            source={{ uri: `data:${image.mimeType};base64,${image.base64Data}` }}
            resizeMode="contain"
            style={{
              position: 'absolute',
              left: offsetX + image.center.x * scale - imageWidth / 2,
              top: offsetY + image.center.y * scale - imageHeight / 2,
              width: imageWidth,
              height: imageHeight,
            }}
          />
        );
      })}
    </View>
  );
});
