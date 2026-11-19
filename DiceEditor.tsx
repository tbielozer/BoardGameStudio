import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { DrawingCanvas, type DrawingCanvasHandle } from './DrawingCanvas';
import { tileEditorStyles as s } from './tileEditorStyles';

type Die = {
  id: number;
  project_id: string;
  name: string;
  side_count: number;
  width_inches: number;
  height_inches: number;
  color: string;
};
type DieFace = { side_number: number; surface_id: string };
type DieWithFaces = Die & { faces: DieFace[] };
type SymbolOption = { id: number; name: string };

const PRESETS = [4, 6, 8, 10, 12, 20];
const parsePositiveNumber = (value: string) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

type Props = {
  projectId?: string;
  symbols: SymbolOption[];
  topInset: number;
  bottomInset: number;
  onClose: () => void;
};

/** Project library for multi-sided dice; every face owns its own drawing surface. */
export function DiceEditor({ projectId, symbols, topInset, bottomInset, onClose }: Props) {
  const db = useSQLiteContext();
  const canvasRef = useRef<DrawingCanvasHandle | null>(null);
  const [dice, setDice] = useState<DieWithFaces[]>([]);
  const [editingDieId, setEditingDieId] = useState<number | null>(null);
  const [activeSide, setActiveSide] = useState(1);
  const [newDieOpen, setNewDieOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [name, setName] = useState('');
  const [sideCountText, setSideCountText] = useState('6');
  const [widthText, setWidthText] = useState('1');
  const [heightText, setHeightText] = useState('1');
  const [placementSymbol, setPlacementSymbol] = useState<SymbolOption | null>(null);
  const [moving, setMoving] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const activeDie = dice.find((die) => die.id === editingDieId);
  const activeFace = activeDie?.faces.find((face) => face.side_number === activeSide);
  const facePreview = useMemo(() => {
    if (!activeDie) return { width: 0, height: 0, unitsPerInch: 0 };
    const maxEdge = Math.max(100, Math.min(360, stageSize.width - 28, stageSize.height - 28));
    const unitsPerInch = maxEdge / Math.max(activeDie.width_inches, activeDie.height_inches);
    return {
      width: activeDie.width_inches * unitsPerInch,
      height: activeDie.height_inches * unitsPerInch,
      unitsPerInch,
    };
  }, [activeDie, stageSize]);

  const loadDice = async () => {
    if (!projectId) { setDice([]); return; }
    try {
      const rows = await db.getAllAsync<Die>(
        'SELECT id, project_id, name, side_count, width_inches, height_inches, color FROM game_dice WHERE project_id = ? ORDER BY name',
        projectId
      );
      const faces = await db.getAllAsync<DieFace & { die_id: number }>(
        `SELECT face.die_id, face.side_number, face.surface_id
         FROM game_die_faces AS face JOIN game_dice AS die ON die.id = face.die_id
         WHERE die.project_id = ? ORDER BY face.die_id, face.side_number`,
        projectId
      );
      setDice(rows.map((die) => ({ ...die, faces: faces.filter((face) => face.die_id === die.id) })));
    } catch (error) {
      console.error('Could not load dice:', error);
      Alert.alert('Could not load dice', 'Please try reopening the Dice Editor.');
    }
  };

  useEffect(() => { void loadDice(); }, [projectId]);

  const openDie = (die: DieWithFaces) => {
    setEditingDieId(die.id);
    setActiveSide(1);
    setName(die.name);
    setWidthText(String(die.width_inches));
    setHeightText(String(die.height_inches));
    setSideCountText(String(die.side_count));
    setPlacementSymbol(null);
    setMoving(false);
  };

  const startNewDie = () => {
    setName(`Die ${dice.length + 1}`);
    setSideCountText('6');
    setWidthText('1');
    setHeightText('1');
    setNewDieOpen(true);
  };

  const createDie = async () => {
    const cleanName = name.trim();
    const sides = Number(sideCountText);
    const width = parsePositiveNumber(widthText);
    const height = parsePositiveNumber(heightText);
    if (!projectId || !cleanName || !Number.isSafeInteger(sides) || sides < 2 || sides > 100 || !width || !height) {
      Alert.alert('Check die details', 'Enter a name, dimensions, and a whole number of sides from 2 to 100.');
      return;
    }
    const now = Date.now();
    const color = '#FFFFFF';
    try {
      await db.withTransactionAsync(async () => {
        const result = await db.runAsync(
          'INSERT INTO game_dice (project_id, name, side_count, width_inches, height_inches, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          projectId, cleanName, sides, width, height, color, now, now
        );
        for (let side = 1; side <= sides; side += 1) {
          const surfaceId = `${projectId}-die-${result.lastInsertRowId}-face-${side}`;
          await db.runAsync(
            `INSERT INTO drawing_surfaces (id, project_id, kind, name, background_color)
             VALUES (?, ?, 'die', ?, ?)`,
            surfaceId, projectId, `${cleanName} · Side ${side}`, color
          );
          await db.runAsync(
            'INSERT INTO game_die_faces (die_id, side_number, surface_id) VALUES (?, ?, ?)',
            result.lastInsertRowId, side, surfaceId
          );
        }
      });
      setNewDieOpen(false);
      await loadDice();
    } catch (error) {
      console.error('Could not create die:', error);
      Alert.alert('Could not create die', 'Please try again.');
    }
  };

  const saveDetails = async () => {
    if (!activeDie) return;
    const cleanName = name.trim();
    const width = parsePositiveNumber(widthText);
    const height = parsePositiveNumber(heightText);
    if (!cleanName || !width || !height) {
      Alert.alert('Check die details', 'Enter a name and positive dimensions.');
      return;
    }
    try {
      await db.runAsync(
        'UPDATE game_dice SET name = ?, width_inches = ?, height_inches = ?, updated_at = ? WHERE id = ?',
        cleanName, width, height, Date.now(), activeDie.id
      );
      for (const face of activeDie.faces) {
        await db.runAsync('UPDATE drawing_surfaces SET name = ? WHERE id = ?', `${cleanName} · Side ${face.side_number}`, face.surface_id);
      }
      setDetailsOpen(false);
      await loadDice();
    } catch (error) {
      console.error('Could not save die settings:', error);
      Alert.alert('Could not save die settings', 'Please try again.');
    }
  };

  const deleteDie = (die: DieWithFaces) => Alert.alert('Delete die?', `Remove “${die.name}” and all its faces?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => {
      try {
        await db.withTransactionAsync(async () => {
          await db.runAsync('DELETE FROM game_dice WHERE id = ?', die.id);
          for (const face of die.faces) await db.runAsync('DELETE FROM drawing_surfaces WHERE id = ?', face.surface_id);
        });
        if (editingDieId === die.id) setEditingDieId(null);
        await loadDice();
      } catch (error) {
        console.error('Could not delete die:', error);
        Alert.alert('Could not delete die', 'Please try again.');
      }
    } },
  ]);

  const renderDetails = (title: string, onSave: () => void, onCancel: () => void, creating: boolean) => (
    <View style={s.backdrop}><View style={s.dialog}>
      <Text style={s.dialogTitle}>{title}</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Die name" />
      {creating && <>
        <Text style={s.label}>Number of sides</Text>
        <View style={s.chips}>{PRESETS.map((count) => (
          <Pressable key={count} style={[s.chip, sideCountText === String(count) && s.chipSelected]} onPress={() => setSideCountText(String(count))}>
            <Text style={sideCountText === String(count) ? s.chipTextSelected : s.chipText}>d{count}</Text>
          </Pressable>
        ))}</View>
        <TextInput style={s.input} value={sideCountText} onChangeText={setSideCountText} keyboardType="number-pad" placeholder="Custom sides (2–100)" />
      </>}
      <Text style={s.label}>Face dimensions (inches)</Text>
      <View style={s.dimensionRow}>
        <TextInput style={[s.input, s.dimensionInput]} value={widthText} onChangeText={setWidthText} keyboardType="decimal-pad" placeholder="Width" />
        <Text style={s.by}>×</Text>
        <TextInput style={[s.input, s.dimensionInput]} value={heightText} onChangeText={setHeightText} keyboardType="decimal-pad" placeholder="Height" />
      </View>
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
          <Text style={s.title}>{activeDie ? 'Dice Editor' : 'Dice'}</Text>
          <Text style={s.subtitle}>{activeDie ? `${activeDie.name} · Side ${activeSide} of ${activeDie.side_count}` : 'Create dice with editable faces'}</Text>
        </View>
        <View style={s.headerActions}>
          {activeDie && <Pressable style={s.headerButton} onPress={() => setEditingDieId(null)}><Text style={s.headerButtonText}>Dice</Text></Pressable>}
          <Pressable onPress={() => activeDie ? setEditingDieId(null) : onClose()} style={s.close}><Text style={s.closeText}>Done</Text></Pressable>
        </View>
      </View>

      {activeDie ? <>
        <View style={s.editorActions}>
          <Pressable style={s.actionButton} onPress={() => setSymbolPickerOpen(true)}><Text style={s.actionButtonText}>Symbol</Text></Pressable>
          <Pressable style={s.actionButton} onPress={() => canvasRef.current?.importImage()}><Text style={s.actionButtonText}>Image</Text></Pressable>
          <Pressable style={[s.actionButton, moving && s.actionButtonSelected]} onPress={() => { setPlacementSymbol(null); setMoving((value) => !value); }}><Text style={s.actionButtonText}>{moving ? 'Moving' : 'Move'}</Text></Pressable>
          <Pressable style={s.actionButton} onPress={() => setDetailsOpen(true)}><Text style={s.actionButtonText}>Size</Text></Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.faceTabs}>
          {activeDie.faces.map((face) => (
            <Pressable key={face.side_number} style={[s.faceTab, { flexGrow: 0, flexShrink: 0, minWidth: 60 }, activeSide === face.side_number && s.faceTabSelected]} onPress={() => {
              setActiveSide(face.side_number);
              setPlacementSymbol(null);
              setMoving(false);
            }}>
              <Text style={[s.faceTabText, activeSide === face.side_number && s.faceTabTextSelected]}>Side {face.side_number}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={s.previewStage} onLayout={(event) => setStageSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
          {activeFace && facePreview.unitsPerInch > 0 && <View style={[s.tileCanvasFrame, { width: facePreview.width, height: facePreview.height, borderRadius: 0 }]}>
            <DrawingCanvas
              key={activeFace.surface_id}
              ref={canvasRef}
              bottomInset={0}
              topInset={4}
              surfaceId={activeFace.surface_id}
              defaultBackgroundColor={activeDie.color}
              compactToolbar
              expandCompactToolbar
              coordinateScale={facePreview.unitsPerInch}
              placementSymbolId={placementSymbol?.id}
              placementSymbolName={placementSymbol?.name}
              repeatSymbolPlacement
              placementSymbolScale={0.2 / Math.max(facePreview.unitsPerInch, 0.01)}
              onSymbolPlaced={() => setPlacementSymbol(null)}
              isEditingSymbols={moving}
              onStopEditingSymbols={() => setMoving(false)}
            />
          </View>}
        </View>
      </> : !projectId ? <Text style={s.empty}>Open a project to create dice.</Text> : (
        <ScrollView contentContainerStyle={s.content}>
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>Dice Library</Text>
            <Pressable style={s.primaryButton} onPress={startNewDie}><Text style={s.primaryText}>+ New Die</Text></Pressable>
          </View>
          {dice.length === 0 ? <Text style={s.empty}>Create a die, then draw or add images to each side.</Text> : dice.map((die) => (
            <View key={die.id} style={s.row}>
              <View style={[s.tilePreview, { backgroundColor: die.color, borderRadius: 6 }]}><Text style={s.previewShape}>{die.side_count}</Text></View>
              <Pressable style={s.rowDetails} onPress={() => openDie(die)}>
                <Text style={s.rowTitle}>{die.name}</Text>
                <Text style={s.rowSubtitle}>d{die.side_count} · {die.width_inches} × {die.height_inches} in per face</Text>
              </Pressable>
              <Pressable style={s.editButton} onPress={() => openDie(die)}><Text style={s.editButtonText}>Edit</Text></Pressable>
              <Pressable accessibilityLabel={`Delete ${die.name}`} style={s.deleteButton} onPress={() => deleteDie(die)}><Text style={s.deleteText}>×</Text></Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={newDieOpen} transparent animationType="fade" onRequestClose={() => setNewDieOpen(false)}>
        {renderDetails('New Die', () => void createDie(), () => setNewDieOpen(false), true)}
      </Modal>
      <Modal visible={detailsOpen} transparent animationType="fade" onRequestClose={() => setDetailsOpen(false)}>
        {renderDetails('Die Name & Dimensions', () => void saveDetails(), () => setDetailsOpen(false), false)}
      </Modal>
      <Modal visible={symbolPickerOpen} transparent animationType="fade" onRequestClose={() => setSymbolPickerOpen(false)}>
        <View style={s.backdrop}><View style={s.dialog}>
          <Text style={s.dialogTitle}>Choose a Symbol</Text>
          {symbols.length === 0 ? <Text style={s.empty}>Create a saved symbol in the Symbol Editor first.</Text> : (
            <ScrollView style={s.symbolOptions}>
              {symbols.map((symbol) => <Pressable key={symbol.id} style={s.symbolOption} onPress={() => { setPlacementSymbol(symbol); setMoving(false); setSymbolPickerOpen(false); }}>
                <Text style={s.rowTitle}>{symbol.name}</Text>
              </Pressable>)}
            </ScrollView>
          )}
          <View style={s.dialogActions}><Pressable style={s.secondaryButton} onPress={() => setSymbolPickerOpen(false)}><Text>Close</Text></Pressable></View>
        </View></View>
      </Modal>
    </View>
  );
}
