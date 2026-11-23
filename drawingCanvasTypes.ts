import type { Point, Stroke } from './types';

export type StrokeBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type SymbolTransformSession = {
  groupId: string;
  baseStrokes: Stroke[];
  updatedStrokes: Stroke[];
  center: Point;
  startPoint: Point;
  /** Present when a corner handle starts a drag, so that drag scales instead of moves. */
  resizeStartDistance?: number;
  /** Pinch scale at activation; used as the neutral size for this gesture. */
  startScale?: number;
  changed: boolean;
};

export type PlacedImage = {
  id: number;
  base64Data: string;
  mimeType: string;
  center: Point;
  width: number;
  height: number;
};

export type LoadedSurfaceArtwork = {
  backgroundColor: string | null;
  backgroundImage: { base64Data: string; mimeType: string } | null;
  strokes: Stroke[];
  images: PlacedImage[];
};

export type DeckSpotType = 'deck' | 'discard';

export type DeckSpot = {
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

export type DeckSpotDragSession = {
  spotId: number;
  baseSpot: DeckSpot;
  updatedSpot: DeckSpot;
  startPoint: Point;
  changed: boolean;
};

export type TileSnapPoint = { id: number; x: number; y: number; orientation: number };
export type TileSnapGrid = {
  cellSize: number;
  buckets: Record<string, TileSnapPoint[]>;
};
export type TileSnapDragSession = {
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

export type BoardTokenPlacement = {
  id: number;
  x: number;
  y: number;
  orientation: number;
  faceUp: boolean;
  token: BoardTileVisual;
};

export type BoardDiePlacement = {
  id: number;
  x: number;
  y: number;
  orientation: number;
  faceNumber: number;
  die: BoardDieVisual;
};

export type TokenMarkerDragSession = {
  kind: 'supply' | 'token' | 'die';
  id: number;
  /** Keep the write destination tied to the screen where this drag began. */
  gameplayMode: boolean;
  startPoint: Point;
  startX: number;
  startY: number;
  updatedX: number;
  updatedY: number;
  changed: boolean;
};

export type GameplayTakeDragSession = {
  kind: 'token' | 'tile';
  sourceId: number;
  startPoint: Point;
  updatedPoint: Point;
  changed: boolean;
};

export type DeckCardDragSession = {
  sourceSpotId: number;
  startPoint: Point;
  updatedPoint: Point;
  screenY: number;
  changed: boolean;
};

export type GameplayTakePreview = {
  kind: 'token' | 'tile';
  sourceId: number;
  tile: BoardTileVisual;
  startPoint: Point;
};

export type BoardTilePlacement = {
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

export type TokenSupplyPlacement = {
  id: number;
  x: number;
  y: number;
  orientation: number;
  quantity: number | null;
  token: BoardTileVisual;
};

export type TilePlacementDragSession = {
  placementId: number;
  /** Remember the interaction mode from pickup through the asynchronous save. */
  gameplayMode: boolean;
  basePlacement: BoardTilePlacement;
  updatedPlacement: BoardTilePlacement;
  startPoint: Point;
  changed: boolean;
};

export type TilePlacementPreview = {
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

export type ImageTransformSession = {
  imageId: number;
  baseImage: PlacedImage;
  updatedImage: PlacedImage;
  center: Point;
  startPoint: Point;
  resizeStartDistance?: number;
  startScale?: number;
  changed: boolean;
};

export type PlacedSymbolHitTarget = {
  groupId: string;
  strokes: Stroke[];
  bounds: StrokeBounds;
};
