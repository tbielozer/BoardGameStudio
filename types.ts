export type Point = {
  x: number;
  y: number;
};

export type Stroke = {
  points: Point[];
  width: number;
  eraser: boolean;
  color: string;
  // Strokes from one placed symbol share a group ID so they undo together and
  // their eraser paths stay isolated from the map beneath them.
  groupId?: string;
};

export type SavedStrokeRow = {
  points_json: string;
  width: number;
  color: string;
  is_eraser: number;
  group_id?: string | null;
};
