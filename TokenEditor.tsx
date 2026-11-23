import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useSQLiteContext } from 'expo-sqlite';
import { DrawingCanvas, type DrawingCanvasHandle } from './DrawingCanvas';
import { invalidateSurfaceArtworkCache } from './surfaceArtworkCache';
import { tileEditorStyles as s } from './tileEditorStyles';

type TokenShape = 'circle' | 'square' | 'hexagon' | 'triangle';
type Token = {
  id: number;
  project_id: string;
  surface_id: string;
  back_surface_id: string;
  name: string;
  shape: TokenShape;
  width: number;
  height: number;
  preview_scale: number;
  color: string;
};
type SymbolOption = { id: number; name: string };
type SavedTokenBack = { id: number; name: string; artwork_json: string; created_at: number; updated_at: number };
type TokenBackSnapshot = {
  backgroundColor: string | null;
  backgroundImage: { base64Data: string; mimeType: string } | null;
  strokes: Array<{ points_json: string; width: number; color: string; is_eraser: number; order_index: number; group_id: string | null }>;
  images: Array<{ base64_data: string; mime_type: string; center_x: number; center_y: number; width: number; height: number; order_index: number }>;
};

const SHAPES: TokenShape[] = ['circle', 'square', 'hexagon', 'triangle'];
const COLORS = ['#E9C46A', '#8AB17D', '#78A9D1', '#D98472', '#B7A1D1', '#D1D5DB'];
const parseDimension = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

type Props = {
  projectId?: string;
  symbols: SymbolOption[];
  topInset: number;
  bottomInset: number;
  onClose: () => void;
};

