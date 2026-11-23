import { Skia } from '@shopify/react-native-skia';
import type { Point, Stroke } from './types';
import type {
  BoardDieVisual,
  BoardTileVisual,
  DeckSpot,
  PlacedImage,
  PlacedSymbolHitTarget,
  StrokeBounds,
  TileSnapGrid,
  TileSnapPoint,
} from './drawingCanvasTypes';

export const SYMBOL_CANVAS_SIZE = 300;
export const DECK_SPOT_UNITS_PER_INCH = 24;
export const DECK_SPOT_MAX_EDGE = 120;
export const EMPTY_DECK_SPOT_SIZE_INCHES = 2.5;
export const BOARD_TILE_UNITS_PER_INCH = 24;
export const BOARD_TILE_MAX_EDGE = 240;
export const GAMEPLAY_SNAP_GRID_CELL_SIZE = 64;

/** Build a Skia path from the ordered points in one stroke. */
export function pointsToPath(points: Point[]) {
  const path = Skia.PathBuilder.Make();
  if (points.length > 0) {
    path.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) path.lineTo(point.x, point.y);
  }
  return path.build();
}

// Outline of a tile, token, or card face drawn into a width x height box.
export function makeTileShapePath(
  shape: 'hexagon' | 'square' | 'triangle' | 'circle',
  width: number,
  height: number
) {
  const path = Skia.PathBuilder.Make();
  if (shape === 'circle') {
    path.addOval({ x: 0, y: 0, width, height });
  } else if (shape === 'square') {
    path.addRect({ x: 0, y: 0, width, height });
  } else {
    const points = shape === 'hexagon'
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
}

export function getStrokeBounds(strokes: Stroke[]): StrokeBounds | null {
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

export function buildPlacedSymbolHitTargets(strokes: Stroke[]): PlacedSymbolHitTarget[] {
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

export function findPlacedSymbolAtPoint(
  hitTargets: PlacedSymbolHitTarget[],
  point: Point,
  tolerance: number
): PlacedSymbolHitTarget | null {
  for (const target of hitTargets) {
    const { bounds } = target;
    if (
      point.x >= bounds.left - tolerance && point.x <= bounds.right + tolerance
      && point.y >= bounds.top - tolerance && point.y <= bounds.bottom + tolerance
    ) return target;
  }
  return null;
}

export function transformSymbolStrokes(
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

export function findPlacedImageAtPoint(
  images: PlacedImage[],
  point: Point,
  tolerance: number
): PlacedImage | null {
  // Later images are drawn above earlier ones, so search backwards.
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const image = images[index];
    if (
      point.x >= image.center.x - image.width / 2 - tolerance
      && point.x <= image.center.x + image.width / 2 + tolerance
      && point.y >= image.center.y - image.height / 2 - tolerance
      && point.y <= image.center.y + image.height / 2 + tolerance
    ) return image;
  }
  return null;
}

export function getDeckSpotSize(spot: DeckSpot) {
  const cardWidth = spot.topCard?.widthInches ?? EMPTY_DECK_SPOT_SIZE_INCHES;
  const cardHeight = spot.topCard?.heightInches ?? EMPTY_DECK_SPOT_SIZE_INCHES;
  const scale = Math.min(
    DECK_SPOT_UNITS_PER_INCH,
    DECK_SPOT_MAX_EDGE / Math.max(cardWidth, cardHeight)
  );
  return { width: cardWidth * scale, height: cardHeight * scale };
}

export function findDeckSpotAtPoint(
  spots: DeckSpot[],
  point: Point,
  tolerance: number
): DeckSpot | null {
  for (let index = spots.length - 1; index >= 0; index -= 1) {
    const spot = spots[index];
    const size = getDeckSpotSize(spot);
    const hitRadius = Math.hypot(size.width / 2, size.height / 2) + tolerance;
    if (Math.hypot(point.x - spot.x, point.y - spot.y) <= hitRadius) return spot;
  }
  return null;
}

export function getBoardTileSize(tile: BoardTileVisual | null) {
  const widthInches = tile?.widthInches ?? EMPTY_DECK_SPOT_SIZE_INCHES;
  // Keep a flat-top hexagon's six sides equal, regardless of stored height.
  const heightInches = tile?.shape === 'hexagon'
    ? widthInches * Math.sqrt(3) / 2
    : tile?.heightInches ?? EMPTY_DECK_SPOT_SIZE_INCHES;
  const scale = Math.min(
    BOARD_TILE_UNITS_PER_INCH,
    BOARD_TILE_MAX_EDGE / Math.max(widthInches, heightInches)
  );
  return { width: widthInches * scale, height: heightInches * scale };
}

export function getDieFaceTile(die: BoardDieVisual, faceNumber: number): BoardTileVisual {
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

export function findNearestTileSnapPoint(
  snapPoints: TileSnapPoint[],
  point: Point,
  threshold: number
): TileSnapPoint | null {
  let nearest: TileSnapPoint | null = null;
  let nearestDistanceSquared = threshold * threshold;
  for (const snapPoint of snapPoints) {
    const deltaX = point.x - snapPoint.x;
    const deltaY = point.y - snapPoint.y;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    if (distanceSquared <= nearestDistanceSquared) {
      nearest = snapPoint;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearest;
}

export function findNearestTileSnapPointInGrid(
  grid: TileSnapGrid,
  point: Point,
  threshold: number
): TileSnapPoint | null {
  let nearest: TileSnapPoint | null = null;
  let nearestDistanceSquared = threshold * threshold;
  const cellX = Math.floor(point.x / grid.cellSize);
  const cellY = Math.floor(point.y / grid.cellSize);
  const cellRadius = Math.ceil(threshold / grid.cellSize);
  for (let offsetY = -cellRadius; offsetY <= cellRadius; offsetY += 1) {
    for (let offsetX = -cellRadius; offsetX <= cellRadius; offsetX += 1) {
      const points = grid.buckets[`${cellX + offsetX},${cellY + offsetY}`];
      if (!points) continue;
      for (const snapPoint of points) {
        const deltaX = point.x - snapPoint.x;
        const deltaY = point.y - snapPoint.y;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY;
        if (distanceSquared <= nearestDistanceSquared) {
          nearest = snapPoint;
          nearestDistanceSquared = distanceSquared;
        }
      }
    }
  }
  return nearest;
}

export function findBoardTileAtPoint<T extends {
  x: number; y: number; orientation: number; tile: BoardTileVisual | null;
}>(
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
    // Test in the tile's unrotated space so hit targets match the visible shape.
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
