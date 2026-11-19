import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { useSQLiteContext } from 'expo-sqlite';
import { DrawingCanvas, type DrawingCanvasHandle } from './DrawingCanvas';
import { tileEditorStyles as s } from './tileEditorStyles';

type TileShape = 'hexagon' | 'square' | 'triangle' | 'circle';
type Tile = {
  id: number;
  project_id: string;
  surface_id: string;
  back_surface_id: string | null;
  name: string;
  shape: TileShape;
  width: number;
  height: number;
  preview_scale: number;
  color: string;
};
type TileDeck = { id: number; name: string };
type TileCount = { tileId: number; quantity: number };
type AvailableSymbol = { id: number; name: string };
type SavedTileBack = { id: number; name: string; artwork_json: string; created_at: number; updated_at: number };
type TileBackSnapshot = {
  backgroundColor: string | null;
  backgroundImage: { base64Data: string; mimeType: string } | null;
  strokes: Array<{ points_json: string; width: number; color: string; is_eraser: number; order_index: number; group_id: string | null }>;
  images: Array<{ base64_data: string; mime_type: string; center_x: number; center_y: number; width: number; height: number; order_index: number }>;
};

const SHAPES: TileShape[] = ['hexagon', 'square', 'triangle', 'circle'];
const TILE_COLORS = ['#E9C46A', '#8AB17D', '#78A9D1', '#D98472', '#B7A1D1', '#D1D5DB'];
const DEFAULT_COLOR = TILE_COLORS[0];
const HEX_HEIGHT_TO_WIDTH = Math.sqrt(3) / 2;
const parseDimension = (value: string, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const formatDimension = (value: number) => Number(value.toFixed(3)).toString();
const normalizeTileDimensions = (shape: TileShape, width: number, height: number) => shape === 'hexagon'
  ? { width, height: width * HEX_HEIGHT_TO_WIDTH }
  : { width, height };

type Props = {
  projectId?: string;
  symbols: AvailableSymbol[];
  topInset: number;
  bottomInset: number;
  onClose: () => void;
};

/** Project tile library, tile drawing editor, and tile-deck contents. */
export function TileEditor({ projectId, symbols, topInset, bottomInset, onClose }: Props) {
  const db = useSQLiteContext();
  const canvasRef = useRef<DrawingCanvasHandle | null>(null);
  // Keep rapid +/- taps in order so two quick updates cannot overwrite each other.
  const quantityWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [decks, setDecks] = useState<TileDeck[]>([]);
  const [counts, setCounts] = useState<TileCount[]>([]);
  const [activeDeckId, setActiveDeckId] = useState<number | null>(null);
  const [editingTileId, setEditingTileId] = useState<number | null>(null);
  const [activeFace, setActiveFace] = useState<'front' | 'back'>('front');
  const [tileDialogOpen, setTileDialogOpen] = useState(false);
  const [deckDialogOpen, setDeckDialogOpen] = useState(false);
  const [sizeDialogOpen, setSizeDialogOpen] = useState(false);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [savedBacks, setSavedBacks] = useState<SavedTileBack[]>([]);
  const [savedBackLibraryOpen, setSavedBackLibraryOpen] = useState(false);
  const [saveBackOpen, setSaveBackOpen] = useState(false);
  const [saveBackName, setSaveBackName] = useState('');
  const [renameBackId, setRenameBackId] = useState<number | null>(null);
  const [renameBackName, setRenameBackName] = useState('');
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [tileName, setTileName] = useState('');
  const [tileWidth, setTileWidth] = useState('2');
  const [tileHeight, setTileHeight] = useState(formatDimension(2 * HEX_HEIGHT_TO_WIDTH));
  const [tileShape, setTileShape] = useState<TileShape>('hexagon');
  const [tileColor, setTileColor] = useState(DEFAULT_COLOR);
  const [tileScale, setTileScale] = useState(1);
  const [deckName, setDeckName] = useState('');
  const [placementSymbol, setPlacementSymbol] = useState<AvailableSymbol | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const activeTile = tiles.find((tile) => tile.id === editingTileId);
  const activeSurfaceId = activeFace === 'front'
    ? activeTile?.surface_id
    : activeTile?.back_surface_id ?? undefined;

  const loadData = async () => {
    if (!projectId) return;
    try {
      const [tileRows, deckRows] = await Promise.all([
        db.getAllAsync<Tile>(
          `SELECT id, project_id, surface_id, back_surface_id, name, shape,
            width_inches AS width, height_inches AS height, preview_scale, color
           FROM game_tiles WHERE project_id = ? ORDER BY name`,
          projectId
        ),
        db.getAllAsync<TileDeck>(
          'SELECT id, name FROM tile_decks WHERE project_id = ? ORDER BY name',
          projectId
        ),
      ]);
      setTiles(tileRows.map((tile) => ({
        ...tile,
        ...normalizeTileDimensions(tile.shape, tile.width, tile.height),
      })));
      setDecks(deckRows);
      if (activeDeckId !== null) {
        const itemRows = await db.getAllAsync<{ tile_id: number; quantity: number }>(
          'SELECT tile_id, quantity FROM tile_deck_items WHERE deck_id = ?', activeDeckId
        );
        setCounts(itemRows.map((row) => ({ tileId: row.tile_id, quantity: row.quantity })));
      } else {
        setCounts([]);
      }
    } catch (error) {
      console.error('Could not load tile library:', error);
      Alert.alert('Could not load tiles', 'Please try reopening the tile editor.');
    }
  };

  useEffect(() => { void loadData(); }, [projectId, activeDeckId]);

  useEffect(() => {
    if (!savedBackLibraryOpen) return;
    let cancelled = false;
    const loadBacks = async () => {
      try {
        const rows = await db.getAllAsync<SavedTileBack>(
          'SELECT id, name, artwork_json, created_at, updated_at FROM saved_tile_backs ORDER BY updated_at DESC'
        );
        if (!cancelled) setSavedBacks(rows);
      } catch (error) {
        console.error('Could not load saved tile backs:', error);
        Alert.alert('Could not load saved backs', 'Please try again.');
      }
    };
    void loadBacks();
    return () => { cancelled = true; };
  }, [db, savedBackLibraryOpen]);

  const openTile = (tile: Tile) => {
    const dimensions = normalizeTileDimensions(tile.shape, tile.width, tile.height);
    setEditingTileId(tile.id);
    setTileName(tile.name);
    setTileWidth(String(dimensions.width));
    setTileHeight(String(dimensions.height));
    setTileShape(tile.shape);
    setTileColor(tile.color);
    setTileScale(tile.preview_scale);
    setActiveFace('front');
    setPlacementSymbol(null);
    setIsMoving(false);
  };

  const changeTileWidth = (value: string) => {
    setTileWidth(value);
    const width = parseDimension(value, 0);
    if (tileShape === 'hexagon' && width > 0) {
      setTileHeight(formatDimension(width * HEX_HEIGHT_TO_WIDTH));
    }
  };

  const changeTileHeight = (value: string) => {
    setTileHeight(value);
    const height = parseDimension(value, 0);
    if (tileShape === 'hexagon' && height > 0) {
      setTileWidth(formatDimension(height / HEX_HEIGHT_TO_WIDTH));
    }
  };

  const changeTileShape = (shape: TileShape) => {
    setTileShape(shape);
    if (shape === 'hexagon') {
      const width = parseDimension(tileWidth, 0);
      if (width > 0) setTileHeight(formatDimension(width * HEX_HEIGHT_TO_WIDTH));
    }
  };

  const saveTile = async () => {
    const name = tileName.trim();
    const dimensions = normalizeTileDimensions(
      tileShape,
      parseDimension(tileWidth, 0),
      parseDimension(tileHeight, 0)
    );
    const { width, height } = dimensions;
    if (!projectId || !name || !width || !height) {
      Alert.alert('Check tile details', 'Enter a name and positive width and height.');
      return;
    }
    const now = Date.now();
    const surfaceId = `${projectId}-tile-${now}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      // The tile surface is created first because every tile drawing refers to it.
      await db.runAsync(
        `INSERT INTO drawing_surfaces (id, project_id, kind, name, background_color)
         VALUES (?, ?, 'tile', ?, ?)`,
        surfaceId, projectId, name, tileColor
      );
      const backSurfaceId = `${surfaceId}-back`;
      await db.runAsync(
        `INSERT INTO drawing_surfaces (id, project_id, kind, name, background_color)
         VALUES (?, ?, 'tile', ?, ?)`,
        backSurfaceId, projectId, `${name} Back`, tileColor
      );
      await db.runAsync(
        `INSERT INTO game_tiles
          (project_id, surface_id, back_surface_id, name, shape, width_inches, height_inches,
           preview_scale, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        projectId, surfaceId, backSurfaceId, name, tileShape, width, height, tileColor, now, now
      );
      setTileDialogOpen(false);
      setTileName('');
      await loadData();
    } catch (error) {
      console.error('Could not save tile:', error);
      Alert.alert('Could not save tile', 'Please try again.');
    }
  };

  const saveTileDetails = async () => {
    if (!activeTile) return;
    const name = tileName.trim();
    const dimensions = normalizeTileDimensions(
      tileShape,
      parseDimension(tileWidth, 0),
      parseDimension(tileHeight, 0)
    );
    const { width, height } = dimensions;
    if (!name || !width || !height) {
      Alert.alert('Check tile details', 'Enter a name and positive width and height.');
      return;
    }
    try {
      await db.runAsync(
        `UPDATE game_tiles SET name = ?, shape = ?, width_inches = ?, height_inches = ?,
          preview_scale = ?, color = ?, updated_at = ? WHERE id = ?`,
        name, tileShape, width, height, tileScale, tileColor, Date.now(), activeTile.id
      );
      await db.runAsync(
        'UPDATE drawing_surfaces SET name = ?, background_color = ? WHERE id = ?',
        name, tileColor, activeTile.surface_id
      );
      setSizeDialogOpen(false);
      await loadData();
    } catch (error) {
      console.error('Could not save tile settings:', error);
      Alert.alert('Could not save tile settings', 'Please try again.');
    }
  };

  const saveCurrentBack = async () => {
    const backSurfaceId = activeTile?.back_surface_id;
    const name = saveBackName.trim();
    if (!backSurfaceId || !name) return;
    try {
      const surface = await db.getFirstAsync<{
        background_color: string | null;
        background_image_data: string | null;
        background_image_mime_type: string | null;
      }>(
        'SELECT background_color, background_image_data, background_image_mime_type FROM drawing_surfaces WHERE id = ?',
        backSurfaceId
      );
      const strokes = await db.getAllAsync<TileBackSnapshot['strokes'][number]>(
        'SELECT points_json, width, color, is_eraser, order_index, group_id FROM strokes WHERE surface_id = ? ORDER BY order_index',
        backSurfaceId
      );
      const images = await db.getAllAsync<TileBackSnapshot['images'][number]>(
        'SELECT base64_data, mime_type, center_x, center_y, width, height, order_index FROM surface_images WHERE surface_id = ? ORDER BY order_index',
        backSurfaceId
      );
      const snapshot: TileBackSnapshot = {
        backgroundColor: surface?.background_color ?? '#FFFFFF',
        backgroundImage: surface?.background_image_data && surface.background_image_mime_type
          ? { base64Data: surface.background_image_data, mimeType: surface.background_image_mime_type }
          : null,
        strokes,
        images,
      };
      const now = Date.now();
      const artworkJson = JSON.stringify(snapshot);
      const result = await db.runAsync(
        'INSERT INTO saved_tile_backs (name, artwork_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
        name, artworkJson, now, now
      );
      setSavedBacks((current) => [{ id: result.lastInsertRowId, name, artwork_json: artworkJson, created_at: now, updated_at: now }, ...current]);
      setSaveBackName('');
      setSaveBackOpen(false);
    } catch (error) {
      console.error('Could not save reusable tile back:', error);
      Alert.alert('Could not save tile back', 'Please try again.');
    }
  };

  const applySavedBack = async (template: SavedTileBack) => {
    const backSurfaceId = activeTile?.back_surface_id;
    if (!backSurfaceId) return;
    try {
      const snapshot = JSON.parse(template.artwork_json) as TileBackSnapshot;
      await db.runAsync('DELETE FROM strokes WHERE surface_id = ?', backSurfaceId);
      await db.runAsync('DELETE FROM surface_images WHERE surface_id = ?', backSurfaceId);
      await db.runAsync(
        `UPDATE drawing_surfaces SET background_color = ?, background_image_data = ?, background_image_mime_type = ? WHERE id = ?`,
        snapshot.backgroundColor,
        snapshot.backgroundImage?.base64Data ?? null,
        snapshot.backgroundImage?.mimeType ?? null,
        backSurfaceId
      );
      for (const stroke of snapshot.strokes) {
        await db.runAsync(
          `INSERT INTO strokes (surface_id, points_json, width, color, is_eraser, order_index, group_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          backSurfaceId, stroke.points_json, stroke.width, stroke.color,
          stroke.is_eraser, stroke.order_index, stroke.group_id
        );
      }
      for (const image of snapshot.images) {
        await db.runAsync(
          `INSERT INTO surface_images (surface_id, base64_data, mime_type, center_x, center_y, width, height, order_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          backSurfaceId, image.base64_data, image.mime_type, image.center_x,
          image.center_y, image.width, image.height, image.order_index
        );
      }
      setCanvasRevision((revision) => revision + 1);
      setSavedBackLibraryOpen(false);
    } catch (error) {
      console.error('Could not apply saved tile back:', error);
      Alert.alert('Could not apply tile back', 'Please try again.');
    }
  };

  const renameSavedBack = async () => {
    const name = renameBackName.trim();
    if (!name || renameBackId === null) return;
    try {
      const updatedAt = Date.now();
      await db.runAsync('UPDATE saved_tile_backs SET name = ?, updated_at = ? WHERE id = ?', name, updatedAt, renameBackId);
      setSavedBacks((current) => current.map((item) => item.id === renameBackId ? { ...item, name, updated_at: updatedAt } : item));
      setRenameBackId(null);
      setSavedBackLibraryOpen(true);
    } catch (error) {
      console.error('Could not rename saved tile back:', error);
      Alert.alert('Could not rename saved back', 'Please try again.');
    }
  };

  const deleteSavedBack = (template: SavedTileBack) => Alert.alert(
    'Delete saved back?', `Delete “${template.name}” from the reusable tile back library?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await db.runAsync('DELETE FROM saved_tile_backs WHERE id = ?', template.id);
        setSavedBacks((current) => current.filter((item) => item.id !== template.id));
      } },
    ]
  );

  const saveDeck = async () => {
    const name = deckName.trim();
    if (!projectId || !name) return;
    try {
      const result = await db.runAsync(
        'INSERT INTO tile_decks (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
        projectId, name, Date.now(), Date.now()
      );
      setDeckName('');
      setDeckDialogOpen(false);
      setActiveDeckId(result.lastInsertRowId);
      await loadData();
    } catch (error) {
      console.error('Could not save tile deck:', error);
      Alert.alert('Could not save deck', 'Please try again.');
    }
  };

  const changeQuantity = (tile: Tile, amount: number) => {
    if (activeDeckId === null) return;
    const deckId = activeDeckId;
    quantityWriteQueueRef.current = quantityWriteQueueRef.current.then(async () => {
      const savedCount = await db.getFirstAsync<{ quantity: number }>(
        'SELECT quantity FROM tile_deck_items WHERE deck_id = ? AND tile_id = ?', deckId, tile.id
      );
      const nextQuantity = Math.max(0, (savedCount?.quantity ?? 0) + amount);
      if (nextQuantity === 0) {
        await db.runAsync('DELETE FROM tile_deck_items WHERE deck_id = ? AND tile_id = ?', deckId, tile.id);
      } else {
        await db.runAsync(
          `INSERT INTO tile_deck_items (deck_id, tile_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(deck_id, tile_id) DO UPDATE SET quantity = excluded.quantity`,
          deckId, tile.id, nextQuantity
        );
      }
      setCounts((current) => [
        ...current.filter((item) => item.tileId !== tile.id),
        ...(nextQuantity > 0 ? [{ tileId: tile.id, quantity: nextQuantity }] : []),
      ]);
    }).catch((error) => {
      console.error('Could not update tile quantity:', error);
      Alert.alert('Could not update quantity', 'Please try again.');
    });
  };

  const deleteTile = (tile: Tile) => Alert.alert('Delete tile?', `Remove “${tile.name}” from this project and its decks?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => {
      try {
        // Remove the library row first for databases created before surface_id
        // gained its foreign-key constraint, then clear the artwork surface.
        await db.runAsync('DELETE FROM game_tiles WHERE id = ?', tile.id);
        await db.runAsync('DELETE FROM drawing_surfaces WHERE id = ?', tile.surface_id);
        if (tile.back_surface_id) await db.runAsync('DELETE FROM drawing_surfaces WHERE id = ?', tile.back_surface_id);
        if (editingTileId === tile.id) setEditingTileId(null);
        await loadData();
      } catch (error) {
        console.error('Could not delete tile:', error);
        Alert.alert('Could not delete tile', 'Please try again.');
      }
    } },
  ]);

  const deleteDeck = (deck: TileDeck) => Alert.alert('Delete tile deck?', `Remove “${deck.name}” and its contents?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => {
      try {
        await db.runAsync('DELETE FROM tile_decks WHERE id = ?', deck.id);
        if (activeDeckId === deck.id) setActiveDeckId(null);
        await loadData();
      } catch (error) {
        console.error('Could not delete tile deck:', error);
        Alert.alert('Could not delete deck', 'Please try again.');
      }
    } },
  ]);

  const previewSize = useMemo(() => {
    if (!activeTile) return { width: 0, height: 0, unitsPerInch: 0 };
    const maxWidth = Math.max(100, stageSize.width - 24);
    const maxHeight = Math.max(100, stageSize.height - 24);
    const unitsPerInch = Math.min(maxWidth / activeTile.width, maxHeight / activeTile.height) * tileScale;
    return { width: activeTile.width * unitsPerInch, height: activeTile.height * unitsPerInch, unitsPerInch };
  }, [activeTile, stageSize, tileScale]);

  const renderTileSettings = (title: string, onSave: () => void, onCancel: () => void) => (
    <View style={s.backdrop}><View style={s.dialog}>
      <Text style={s.dialogTitle}>{title}</Text>
      <TextInput style={s.input} value={tileName} onChangeText={setTileName} placeholder="Tile name" />
      <Text style={s.label}>Shape</Text>
      <View style={s.chips}>{SHAPES.map((shape) => <Pressable key={shape} onPress={() => changeTileShape(shape)} style={[s.chip, tileShape === shape && s.chipSelected]}><Text style={tileShape === shape ? s.chipTextSelected : s.chipText}>{shape}</Text></Pressable>)}</View>
      <Text style={s.label}>Dimensions (inches)</Text>
      <View style={s.dimensionRow}><TextInput style={[s.input, s.dimensionInput]} value={tileWidth} onChangeText={changeTileWidth} keyboardType="decimal-pad" placeholder="Width" /><Text style={s.by}>×</Text><TextInput style={[s.input, s.dimensionInput]} value={tileHeight} onChangeText={changeTileHeight} keyboardType="decimal-pad" placeholder="Height" /></View>
      {tileShape === 'hexagon' && <Text style={s.helper}>Regular hexagon proportions are kept automatically.</Text>}
      {activeTile && <><Text style={s.label}>Preview scale · {tileScale.toFixed(2)}×</Text><Slider minimumValue={0.5} maximumValue={2} step={0.05} value={tileScale} onValueChange={setTileScale} minimumTrackTintColor="#315EFB" maximumTrackTintColor="#D1D5DB" thumbTintColor="#315EFB" />
      <Text style={s.label}>Tile color</Text></>}
      {!activeTile && <Text style={s.label}>Starting tile color</Text>}
      <View style={s.chips}>{TILE_COLORS.map((color) => <Pressable key={color} accessibilityLabel={`Choose color ${color}`} onPress={() => setTileColor(color)} style={[s.swatch, { backgroundColor: color }, tileColor === color && s.swatchSelected]} />)}</View>
      <View style={s.dialogActions}><Pressable style={s.secondaryButton} onPress={onCancel}><Text>Cancel</Text></Pressable><Pressable style={s.primaryButton} onPress={onSave}><Text style={s.primaryText}>Save</Text></Pressable></View>
    </View></View>
  );

  return (
    <View style={[s.screen, { paddingTop: topInset + 10, paddingBottom: bottomInset + 10 }]}>
      <View style={s.header}>
        <View style={s.headerText}>
          <Text style={s.title}>{activeTile ? 'Tile Editor' : 'Game Tiles'}</Text>
          <Text style={s.subtitle}>{activeTile ? `${activeTile.name} · ${activeTile.shape} · ${activeFace}` : 'Tile shapes, sizes, and decks for this project'}</Text>
        </View>
        <View style={s.headerActions}>
          {activeTile && <Pressable style={s.headerButton} onPress={() => setEditingTileId(null)}><Text style={s.headerButtonText}>Tiles</Text></Pressable>}
          <Pressable accessibilityRole="button" onPress={() => activeTile ? setEditingTileId(null) : onClose()} style={s.close}><Text style={s.closeText}>{activeTile ? 'Done' : 'Done'}</Text></Pressable>
        </View>
      </View>

      {activeTile ? (
        <>
          <View style={s.editorActions}>
            <Pressable style={s.actionButton} onPress={() => setSymbolPickerOpen(true)}><Text style={s.actionButtonText}>Symbol</Text></Pressable>
            <Pressable style={s.actionButton} onPress={() => canvasRef.current?.importImage()}><Text style={s.actionButtonText}>Image</Text></Pressable>
            <Pressable style={[s.actionButton, isMoving && s.actionButtonSelected]} onPress={() => { setPlacementSymbol(null); setIsMoving((moving) => !moving); }}><Text style={s.actionButtonText}>{isMoving ? 'Moving' : 'Move'}</Text></Pressable>
            <Pressable style={s.actionButton} onPress={() => setSizeDialogOpen(true)}><Text style={s.actionButtonText}>Size</Text></Pressable>
          </View>
          <View style={s.faceTabs}>
            {(['front', 'back'] as const).map((face) => (
              <Pressable
                key={face}
                accessibilityRole="button"
                accessibilityState={{ selected: activeFace === face }}
                style={[s.faceTab, activeFace === face && s.faceTabSelected]}
                onPress={() => {
                  setActiveFace(face);
                  setPlacementSymbol(null);
                  setIsMoving(false);
                }}
              >
                <Text style={[s.faceTabText, activeFace === face && s.faceTabTextSelected]}>
                  {face === 'front' ? 'Edit Front' : 'Edit Back'}
                </Text>
              </Pressable>
            ))}
          </View>
          {activeFace === 'back' && (
            <View style={s.backActions}>
              <Pressable style={s.backActionButton} onPress={() => { setSaveBackName(`Tile Back ${savedBacks.length + 1}`); setSaveBackOpen(true); }}><Text style={s.backActionText}>Save This Back</Text></Pressable>
              <Pressable style={s.backActionButton} onPress={() => setSavedBackLibraryOpen(true)}><Text style={s.backActionText}>Saved Backs</Text></Pressable>
            </View>
          )}
          <View style={s.previewStage} onLayout={(event) => setStageSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
            {previewSize.unitsPerInch > 0 && <View style={[s.tileCanvasFrame, { width: previewSize.width, height: previewSize.height, borderRadius: 0, borderWidth: activeTile.shape === 'hexagon' || activeTile.shape === 'triangle' || activeTile.shape === 'circle' ? 0 : 1 }]}>
              <DrawingCanvas
                key={`${activeSurfaceId}-${canvasRevision}`}
                ref={canvasRef}
                bottomInset={0}
                topInset={4}
                surfaceId={activeSurfaceId}
                allowImageAsBackground
                defaultBackgroundColor={activeTile.color}
                compactToolbar
                surfaceShape={activeTile.shape === 'hexagon' || activeTile.shape === 'triangle' || activeTile.shape === 'circle' ? activeTile.shape : undefined}
                hexagonToolbar={activeTile.shape === 'hexagon'}
                coordinateScale={Math.max(previewSize.unitsPerInch, 0.01)}
                placementSymbolId={placementSymbol?.id}
                placementSymbolName={placementSymbol?.name}
                repeatSymbolPlacement
                placementSymbolScale={0.2 / Math.max(previewSize.unitsPerInch, 0.01)}
                onSymbolPlaced={() => setPlacementSymbol(null)}
                isEditingSymbols={isMoving}
                onStopEditingSymbols={() => setIsMoving(false)}
              />
            </View>}
            <Text style={s.dimensionCaption}>{activeTile.width} × {activeTile.height} in · scale {tileScale.toFixed(2)}×</Text>
          </View>
        </>
      ) : !projectId ? <Text style={s.empty}>Open a project to create its tile library.</Text> : (
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <View style={s.sectionHeader}><Text style={s.sectionTitle}>Tile Types</Text><Pressable style={s.primaryButton} onPress={() => setTileDialogOpen(true)}><Text style={s.primaryText}>+ New Tile</Text></Pressable></View>
          {tiles.length === 0 ? <Text style={s.empty}>Create a tile type with a shape and real-world dimensions.</Text> : tiles.map((tile) => {
            const quantity = counts.find((item) => item.tileId === tile.id)?.quantity ?? 0;
            return <View key={tile.id} style={s.row}>
              <View style={[s.tilePreview, { backgroundColor: tile.color, borderRadius: tile.shape === 'circle' ? 22 : 8 }]}><Text style={s.previewShape}>{tile.shape === 'hexagon' ? '⬡' : tile.shape === 'triangle' ? '△' : tile.shape === 'circle' ? '○' : '□'}</Text></View>
              <Pressable style={s.rowDetails} onPress={() => openTile(tile)}><Text style={s.rowTitle}>{tile.name}</Text><Text style={s.rowSubtitle}>{tile.shape} · {tile.width} × {tile.height} in</Text></Pressable>
              <Pressable style={s.editButton} onPress={() => openTile(tile)}><Text style={s.editButtonText}>Edit</Text></Pressable>
              {activeDeckId !== null && <View style={s.quantityControls}><Pressable style={s.quantityButton} onPress={() => void changeQuantity(tile, -1)}><Text>−</Text></Pressable><Text style={s.quantity}>{quantity}</Text><Pressable style={s.quantityButton} onPress={() => void changeQuantity(tile, 1)}><Text>+</Text></Pressable></View>}
              <Pressable accessibilityLabel={`Delete ${tile.name}`} style={s.deleteButton} onPress={() => deleteTile(tile)}><Text style={s.deleteText}>×</Text></Pressable>
            </View>;
          })}

          <View style={[s.sectionHeader, s.deckHeading]}><Text style={s.sectionTitle}>Tile Decks</Text><Pressable style={s.primaryButton} onPress={() => setDeckDialogOpen(true)}><Text style={s.primaryText}>+ New Deck</Text></Pressable></View>
          {decks.length === 0 ? <Text style={s.empty}>A deck stores tile types and how many of each tile it contains.</Text> : decks.map((deck) => (
            <View key={deck.id} style={[s.deckRow, activeDeckId === deck.id && s.deckRowSelected]}>
              <Pressable style={s.deckSelect} onPress={() => setActiveDeckId(deck.id)}><Text style={s.rowTitle}>{deck.name}</Text><Text style={s.rowSubtitle}>{activeDeckId === deck.id ? 'Selected · use + and − above to set tile counts' : 'Tap to edit contents'}</Text></Pressable>
              <Pressable accessibilityLabel={`Delete ${deck.name}`} style={s.deleteButton} onPress={() => deleteDeck(deck)}><Text style={s.deleteText}>×</Text></Pressable>
            </View>
          ))}
          {activeDeckId !== null && tiles.length > 0 && <Text style={s.helper}>With a deck selected, use the plus and minus buttons beside each tile type to set how many are in this deck.</Text>}
        </ScrollView>
      )}

      <Modal visible={tileDialogOpen} transparent animationType="fade" onRequestClose={() => setTileDialogOpen(false)}>
        {renderTileSettings('New Tile Type', () => void saveTile(), () => setTileDialogOpen(false))}
      </Modal>
      <Modal visible={sizeDialogOpen} transparent animationType="fade" onRequestClose={() => setSizeDialogOpen(false)}>
        {renderTileSettings('Tile Dimensions & Appearance', () => void saveTileDetails(), () => setSizeDialogOpen(false))}
      </Modal>
      <Modal visible={deckDialogOpen} transparent animationType="fade" onRequestClose={() => setDeckDialogOpen(false)}>
        <View style={s.backdrop}><View style={s.dialog}><Text style={s.dialogTitle}>New Tile Deck</Text><TextInput style={s.input} value={deckName} onChangeText={setDeckName} placeholder="Deck name" autoFocus /><View style={s.dialogActions}><Pressable style={s.secondaryButton} onPress={() => setDeckDialogOpen(false)}><Text>Cancel</Text></Pressable><Pressable style={s.primaryButton} onPress={() => void saveDeck()}><Text style={s.primaryText}>Create Deck</Text></Pressable></View></View></View>
      </Modal>
      <Modal visible={saveBackOpen} transparent animationType="fade" onRequestClose={() => setSaveBackOpen(false)}>
        <View style={s.backdrop}><View style={s.dialog}>
          <Text style={s.dialogTitle}>Save Reusable Tile Back</Text>
          <Text style={s.helper}>This saves the back's background, drawings, and images so you can reuse it on other tiles.</Text>
          <TextInput style={s.input} value={saveBackName} onChangeText={setSaveBackName} placeholder="Tile back name" autoFocus selectTextOnFocus maxLength={60} returnKeyType="done" onSubmitEditing={() => void saveCurrentBack()} />
          <View style={s.dialogActions}><Pressable style={s.secondaryButton} onPress={() => setSaveBackOpen(false)}><Text>Cancel</Text></Pressable><Pressable style={s.primaryButton} onPress={() => void saveCurrentBack()}><Text style={s.primaryText}>Save</Text></Pressable></View>
        </View></View>
      </Modal>
      <Modal visible={savedBackLibraryOpen} transparent animationType="fade" onRequestClose={() => setSavedBackLibraryOpen(false)}>
        <View style={s.backdrop}><View style={s.dialog}>
          <View style={s.backLibraryHeader}><View><Text style={s.dialogTitle}>Saved Tile Backs</Text><Text style={s.helper}>Choose a reusable design for this tile.</Text></View><Pressable style={s.deleteButton} accessibilityLabel="Close saved tile backs" onPress={() => setSavedBackLibraryOpen(false)}><Text style={s.deleteText}>×</Text></Pressable></View>
          {savedBacks.length === 0 ? <Text style={s.empty}>No saved backs yet. Edit a tile back, then choose Save This Back.</Text> : <ScrollView style={s.savedBackList} keyboardShouldPersistTaps="handled">{savedBacks.map((template) => <View key={template.id} style={s.savedBackRow}>
            <Text style={s.savedBackName}>{template.name}</Text>
            <Pressable style={s.smallAction} onPress={() => void applySavedBack(template)}><Text style={s.smallActionText}>Use</Text></Pressable>
            <Pressable style={s.smallAction} onPress={() => { setSavedBackLibraryOpen(false); setRenameBackName(template.name); setRenameBackId(template.id); }}><Text style={s.smallActionText}>Rename</Text></Pressable>
            <Pressable style={s.smallDelete} onPress={() => deleteSavedBack(template)}><Text style={s.smallDeleteText}>Delete</Text></Pressable>
          </View>)}</ScrollView>}
        </View></View>
      </Modal>
      <Modal visible={renameBackId !== null} transparent animationType="fade" onRequestClose={() => { setRenameBackId(null); setSavedBackLibraryOpen(true); }}>
        <View style={s.backdrop}><View style={s.dialog}>
          <Text style={s.dialogTitle}>Rename Saved Back</Text>
          <TextInput style={s.input} value={renameBackName} onChangeText={setRenameBackName} placeholder="Tile back name" autoFocus selectTextOnFocus maxLength={60} returnKeyType="done" onSubmitEditing={() => void renameSavedBack()} />
          <View style={s.dialogActions}><Pressable style={s.secondaryButton} onPress={() => { setRenameBackId(null); setSavedBackLibraryOpen(true); }}><Text>Cancel</Text></Pressable><Pressable style={s.primaryButton} onPress={() => void renameSavedBack()}><Text style={s.primaryText}>Save</Text></Pressable></View>
        </View></View>
      </Modal>
      <Modal visible={symbolPickerOpen} transparent animationType="fade" onRequestClose={() => setSymbolPickerOpen(false)}>
        <View style={s.backdrop}><View style={s.dialog}><Text style={s.dialogTitle}>Choose a Symbol</Text>
          {symbols.length === 0 ? <Text style={s.empty}>Create a saved symbol in the Symbol Editor first.</Text> : <ScrollView style={s.symbolOptions}>{symbols.map((symbol) => <Pressable key={symbol.id} style={s.symbolOption} onPress={() => { setPlacementSymbol(symbol); setIsMoving(false); setSymbolPickerOpen(false); }}><Text style={s.rowTitle}>{symbol.name}</Text></Pressable>)}</ScrollView>}
          <View style={s.dialogActions}><Pressable style={s.secondaryButton} onPress={() => setSymbolPickerOpen(false)}><Text>Close</Text></Pressable></View>
        </View></View>
      </Modal>
    </View>
  );
}