/** A project library of reusable token faces, with the same drawing tools as cards and tiles. */
export function TokenEditor({ projectId, symbols, topInset, bottomInset, onClose }: Props) {
  const db = useSQLiteContext();
  const canvasRef = useRef<DrawingCanvasHandle | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [editingTokenId, setEditingTokenId] = useState<number | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [sizeDialogOpen, setSizeDialogOpen] = useState(false);
  const [saveBackOpen, setSaveBackOpen] = useState(false);
  const [savedBackLibraryOpen, setSavedBackLibraryOpen] = useState(false);
  const [savedBacks, setSavedBacks] = useState<SavedTokenBack[]>([]);
  const [saveBackName, setSaveBackName] = useState('');
  const [renameBackId, setRenameBackId] = useState<number | null>(null);
  const [renameBackName, setRenameBackName] = useState('');
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenWidth, setTokenWidth] = useState('1');
  const [tokenHeight, setTokenHeight] = useState('1');
  const [tokenShape, setTokenShape] = useState<TokenShape>('circle');
  const [tokenColor, setTokenColor] = useState(COLORS[0]);
  const [tokenScale, setTokenScale] = useState(1);
  const [placementSymbol, setPlacementSymbol] = useState<SymbolOption | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [editingSide, setEditingSide] = useState<'front' | 'back'>('front');
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const activeToken = tokens.find((token) => token.id === editingTokenId);
  const previewSize = useMemo(() => {
    if (!activeToken) return { width: 0, height: 0, unitsPerInch: 0 };
    const maxWidth = Math.max(100, stageSize.width - 24);
    const maxHeight = Math.max(100, stageSize.height - 24);
    const unitsPerInch = Math.min(maxWidth / activeToken.width, maxHeight / activeToken.height) * tokenScale;
    return {
      width: activeToken.width * unitsPerInch,
      height: activeToken.height * unitsPerInch,
      unitsPerInch,
    };
  }, [activeToken, stageSize, tokenScale]);

  const loadTokens = async () => {
    if (!projectId) {
      setTokens([]);
      return;
    }
    try {
      const rows = await db.getAllAsync<Token>(
        `SELECT id, project_id, surface_id, back_surface_id, name, shape,
          width_inches AS width, height_inches AS height, preview_scale, color
         FROM game_tokens WHERE project_id = ? ORDER BY name`,
        projectId
      );
      setTokens(rows);
    } catch (error) {
      console.error('Could not load tokens:', error);
      Alert.alert('Could not load tokens', 'Please try reopening the token editor.');
    }
  };

  useEffect(() => { void loadTokens(); }, [projectId]);

  useEffect(() => {
    if (!savedBackLibraryOpen) return;
    let cancelled = false;
    void db.getAllAsync<SavedTokenBack>(
      'SELECT id, name, artwork_json, created_at, updated_at FROM saved_token_backs ORDER BY updated_at DESC'
    ).then((rows) => { if (!cancelled) setSavedBacks(rows); }).catch((error) => {
      console.error('Could not load saved token backs:', error);
      Alert.alert('Could not load saved backs', 'Please try again.');
    });
    return () => { cancelled = true; };
  }, [db, savedBackLibraryOpen]);

  const openToken = (token: Token) => {
    setEditingTokenId(token.id);
    setTokenName(token.name);
    setTokenWidth(String(token.width));
    setTokenHeight(String(token.height));
    setTokenShape(token.shape);
    setTokenColor(token.color);
    setTokenScale(token.preview_scale);
    setPlacementSymbol(null);
    setIsMoving(false);
    setEditingSide('front');
  };

  const startNewToken = () => {
    setTokenName(`Token ${tokens.length + 1}`);
    setTokenWidth('1');
    setTokenHeight('1');
    setTokenShape('circle');
    setTokenColor(COLORS[0]);
    setTokenScale(1);
    setTokenDialogOpen(true);
  };

  const saveNewToken = async () => {
    const name = tokenName.trim();
    const width = parseDimension(tokenWidth);
    const height = parseDimension(tokenHeight);
    if (!projectId || !name || !width || !height) {
      Alert.alert('Check token details', 'Enter a name and positive width and height.');
      return;
    }
    const now = Date.now();
    const surfaceId = `${projectId}-token-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const backSurfaceId = `${surfaceId}-back`;
    try {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT INTO drawing_surfaces (id, project_id, kind, name, background_color)
           VALUES (?, ?, 'token', ?, ?)`,
          surfaceId, projectId, name, tokenColor
        );
        await db.runAsync(
          `INSERT INTO drawing_surfaces (id, project_id, kind, name, background_color)
           VALUES (?, ?, 'token', ?, ?)`,
          backSurfaceId, projectId, `${name} Back`, tokenColor
        );
        await db.runAsync(
          `INSERT INTO game_tokens
            (project_id, surface_id, back_surface_id, name, shape, width_inches, height_inches,
             preview_scale, color, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          projectId, surfaceId, backSurfaceId, name, tokenShape, width, height, tokenColor, now, now
        );
      });
      setTokenDialogOpen(false);
      setEditingTokenId(null);
      await loadTokens();
    } catch (error) {
      console.error('Could not create token:', error);
      Alert.alert('Could not create token', 'Please try again.');
    }
  };

  const saveTokenDetails = async () => {
    if (!activeToken) return;
    const name = tokenName.trim();
    const width = parseDimension(tokenWidth);
    const height = parseDimension(tokenHeight);
    if (!name || !width || !height) {
      Alert.alert('Check token details', 'Enter a name and positive width and height.');
      return;
    }
    try {
      await db.runAsync(
        `UPDATE game_tokens SET name = ?, shape = ?, width_inches = ?, height_inches = ?,
          preview_scale = ?, color = ?, updated_at = ? WHERE id = ?`,
        name, tokenShape, width, height, tokenScale, tokenColor, Date.now(), activeToken.id
      );
      await db.runAsync(
        'UPDATE drawing_surfaces SET name = ?, background_color = ? WHERE id = ?',
        name, tokenColor, activeToken.surface_id
      );
      await db.runAsync(
        'UPDATE drawing_surfaces SET name = ?, background_color = ? WHERE id = ?',
        `${name} Back`, tokenColor, activeToken.back_surface_id
      );
      invalidateSurfaceArtworkCache(activeToken.surface_id);
      if (activeToken.back_surface_id) invalidateSurfaceArtworkCache(activeToken.back_surface_id);
      setSizeDialogOpen(false);
      await loadTokens();
    } catch (error) {
      console.error('Could not save token settings:', error);
      Alert.alert('Could not save token settings', 'Please try again.');
    }
  };

  // A saved back stores the complete drawing surface, so background images,
  // strokes, and movable imported images are all reusable as one design.
  const saveCurrentBack = async () => {
    const backSurfaceId = activeToken?.back_surface_id;
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
      const strokes = await db.getAllAsync<TokenBackSnapshot['strokes'][number]>(
        'SELECT points_json, width, color, is_eraser, order_index, group_id FROM strokes WHERE surface_id = ? ORDER BY order_index',
        backSurfaceId
      );
      const images = await db.getAllAsync<TokenBackSnapshot['images'][number]>(
        'SELECT base64_data, mime_type, center_x, center_y, width, height, order_index FROM surface_images WHERE surface_id = ? ORDER BY order_index',
        backSurfaceId
      );
      const snapshot: TokenBackSnapshot = {
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
        'INSERT INTO saved_token_backs (name, artwork_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
        name, artworkJson, now, now
      );
      setSavedBacks((current) => [{ id: result.lastInsertRowId, name, artwork_json: artworkJson, created_at: now, updated_at: now }, ...current]);
      setSaveBackName('');
      setSaveBackOpen(false);
    } catch (error) {
      console.error('Could not save reusable token back:', error);
      Alert.alert('Could not save token back', 'Please try again.');
    }
  };

  const applySavedBack = async (template: SavedTokenBack) => {
    const backSurfaceId = activeToken?.back_surface_id;
    if (!backSurfaceId) return;
    try {
      const snapshot = JSON.parse(template.artwork_json) as TokenBackSnapshot;
      await db.runAsync('DELETE FROM strokes WHERE surface_id = ?', backSurfaceId);
      await db.runAsync('DELETE FROM surface_images WHERE surface_id = ?', backSurfaceId);
      await db.runAsync(
        'UPDATE drawing_surfaces SET background_color = ?, background_image_data = ?, background_image_mime_type = ? WHERE id = ?',
        snapshot.backgroundColor, snapshot.backgroundImage?.base64Data ?? null,
        snapshot.backgroundImage?.mimeType ?? null, backSurfaceId
      );
      for (const stroke of snapshot.strokes) {
        await db.runAsync(
          'INSERT INTO strokes (surface_id, points_json, width, color, is_eraser, order_index, group_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          backSurfaceId, stroke.points_json, stroke.width, stroke.color,
          stroke.is_eraser, stroke.order_index, stroke.group_id
        );
      }
      for (const image of snapshot.images) {
        await db.runAsync(
          'INSERT INTO surface_images (surface_id, base64_data, mime_type, center_x, center_y, width, height, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          backSurfaceId, image.base64_data, image.mime_type, image.center_x,
          image.center_y, image.width, image.height, image.order_index
        );
      }
      invalidateSurfaceArtworkCache(backSurfaceId);
      setCanvasRevision((revision) => revision + 1);
      setSavedBackLibraryOpen(false);
    } catch (error) {
      console.error('Could not apply saved token back:', error);
      Alert.alert('Could not apply token back', 'Please try again.');
    }
  };

  const renameSavedBack = async () => {
    const name = renameBackName.trim();
    if (!name || renameBackId === null) return;
    await db.runAsync('UPDATE saved_token_backs SET name = ?, updated_at = ? WHERE id = ?', name, Date.now(), renameBackId);
    setSavedBacks((current) => current.map((back) => back.id === renameBackId ? { ...back, name } : back));
    setRenameBackId(null);
    setSavedBackLibraryOpen(true);
  };

  const deleteSavedBack = (template: SavedTokenBack) => Alert.alert(
    'Delete saved back?', `Delete “${template.name}” from the reusable token back library?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await db.runAsync('DELETE FROM saved_token_backs WHERE id = ?', template.id);
        setSavedBacks((current) => current.filter((back) => back.id !== template.id));
      } },
    ]
  );

  const deleteToken = (token: Token) => Alert.alert(
    'Delete token?',
    `Remove “${token.name}” and its artwork?`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await db.withTransactionAsync(async () => {
            await db.runAsync('DELETE FROM game_tokens WHERE id = ?', token.id);
            await db.runAsync('DELETE FROM drawing_surfaces WHERE id = ?', token.surface_id);
            await db.runAsync('DELETE FROM drawing_surfaces WHERE id = ?', token.back_surface_id);
          });
          if (editingTokenId === token.id) setEditingTokenId(null);
          await loadTokens();
        } catch (error) {
          console.error('Could not delete token:', error);
          Alert.alert('Could not delete token', 'Please try again.');
        }
      } },
    ]
  );

  const renderDetailsDialog = (title: string, onSave: () => void, onCancel: () => void) => (
    <View style={s.backdrop}><View style={s.dialog}>
      <Text style={s.dialogTitle}>{title}</Text>
      <TextInput style={s.input} value={tokenName} onChangeText={setTokenName} placeholder="Token name" />
      <Text style={s.label}>Shape</Text>
      <View style={s.chips}>{SHAPES.map((shape) => (
        <Pressable key={shape} onPress={() => setTokenShape(shape)} style={[s.chip, tokenShape === shape && s.chipSelected]}>
          <Text style={tokenShape === shape ? s.chipTextSelected : s.chipText}>{shape}</Text>
        </Pressable>
      ))}</View>
      <Text style={s.label}>Dimensions (inches)</Text>
      <View style={s.dimensionRow}>
        <TextInput style={[s.input, s.dimensionInput]} value={tokenWidth} onChangeText={setTokenWidth} keyboardType="decimal-pad" placeholder="Width" />
        <Text style={s.by}>×</Text>
        <TextInput style={[s.input, s.dimensionInput]} value={tokenHeight} onChangeText={setTokenHeight} keyboardType="decimal-pad" placeholder="Height" />
      </View>
      {activeToken && <>
        <Text style={s.label}>Preview scale · {tokenScale.toFixed(2)}×</Text>
        <Slider minimumValue={0.5} maximumValue={2} step={0.05} value={tokenScale} onValueChange={setTokenScale} minimumTrackTintColor="#315EFB" maximumTrackTintColor="#D1D5DB" thumbTintColor="#315EFB" />
      </>}
      <Text style={s.label}>{activeToken ? 'Token color' : 'Starting token color'}</Text>
      <View style={s.chips}>{COLORS.map((color) => (
        <Pressable key={color} accessibilityLabel={`Choose color ${color}`} onPress={() => setTokenColor(color)} style={[s.swatch, { backgroundColor: color }, tokenColor === color && s.swatchSelected]} />
      ))}</View>
      <View style={s.dialogActions}>
        <Pressable style={s.secondaryButton} onPress={onCancel}><Text>Cancel</Text></Pressable>
        <Pressable style={s.primaryButton} onPress={onSave}><Text style={s.primaryText}>Save</Text></Pressable>
      </View>
    </View></View>
  );

  return (
    <View style={[s.screen, { paddingTop: topInset + 10, paddingBottom: bottomInset + 10 }]}>
      <View style={s.header}>
        <View style={s.headerText}>
          <Text style={s.title}>{activeToken ? 'Token Editor' : 'Tokens'}</Text>
          <Text style={s.subtitle}>{activeToken ? `${activeToken.name} · ${activeToken.shape}` : 'Reusable game tokens for this project'}</Text>
        </View>
        <View style={s.headerActions}>
          {activeToken && <Pressable style={s.headerButton} onPress={() => setEditingTokenId(null)}><Text style={s.headerButtonText}>Tokens</Text></Pressable>}
          <Pressable accessibilityRole="button" onPress={() => activeToken ? setEditingTokenId(null) : onClose()} style={s.close}><Text style={s.closeText}>Done</Text></Pressable>
        </View>
      </View>

      {activeToken ? <>
        <View style={s.editorActions}>
          <Pressable style={s.actionButton} onPress={() => setSymbolPickerOpen(true)}><Text style={s.actionButtonText}>Symbol</Text></Pressable>
          <Pressable style={s.actionButton} onPress={() => canvasRef.current?.importImage()}><Text style={s.actionButtonText}>Image</Text></Pressable>
          <Pressable style={[s.actionButton, isMoving && s.actionButtonSelected]} onPress={() => { setPlacementSymbol(null); setIsMoving((moving) => !moving); }}><Text style={s.actionButtonText}>{isMoving ? 'Moving' : 'Move'}</Text></Pressable>
          <Pressable style={s.actionButton} onPress={() => setSizeDialogOpen(true)}><Text style={s.actionButtonText}>Size</Text></Pressable>
        </View>
        <View style={s.faceTabs}>
          {(['front', 'back'] as const).map((face) => (
            <Pressable key={face} style={[s.faceTab, editingSide === face && s.faceTabSelected]} onPress={() => {
              setEditingSide(face);
              setPlacementSymbol(null);
              setIsMoving(false);
            }}>
              <Text style={[s.faceTabText, editingSide === face && s.faceTabTextSelected]}>
                {face === 'front' ? 'Edit Front' : 'Edit Back'}
              </Text>
            </Pressable>
          ))}
        </View>
        {editingSide === 'back' && <View style={s.backActions}>
          <Pressable style={s.backActionButton} onPress={() => { setSaveBackName(`Token Back ${savedBacks.length + 1}`); setSaveBackOpen(true); }}><Text style={s.backActionText}>Save This Back</Text></Pressable>
          <Pressable style={s.backActionButton} onPress={() => setSavedBackLibraryOpen(true)}><Text style={s.backActionText}>Saved Backs</Text></Pressable>
        </View>}
        <View style={s.previewStage} onLayout={(event) => setStageSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
          {previewSize.unitsPerInch > 0 && <View style={[s.tileCanvasFrame, { width: previewSize.width, height: previewSize.height, overflow: 'visible', borderRadius: 0, borderWidth: activeToken.shape === 'hexagon' || activeToken.shape === 'triangle' || activeToken.shape === 'circle' ? 0 : 1 }]}>
            <DrawingCanvas
              key={`${editingSide === 'front' ? activeToken.surface_id : activeToken.back_surface_id}-${canvasRevision}`}
              ref={canvasRef}
              bottomInset={0}
              topInset={4}
              surfaceId={editingSide === 'front' ? activeToken.surface_id : activeToken.back_surface_id}
              allowImageAsBackground
              defaultBackgroundColor={activeToken.color}
              compactToolbar
              expandCompactToolbar
              surfaceShape={activeToken.shape === 'hexagon' || activeToken.shape === 'triangle' || activeToken.shape === 'circle' ? activeToken.shape : undefined}
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
          <Text style={s.dimensionCaption}>{activeToken.width} × {activeToken.height} in · scale {tokenScale.toFixed(2)}×</Text>
        </View>
      </> : !projectId ? <Text style={s.empty}>Open a project to create its token library.</Text> : (
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>Token Types</Text>
            <Pressable style={s.primaryButton} onPress={startNewToken}><Text style={s.primaryText}>+ New Token</Text></Pressable>
          </View>
          {tokens.length === 0 ? <Text style={s.empty}>Create a token, then draw or add images to its face.</Text> : tokens.map((token) => (
            <View key={token.id} style={s.row}>
              <View style={[s.tilePreview, { backgroundColor: token.color, borderRadius: token.shape === 'circle' ? 22 : 8 }]}>
                <Text style={s.previewShape}>{token.shape === 'circle' ? '○' : token.shape === 'hexagon' ? '⬡' : token.shape === 'triangle' ? '△' : '□'}</Text>
              </View>
              <Pressable style={s.rowDetails} onPress={() => openToken(token)}>
                <Text style={s.rowTitle}>{token.name}</Text>
                <Text style={s.rowSubtitle}>{token.shape} · {token.width} × {token.height} in</Text>
              </Pressable>
              <Pressable style={s.editButton} onPress={() => openToken(token)}><Text style={s.editButtonText}>Edit</Text></Pressable>
              <Pressable accessibilityLabel={`Delete ${token.name}`} style={s.deleteButton} onPress={() => deleteToken(token)}><Text style={s.deleteText}>×</Text></Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={tokenDialogOpen} transparent animationType="fade" onRequestClose={() => setTokenDialogOpen(false)}>
        {renderDetailsDialog('New Token', () => void saveNewToken(), () => setTokenDialogOpen(false))}
      </Modal>
      <Modal visible={sizeDialogOpen} transparent animationType="fade" onRequestClose={() => setSizeDialogOpen(false)}>
        {renderDetailsDialog('Token Size & Appearance', () => void saveTokenDetails(), () => setSizeDialogOpen(false))}
      </Modal>
      <Modal visible={symbolPickerOpen} transparent animationType="fade" onRequestClose={() => setSymbolPickerOpen(false)}>
        <View style={s.backdrop}><View style={s.dialog}>
          <Text style={s.dialogTitle}>Choose a Symbol</Text>
          {symbols.length === 0 ? <Text style={s.empty}>Create a saved symbol in the Symbol Editor first.</Text> : (
            <ScrollView style={s.symbolOptions}>
              {symbols.map((symbol) => <Pressable key={symbol.id} style={s.symbolOption} onPress={() => { setPlacementSymbol(symbol); setIsMoving(false); setSymbolPickerOpen(false); }}>
                <Text style={s.rowTitle}>{symbol.name}</Text>
              </Pressable>)}
            </ScrollView>
          )}
          <View style={s.dialogActions}><Pressable style={s.secondaryButton} onPress={() => setSymbolPickerOpen(false)}><Text>Close</Text></Pressable></View>
        </View></View>
      </Modal>
      <Modal visible={saveBackOpen} transparent animationType="fade" onRequestClose={() => setSaveBackOpen(false)}>
        <View style={s.backdrop}><View style={s.dialog}>
          <Text style={s.dialogTitle}>Save Reusable Token Back</Text>
          <Text style={s.helper}>Save this back's background, drawings, and images for use on other tokens.</Text>
          <TextInput style={s.input} value={saveBackName} onChangeText={setSaveBackName} placeholder="Token back name" autoFocus selectTextOnFocus maxLength={60} returnKeyType="done" onSubmitEditing={() => void saveCurrentBack()} />
          <View style={s.dialogActions}>
            <Pressable style={s.secondaryButton} onPress={() => setSaveBackOpen(false)}><Text>Cancel</Text></Pressable>
            <Pressable style={s.primaryButton} onPress={() => void saveCurrentBack()}><Text style={s.primaryText}>Save</Text></Pressable>
          </View>
        </View></View>
      </Modal>
      <Modal visible={savedBackLibraryOpen} transparent animationType="fade" onRequestClose={() => setSavedBackLibraryOpen(false)}>
        <View style={s.backdrop}><View style={s.dialog}>
          <View style={s.backLibraryHeader}>
            <View><Text style={s.dialogTitle}>Saved Token Backs</Text><Text style={s.helper}>Choose a reusable design for this token.</Text></View>
            <Pressable style={s.deleteButton} accessibilityLabel="Close saved token backs" onPress={() => setSavedBackLibraryOpen(false)}><Text style={s.deleteText}>×</Text></Pressable>
          </View>
          {savedBacks.length === 0 ? <Text style={s.empty}>No saved backs yet. Draw a token back, then choose Save This Back.</Text> : (
            <ScrollView style={s.savedBackList} keyboardShouldPersistTaps="handled">
              {savedBacks.map((template) => <View key={template.id} style={s.savedBackRow}>
                <Pressable style={s.savedBackName} onPress={() => void applySavedBack(template)}><Text numberOfLines={2} style={s.rowTitle}>{template.name}</Text></Pressable>
                <Pressable style={s.backActionButton} onPress={() => { setSavedBackLibraryOpen(false); setRenameBackId(template.id); setRenameBackName(template.name); }}><Text style={s.backActionText}>Rename</Text></Pressable>
                <Pressable accessibilityLabel={`Delete ${template.name}`} style={s.deleteButton} onPress={() => deleteSavedBack(template)}><Text style={s.deleteText}>×</Text></Pressable>
              </View>)}
            </ScrollView>
          )}
        </View></View>
      </Modal>
      <Modal visible={renameBackId !== null} transparent animationType="fade" onRequestClose={() => setRenameBackId(null)}>
        <View style={s.backdrop}><View style={s.dialog}>
          <Text style={s.dialogTitle}>Rename Saved Back</Text>
          <TextInput style={s.input} value={renameBackName} onChangeText={setRenameBackName} autoFocus selectTextOnFocus maxLength={60} placeholder="Back name" />
          <View style={s.dialogActions}>
            <Pressable style={s.secondaryButton} onPress={() => { setRenameBackId(null); setSavedBackLibraryOpen(true); }}><Text>Cancel</Text></Pressable>
            <Pressable style={s.primaryButton} onPress={() => void renameSavedBack()}><Text style={s.primaryText}>Save</Text></Pressable>
          </View>
        </View></View>
      </Modal>
    </View>
  );
}
