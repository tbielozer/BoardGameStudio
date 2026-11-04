import { Alert, Modal, Pressable, StyleSheet, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Canvas, Path, Skia, Circle, Group  } from '@shopify/react-native-skia';
import Slider from '@react-native-community/slider';
import { GestureHandlerRootView, GestureDetector, usePanGesture, useSimultaneousGestures, usePinchGesture } from 'react-native-gesture-handler';
import ColorPicker, { BrightnessSlider, Panel3, Preview } from 'reanimated-color-picker';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';

// This file is the main screen for the app.
// It controls which screen the user sees, manages custom symbols, and creates the
// layout for the home screen, game board, and symbol editor.
// If you are new to this file, read it top-to-bottom like this:
// 1) type definitions
// 2) the main App component
// 3) AppContent where the app state lives
// 4) the JSX that renders the screens
// 5) the style objects at the bottom

// These are the only screen names this app knows about right now.
// Think of these as the "pages" in the app.
type AppScreen = 
  'home' 
  | 'createGame' 
  | 'symbolLibrary'
  | 'symbolEditor'
  | 'projectPicker';

// A custom symbol is just a simple object with:
// - an id so we can identify it
// - a name so we can show it in the list
// This is a lightweight data model for now.
type SymbolItem = {
  id: number;
  name: string;
};

type Point = {
  x: number;
  y: number;
};

type Stroke = {
  points: Point[];
  width: number;
  eraser: boolean;
  color: string;
};

type SavedStrokeRow = {
  points_json: string;
  width: number;
  color: string;
  is_eraser: number;
};

type GameProject = {
  id: string;
  name: string;
  backgroundColor: string;
  strokes: Stroke[];
};

type ProjectRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
};

const SYMBOL_CANVAS_SIZE = 300;

async function initializeDatabase(db: SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drawing_surfaces (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      background_color TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS strokes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      points_json TEXT NOT NULL,
      width REAL NOT NULL,
      color TEXT NOT NULL,
      is_eraser INTEGER NOT NULL DEFAULT 0,
      order_index INTEGER NOT NULL,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );
  `);
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SQLiteProvider
          databaseName="board-game-studio.db"
          onInit={initializeDatabase}
        >
          <AppContent />
        </SQLiteProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function AppContent() {
  // useWindowDimensions() tells us how wide and tall the device screen is.
  // We use that to decide whether the home buttons should stack vertically
  // or sit side-by-side in landscape mode.
  const { width, height } = useWindowDimensions();

  // useSafeAreaInsets() gives us padding values for the top, bottom, left, and right
  // edges of the device screen. This helps us avoid content being hidden behind the
  // notch or home indicator on phones.
  const insets = useSafeAreaInsets();

  // isLandscape becomes true when the screen is wider than it is tall.
  const isLandscape = width > height;

  // buttonLayout picks the correct style object based on orientation.
  // This keeps the home buttons looking good on phones and tablets.
  const buttonLayout = isLandscape
    ? styles.buttonLandscape
    : styles.buttonPortrait;

  // screen stores the active page the user is viewing.
  // Example values: 'home', 'createGame', 'symbolLibrary', 'symbolEditor'.
  // setScreen is the function used to change the page.
  const [screen, setScreen] = useState<AppScreen>('home');

  // createMenuOpen controls whether the create-game dropdown menu is visible.
  // This is a true/false state value.
  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  // symbols holds the list of all user-created custom symbols.
  // It starts empty, and new items are added to the array as the user creates them.
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);

  // activeSymbolId remembers which symbol is currently selected.
  // This lets the app know which symbol to show in the editor screen.
  const [activeSymbolId, setActiveSymbolId] = useState<number | null>(null);

  // isSymbolPage is a shortcut boolean.
  // It is true whenever the current screen is either the library or editor.
  const isSymbolPage =
    screen === 'symbolLibrary' || screen === 'symbolEditor';

  // activeSymbol looks up the selected symbol object from the symbols array.
  // If no symbol is selected, this value will be undefined.
  const activeSymbol = symbols.find(
    (symbol) => symbol.id === activeSymbolId
  );

  const [symbolCanvasSize, setSymbolCanvasSize] = useState(0);

  // renameSymbolId keeps track of the symbol that is currently being renamed.
  // This is how the app knows which item the rename modal belongs to.
  // renameText stores the text the user is typing in the rename input.
  // We separate the current item's ID from the text so the app can update the correct
  // symbol in the list when the user taps Save.
  const [renameSymbolId, setRenameSymbolId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');

  const db = useSQLiteContext();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null);
  const [renameProjectText, setRenameProjectText] = useState('');

  const loadProjects = useCallback(async () => {
    try {
      const rows = await db.getAllAsync<ProjectRow>(
        'SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC'
      );
      setProjects(rows);
    } catch (error) {
      console.error('Could not load projects:', error);
    }
  }, [db]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const createProject = async () => {
    const id = Date.now().toString();
    const now = Date.now();
    const name = `Game ${projects.length + 1}`;

    await db.withTransactionAsync(async () => {
      await db.runAsync(
        'INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
        id, name, now, now
      );

      await db.runAsync(
        `INSERT INTO drawing_surfaces
        (id, project_id, kind, name, background_color)
        VALUES (?, ?, ?, ?, ?)`,
        `${id}-board`, id, 'board', 'Main Board', '#DDE8D2'
      );
    });

    await loadProjects();
    setActiveProjectId(id);
    setScreen('createGame');
  };

  const deleteProject = async (project: ProjectRow) => {
    await db.runAsync(
      'DELETE FROM projects WHERE id = ?',
      project.id
    );

    if (activeProjectId === project.id) {
      setActiveProjectId(null);
    }

    await loadProjects();
  };

  const saveProjectName = async () => {
    const newName = renameProjectText.trim();

    if (newName.length === 0 || renameProjectId === null) {
      return;
    }

    try {
      await db.runAsync(
        'UPDATE projects SET name = ?, updated_at = ? WHERE id = ?',
        newName,
        Date.now(),
        renameProjectId
      );

      await loadProjects();
      setRenameProjectId(null);
    } catch (error) {
      console.error('Could not rename project:', error);
      Alert.alert('Rename failed', 'The project name could not be saved.');
    }
  };

  if (screen === 'projectPicker') {
    return (
      <View style={styles.projectPickerScreen}>
        <Text style={styles.createTitle}>My Projects</Text>

        <ScrollView
          style={styles.projectScroll}
          contentContainerStyle={styles.projectGrid}
        >
          {projects.length === 0 ? (
            <Text>No projects yet. Create one to get started.</Text>
          ) : (
            projects.map((project) => (
              <View key={project.id} style={styles.projectTile}>
                <Pressable
                  style={({ pressed }) => [
                    styles.button,
                    styles.projectTileButton,
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={() => {
                    setActiveProjectId(project.id);
                    setScreen('createGame');
                  }}
                >
                  <Text style={styles.projectTileText}>{project.name}</Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${project.name}`}
                  style={styles.projectDeleteButton}
                  onPress={() =>
                    Alert.alert(
                      'Delete project?',
                      `Are you sure you want to delete "${project.name}"?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: () => void deleteProject(project),
                        },
                      ]
                    )
                  }
                >
                  <Text>🗑</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${project.name}`}
                  style={styles.projectRenameButton}
                  onPress={() => {
                    setRenameProjectText(project.name);
                    setRenameProjectId(project.id);
                  }}
                >
                  <Text>✎</Text>
                </Pressable>
              </View>
            ))
          )}
        </ScrollView>

        <View style={styles.projectActions}>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.projectActionButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={() => setScreen('home')}
          >
            <Text style={styles.buttonText}>Back</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.projectActionButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={createProject}
          >
            <Text style={styles.buttonText}>New Project</Text>
          </Pressable>
        </View>
        <Modal
          visible={renameProjectId !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setRenameProjectId(null)}
        >
          <View style={styles.renameBackdrop}>
            <View style={styles.renameDialog}>
              <Text style={styles.menuTitle}>Rename project</Text>

              <TextInput
                style={styles.renameInput}
                value={renameProjectText}
                onChangeText={setRenameProjectText}
                autoFocus
                selectTextOnFocus
                placeholder="Project name"
              />

              <View style={styles.renameActions}>
                <Pressable
                  style={styles.renameActionButton}
                  onPress={() => setRenameProjectId(null)}
                >
                  <Text>Cancel</Text>
                </Pressable>

                <Pressable
                  style={styles.renameActionButton}
                  onPress={() => void saveProjectName()}
                >
                  <Text>Save</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  // This if statement decides which screen layout to show.
  // The board-based screens reuse the same base mat background, while home uses a
  // simpler landing screen. This keeps the game area consistent even when the user
  // opens the symbol editor or menu overlay.
  // If the user is on the create-game page or on either symbol page, we show the
  // game mat background and overlay panels instead of the main menu.
  if (screen === 'createGame' || isSymbolPage) {
    return (
      <View style={styles.gameCanvas}>
        {/* This is the big background area behind the menu and symbol panels.
            Think of it like the tabletop or game mat. Right now it's just a placeholder.
            The rest of the UI sits on top of it. */}
        <DrawingCanvas
          key={activeProjectId ?? 'no-project'}
          bottomInset={0}
          surfaceId={activeProjectId ? `${activeProjectId}-board` : undefined}
        />

        {/* A colored status bar at the top of the screen to avoid the content feeling
            cut off behind the device notch or notch-safe area. */}
        <View pointerEvents="none" style={[styles.topLine, { height: insets.top }]} />

        {/* The game menu appears only while the user is on the create-game screen.
            It is either an open dropdown or a small hamburger button depending on
            whether createMenuOpen is true or false. */}
        {screen === 'createGame' && (
          createMenuOpen ? (
            <View
              style={[
                styles.dropdown,
                {
                  top: insets.top,
                  right: insets.right,
                },
              ]}
            >
              <View style={styles.menuHeader}>
                <Text style={styles.menuTitle}>
                  {projects.find((project) => project.id === activeProjectId)?.name ?? 'Game Name'}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close menu"
                  style={styles.closeButton}
                  onPress={() => setCreateMenuOpen(false)}
                >
                  <Text style={styles.closeText}>×</Text>
                </Pressable>
              </View>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setScreen('home');
                }}
              >
                <Text>Return to Menu</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setScreen('symbolLibrary');
                }}
              >
                <Text>Open Symbol Editor</Text>
              </Pressable>
            </View>
          ) : (
            // Hamburger button opens the in-game menu panel.
            <Pressable
              style={[
                styles.menuButton,
                { top: insets.top + 5, right: insets.right + 5 },
              ]}
              onPress={() => setCreateMenuOpen(true)}
            >
              <Text style={styles.menuButtonText}>☰</Text>
            </Pressable>
          )
        )}

        {/* Symbol library and editor appear as floating overlays on top of the mat.
            In React, we can show one panel or another using a condition like
            screen === 'symbolLibrary' or screen === 'symbolEditor'. */}
        {isSymbolPage && (
          <View
            style={[
              styles.symbolOverlay,
              {
                paddingTop: insets.top + 12,
                paddingBottom: insets.bottom + 12,
              },
            ]}
          >
            <View style={styles.symbolPanel}>
              {screen === 'symbolLibrary' ? (
                <View style={styles.symbolPageContent}>
                  {/* This is the library panel where the user can:
                      - create a new symbol
                      - click an existing symbol to edit it
                      - delete a symbol from the list */}
                  <View style={styles.libraryHeader}>
                    <Text style={styles.createTitle}>Custom Symbols</Text>

                    <View style={styles.libraryHeaderActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Create new symbol"
                        style={styles.libraryIconButton}
                        onPress={() => {
                          // Create a brand-new symbol with a unique ID based on the
                          // current timestamp. This keeps each symbol unique while the
                          // app is still in memory.
                          const id = Date.now();
                          const newSymbol = {
                            id,
                            name: `Symbol ${symbols.length + 1}`,
                          };

                          setSymbols((current) => [...current, newSymbol]);
                          setActiveSymbolId(id);
                          setScreen('symbolEditor');
                        }}
                      >
                        <Text style={styles.libraryIconText}>+</Text>
                      </Pressable>

                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Close symbol library"
                        style={styles.libraryIconButton}
                        onPress={() => setScreen('createGame')}
                      >
                        <Text style={styles.libraryIconText}>×</Text>
                      </Pressable>
                    </View>
                  </View>

                  {symbols.length === 0 ? (
                    // This is the empty-state message.
                    // It shows up before the user has created any symbols.
                    <Text>You haven’t made any symbols yet.</Text>
                  ) : (
                    // Render every saved symbol as a row with a name button and
                    // delete action.
                    // This is a classic React pattern: map over an array and return UI.
                    // Each item becomes a row in the symbol library.
                    symbols.map((symbol) => (
                      <View key={symbol.id} style={styles.symbolRow}>
                        <Pressable
                          style={styles.symbolNameButton}
                          onPress={() => {
                            // Selecting a symbol tells the app which one should be opened for editing.
                            setActiveSymbolId(symbol.id);
                            setScreen('symbolEditor');
                          }}
                        >
                          <Text>{symbol.name}</Text>
                        </Pressable>

                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Rename ${symbol.name}`}
                          style={styles.renameButton}
                          onPress={() => {
                            // Fill the rename modal with the current symbol name, then store the
                            // selected symbol ID so the Save action knows which item to update.
                            setRenameText(symbol.name);
                            setRenameSymbolId(symbol.id);
                          }}
                        >
                          <Text style={styles.renameButtonText}>✎</Text>
                        </Pressable>

                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Delete ${symbol.name}`}
                          style={styles.deleteButton}
                          onPress={() =>
                            Alert.alert(
                              'Delete symbol?',
                              `Are you sure you want to delete "${symbol.name}"?`,
                              [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Delete',
                                  style: 'destructive',
                                  onPress: () => {
                                    // Remove the symbol from the list and clear the
                                    // active selection if the deleted item was selected.
                                    setSymbols((current) =>
                                      current.filter((item) => item.id !== symbol.id)
                                    );
                                    setActiveSymbolId((currentId) =>
                                      currentId === symbol.id ? null : currentId
                                    );
                                  },
                                },
                              ]
                            )
                          }
                        >
                          <Text style={styles.deleteButtonText}>🗑</Text>
                        </Pressable>
                      </View>
                    ))
                  )}

                  {/* Modal = a popup layer that appears over the app.
                      We use this for renaming because it gives the user a focused input
                      without leaving the symbol library page. */}
                  <Modal
                    visible={renameSymbolId !== null}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setRenameSymbolId(null)}
                  >
                    <View style={styles.renameBackdrop}>
                      <View style={styles.renameDialog}>
                        <Text style={styles.menuTitle}>Rename symbol</Text>

                        <TextInput
                          style={styles.renameInput}
                          value={renameText}
                          onChangeText={setRenameText}
                          autoFocus
                          selectTextOnFocus
                          placeholder="Symbol name"
                        />

                        <View style={styles.renameActions}>
                          <Pressable
                            style={styles.renameActionButton}
                            onPress={() => setRenameSymbolId(null)}
                          >
                            <Text>Cancel</Text>
                          </Pressable>

                          <Pressable
                            style={styles.renameActionButton}
                            onPress={() => {
                              // Trim removes extra whitespace so the user cannot save a blank
                              // name. If the result is empty, we do nothing.
                              const newName = renameText.trim();

                              if (newName.length === 0 || renameSymbolId === null) {
                                return;
                              }

                              // Update only the matching symbol in the array.
                              // The map function goes through each item and changes the one with the
                              // same id. All other symbols stay untouched.
                              setSymbols((current) =>
                                current.map((item) =>
                                  item.id === renameSymbolId
                                    ? { ...item, name: newName }
                                    : item
                                )
                              );
                              setRenameSymbolId(null);
                            }}
                          >
                            <Text>Save</Text>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  </Modal>
                </View>
              ) : (
                // The editor view shows the selected symbol title and leaves room for
                // future drawing tools, palettes, and canvas implementation.
                <View style={styles.symbolPageContent}>
                  <View style={styles.libraryHeader}>
                    <Text style={styles.createTitle}>
                      {activeSymbol?.name ?? 'Symbol Editor'}
                    </Text>

                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Back to My Symbols"
                      style={styles.libraryIconButton}
                      onPress={() => setScreen('symbolLibrary')}
                    >
                      <Text style={[styles.libraryIconText, styles.backArrowText]}>←</Text>
                    </Pressable>
                  </View>
                  <View style={styles.symbolDrawingAreaContainer}>
                    <View
                      style={[
                        styles.symbolDrawingArea,
                        {
                          width: SYMBOL_CANVAS_SIZE,
                          height: SYMBOL_CANVAS_SIZE,
                        },
                      ]}
                    >
                      <DrawingCanvas bottomInset={0} transparentBackground />
                  </View>
                    {symbolCanvasSize > 0 && (
                      <View
                        style={[
                          styles.symbolDrawingArea,
                          { width: symbolCanvasSize, height: symbolCanvasSize },
                        ]}
                      >
                        <DrawingCanvas bottomInset={0} transparentBackground />
                      </View>
                    )}
                  </View>
                </View>
              )}
            </View>
          </View>
        )}
      </View>
    );
  }

  // Default landing screen for the app. This menu lets the user start creating a
  // game or access the planned play/join flows.
  // This is the first view the user sees when they open the app.
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Board Game Studio</Text>

      <View style={[styles.buttons, isLandscape && styles.buttonsLandscape]}>
        <Pressable
          style={({ pressed }) => [
            styles.button,
            buttonLayout,
            pressed && styles.buttonPressed,
          ]}
          onPress={() => setScreen('projectPicker')}
        >
          <Text style={styles.buttonText}>Create Game</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.button,
            buttonLayout,
            pressed && styles.buttonPressed,
          ]}
          onPress={() => Alert.alert('Play Game', 'We’ll build this next.')}
        >
          <Text style={styles.buttonText}>Play Game</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.button,
            buttonLayout,
            pressed && styles.buttonPressed,
          ]}
          onPress={() => Alert.alert('Join Game', 'We’ll build this next.')}
        >
          <Text style={styles.buttonText}>Join Game</Text>
        </Pressable>
      </View>
    </View>
  );
}

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

// DrawingCanvas is the main custom drawing area for the symbol editor.
// It handles the user's touch input, draws each stroke onto a canvas, supports erasing,
// allows changing the background color, and gives access to pen color and line width tools.
function DrawingCanvas({
    bottomInset,
    transparentBackground = false,
    surfaceId,
  }: {
    bottomInset: number;
    transparentBackground?: boolean;
    surfaceId?: string;
  }) {

  const db = useSQLiteContext();
  // lineWidth controls stroke thickness for the pen tool.
  const [lineWidth, setLineWidth] = useState(4);

  // isErasing switches between pen mode and eraser mode.
  const [isErasing, setIsErasing] = useState(false);

  // strokes stores all completed lines that have been drawn and finalized.
  const [strokes, setStrokes] = useState<Stroke[]>([]);

  // draft is the stroke currently being drawn while the user is touching the screen.
  // It is separate from strokes so we can show the live-in-progress path before it is saved.
  const [draft, setDraft] = useState<Stroke | null>(null);

  // draftRef keeps the current stroke in a ref so it can be updated quickly without forcing
  // a re-render on every movement. This is important for smooth drawing behavior.
  const draftRef = useRef<Stroke | null>(null);

  // eraserPosition tracks the current touch point while erasing so we can show a small
  // circular cursor on the canvas.
  const [eraserPosition, setEraserPosition] = useState<Point | null>(null);

  // backgroundColor is the color behind the drawing area.
  const [backgroundColor, setBackgroundColor] = useState('#DDE8D2');

  // penColor is the color used by the pen tool.
  const [penColor, setPenColor] = useState('#111827');

  // colorPickerTarget tells us whether the color picker is for the board background or pen color.
  // When it is null, the modal is closed.
  const [colorPickerTarget, setColorPickerTarget] =
    useState<'background' | 'pen' | null>(null);

  useEffect(() => {
    if (!surfaceId) return;

    let cancelled = false;

    const loadBoard = async () => {
      try {
        const rows = await db.getAllAsync<SavedStrokeRow>(
          `SELECT points_json, width, color, is_eraser
          FROM strokes
          WHERE surface_id = ?
          ORDER BY order_index ASC`,
          surfaceId
        );

        if (!cancelled) {
          setStrokes(
            rows.map((row) => ({
              points: JSON.parse(row.points_json) as Point[],
              width: row.width,
              color: row.color,
              eraser: row.is_eraser === 1,
            }))
          );
        }
      } catch (error) {
        console.error('Could not load board strokes:', error);
      }
    };

    void loadBoard();

    return () => {
      cancelled = true;
    };
  }, [db, surfaceId]);

  // finishStroke saves the current draft as a finalized stroke when the user lifts their finger.
  // We only save it if it has more than one point, because a single tap would otherwise create
  // a tiny meaningless mark.
  const finishStroke = useCallback(() => {
    const finished = draftRef.current;

    if (finished && finished.points.length > 1) {
      setStrokes((current) => [...current, finished]);

      if (surfaceId) {
        void db.runAsync(
          `INSERT INTO strokes
            (surface_id, points_json, width, color, is_eraser, order_index)
          VALUES (
            ?, ?, ?, ?, ?,
            COALESCE(
              (SELECT MAX(order_index) + 1 FROM strokes WHERE surface_id = ?),
              0
            )
          )`,
          surfaceId,
          JSON.stringify(finished.points),
          finished.width,
          finished.color,
          finished.eraser ? 1 : 0,
          surfaceId
        ).catch((error) => {
          console.error('Could not save board stroke:', error);
        });
      }
    }

    draftRef.current = null;
    setDraft(null);
    setEraserPosition(null);
  }, [db, surfaceId]);

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

  // PanResponder handles touch gestures for drawing.
  // It listens for start, move, and release events so the app can collect points while the
  // user drags across the canvas.
  const drawGesture = usePanGesture({
    minPointers: 1,
    maxPointers: 1,
    runOnJS: true,

    onBegin: ({ x, y }) => {
      const point = {
        x: (x - boardOffsetRef.current.x) / zoomRef.current,
        y: (y - boardOffsetRef.current.y) / zoomRef.current,
      };

      const newStroke: Stroke = {
        points: [point],
        width: lineWidth,
        eraser: isErasing,
        color: penColor,
      };

      draftRef.current = newStroke;
      setDraft(newStroke);
      setEraserPosition(isErasing ? point : null);
    },

    onUpdate: ({ x, y }) => {
      const current = draftRef.current;
      if (!current) return;

      const point = {
        x: (x - boardOffsetRef.current.x) / zoomRef.current,
        y: (y - boardOffsetRef.current.y) / zoomRef.current,
      };
  
      const lastPoint = current.points[current.points.length - 1];
      const minDistance = 2 / zoomRef.current;

      const dx = point.x - lastPoint.x;
      const dy = point.y - lastPoint.y;

      if (dx * dx + dy * dy < minDistance * minDistance) {
        if (current.eraser) {
          setEraserPosition(point);
        }
        return;
      }

      const updatedStroke = {
        ...current,
        points: [...current.points, point],
      };

      draftRef.current = updatedStroke;
      setDraft(updatedStroke);

      if (current.eraser) {
        setEraserPosition(point);
      }
    },

    onFinalize: finishStroke,
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
      updateBoardOffset(
        panStartRef.current.x + event.translationX,
        panStartRef.current.y + event.translationY
      );
    },
  });

  const zoomGesture = usePinchGesture({
    runOnJS: true,

    onActivate: () => {
      pinchStartRef.current = zoomRef.current;
    },

    onUpdate: (event) => {
      const nextZoom = Math.max(
        0.5,
        Math.min(3, pinchStartRef.current * event.scale)
      );

      zoomRef.current = nextZoom;
      setZoom(nextZoom);
    },
  });

  const canvasGesture = useSimultaneousGestures(
    drawGesture,
    boardPanGesture,
    zoomGesture
  );

  // renderStroke takes a stroke object and converts it into a visible Skia path.
  // This keeps the render code repeatable for both saved strokes and the live draft.
  const renderStroke = (
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
  );
  const completedStrokePaths = useMemo(
    () => strokes.map((stroke) => pointsToPath(stroke.points)),
    [strokes]
  );

  return (
    <View
      style={[
        styles.matCanvas,
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
        <View style={styles.drawingTouchArea}>
          <Canvas style={StyleSheet.absoluteFill}>
            <Group
              transform={[
                { translateX: boardOffset.x },
                { translateY: boardOffset.y },
                { scale: zoom },
              ]}
            >
              {strokes.map((stroke, index) =>
                renderStroke(
                  stroke,
                  `stroke-${index}`,
                  completedStrokePaths[index]
                )
              )}

              {draft && renderStroke(draft, 'draft')}

              {isErasing && eraserPosition && (
                <Circle
                  cx={eraserPosition.x}
                  cy={eraserPosition.y}
                  r={lineWidth / 2}
                  color="#111827"
                  style="stroke"
                  strokeWidth={1.5}
                />
              )}
            </Group>
          </Canvas>
        </View>
      </GestureDetector>

      {/* The drawing toolbar sits above the canvas and stays at the bottom of the screen.
          It contains controls for board color, pen color, line width, and erasing. */}
      <View
        style={[
          styles.toolbarPosition,
          { bottom: bottomInset + 12 },
        ]}
      >
        <View style={styles.toolbarPanel}>
          {!transparentBackground && (
            <View style={styles.colorControl}>
              <Text style={styles.colorControlLabel}>Board</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Choose board background color"
                style={[
                  styles.backgroundColorButton,
                  { backgroundColor },
                ]}
                onPress={() => setColorPickerTarget('background')}
              />
            </View>
          )}

          <View style={styles.colorControl}>
            <Text style={styles.colorControlLabel}>Pen</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose pen color"
              style={[styles.backgroundColorButton, { backgroundColor: penColor }]}
              onPress={() => setColorPickerTarget('pen')}
            />
          </View>

          <Slider
            accessibilityLabel="Line width"
            style={styles.lineWidthSlider}
            minimumValue={1}
            maximumValue={50}
            step={1}
            value={lineWidth}
            onValueChange={setLineWidth}
            minimumTrackTintColor="#315EFB"
            maximumTrackTintColor="#9CA3AF"
            thumbTintColor="#111827"
          />

          <View style={styles.previewSlot}>
            <View
              style={[
                styles.brushPreview,
                isErasing && styles.eraserPreview,
                {
                  width: lineWidth,
                  height: lineWidth,
                  borderRadius: lineWidth / 2,
                  backgroundColor: isErasing ? 'transparent' : penColor,
                },
              ]}
            />
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isErasing ? 'Use pen' : 'Use eraser'}
            style={[styles.eraserButton, isErasing && styles.selectedTool]}
            onPress={() => setIsErasing((erasing) => !erasing)}
          >
             <Text>{isErasing ? 'Eraser ✓' : 'Eraser'}</Text>
          </Pressable>
        </View>
      </View>

      {/* The color picker is a modal popup that appears when the user taps a color swatch.
          It lets them choose the board or pen color without leaving the drawing screen. */}
      <Modal
        visible={colorPickerTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setColorPickerTarget(null)}
      >
        <View style={styles.colorPickerBackdrop}>
          <View style={styles.colorPickerDialog}>
            <Text style={styles.menuTitle}>
              {colorPickerTarget === 'pen' ? 'Pen color' : 'Board background'}
            </Text>

            <ColorPicker
              value={colorPickerTarget === 'pen' ? penColor : backgroundColor}
              onCompleteJS={({ hex }) => {
                // When the user picks a color, update the correct setting.
                if (colorPickerTarget === 'pen') {
                  setPenColor(hex);
                } else {
                  setBackgroundColor(hex);
                }
              }}
              style={styles.colorPicker}
            >
              <Preview style={styles.colorPickerPreview} />
              <Panel3 style={styles.colorWheel} />
              <BrightnessSlider style={styles.colorWheelSlider} />
            </ColorPicker>

            <Pressable
              style={styles.colorPickerDone}
              onPress={() => setColorPickerTarget(null)}
            >
              <Text style={styles.buttonText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  // STYLE SECTION
  // This is where all of the visual design is stored.
  // Each object below controls the look of a part of the app: the home screen,
  // buttons, menu, mat, and symbol panels.
  // If a section of the UI is not looking right, this is usually the place to fix it.

  //Home Screen
  screen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#F3F4F6',
  },
  title: {
    marginBottom: 32,
    color: '#111827',
    fontSize: 32,
    fontWeight: '700',
  },

  //Menu Buttons
  buttons: {
    width: '100%',
    maxWidth: 360,
  },
  buttonsLandscape: {
    flexDirection: 'row',
    maxWidth: 900,
    gap: 12,
  },
  buttonPortrait: {
    width: '100%',
    marginBottom: 14,
  },
  buttonLandscape: {
    flex: 1,
  },
  button: {
    maxWidth: 360,
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#000000'
  },
  buttonPressed: {
    backgroundColor: '#00ff3c',
    // opacity: 0.5,
  },
  buttonText: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '600',
  },

  //Create Game Screen
  createScreen: {
    flex: 1,
    padding: 24,
    backgroundColor: '#F3F4F6',
  },
  createHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  createTitle: {
    color: '#111827',
    fontSize: 28,
    fontWeight: '700',
  },

  //Menu Dropdown
  menuButton: {
    position: 'absolute',
    // top: 5,
    // right: 5,
    zIndex: 2,
    elevation: 5,
    padding: 12,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    opacity: 0.75,
  },
  menuButtonText: {
    color: '#000000',
    fontSize: 16,
  },
  dropdown: {
    position: 'absolute',
    // top: 0,
    // right: 0,
    bottom: 0,
    width: '20%',
    maxWidth: 360,
    zIndex: 3,
    elevation: 8,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    // borderRadius: 10,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    opacity: 0.75,
  },
  menuTitle: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '700',
  },
  menuOption: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  menuHeader: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 14,
    paddingRight: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#D1D5DB',
  },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#111827',
    fontSize: 28,
  },

  //Mat Placeholder
  matPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },


  gameCanvas: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#F3F4F6',
  },

  //Filler so top doesn't look like weird cut off
  topLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#6d706d',
    zIndex: 10,
  },

  //Symbols 
  symbolsScreen: {
    flex: 1,
    padding: 24,
    gap: 12,
    backgroundColor: '#F3F4F6',
  },

  symbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 8,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },

  symbolOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
    elevation: 10,
  },
  symbolPanel: {
    width: '88%',
    height: '88%',
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 1)',
    overflow: 'hidden',
  },
  symbolPageContent: {
    flex: 1,
    padding: 20,
    gap: 12,
  },

  libraryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  libraryHeaderActions: {
    flexDirection: 'row',
    gap: 8,
  },

  libraryIconButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },

  libraryIconText: {
    color: '#111827',
    fontSize: 26,
  },

  backArrowText: {
    transform: [{ translateY: -4 }],
  },

  symbolNameButton: {
    flex: 1,
    paddingVertical: 16,
  },

  deleteButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  deleteButtonText: {
    color: '#B91C1C',
    fontSize: 20,
  },


  renameButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameButtonText: {
    color: '#111827',
    fontSize: 22,
  },
  renameBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  renameDialog: {
    width: '100%',
    maxWidth: 360,
    gap: 12,
    padding: 20,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  renameInput: {
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  renameActionButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },

  matCanvas: {
    flex: 1,
    position: 'relative',
  },
  drawingTouchArea: {
    flex: 1,
  },
  toolbarPosition: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 20,
    elevation: 20,
  },
  toolbarScroll: {
    maxHeight: 58,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  toolbarLabel: {
    fontSize: 13,
    color: '#374151',
  },
  colorSwatch: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#6B7280',
  },
  selectedSwatch: {
    borderWidth: 3,
    borderColor: '#111827',
  },
  toolbarButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },
  sizeLabel: {
    minWidth: 20,
    textAlign: 'center',
  },
  eraserButton: {
    width: 62,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },
  selectedTool: {
    backgroundColor: '#FDE68A',
  },

  lineWidthSlider: {
    flex: 1,
    minWidth: 60,
    height: 36,
  },
  brushPreview: {
    backgroundColor: '#111827',
  },
  toolbarPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 6,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  lineWidthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  previewSlot: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eraserPreview: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: '#111827',
  },
  backgroundPalette: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backgroundColorButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  colorPickerBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  colorPickerDialog: {
    width: '100%',
    maxWidth: 360,
    gap: 14,
    padding: 20,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  colorPicker: {
    width: '100%',
    gap: 12,
  },
  colorPickerPreview: {
    height: 36,
    borderRadius: 8,
  },
  colorWheel: {
    width: '100%',
    aspectRatio: 1,
  },
  colorWheelSlider: {
    height: 30,
  },
  colorPickerDone: {
    alignSelf: 'flex-end',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#315EFB',
  },
  colorControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  colorControlLabel: {
    fontSize: 12,
    color: '#374151',
  },

  symbolDrawingAreaContainer: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },

  symbolDrawingArea: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
  },

  projectPickerScreen: {
    flex: 1,
    padding: 24,
    paddingBottom: 16,
    backgroundColor: '#F3F4F6',
  },

  projectPickerButton: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#000000',
  },

  projectPickerButtonPressed: {
    backgroundColor: '#E5E7EB',
  },

  projectPickerButtonText: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '600',
  },

  projectScroll: {
    flex: 1,
    marginTop: 16,
  },

  projectGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start',
    justifyContent: 'flex-start',
    gap: 12,
  },

  projectCard: {
    width: 150,
    height: 120,
    padding: 10,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },

  projectCardMain: {
    maxWidth: 360,
    flex: 1,
    justifyContent: 'center',
  },

  projectName: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '600',
  },

  projectDeleteButton: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 2,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },

  projectRenameButton: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 42,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },

  projectActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    paddingTop: 12,
  },

  projectActionButton: {
    flex: 1,
    maxWidth: 180,
    alignItems: 'center',
    paddingVertical: 14,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },

  projectActionText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '600',
  },

  projectTile: {
    width: '48%',
    maxWidth: 240,
    position: 'relative',
  },

  projectTileButton: {
    width: '100%',
    maxWidth: 260,
    paddingHorizontal: 28,
  },

  projectTileText: {
    textAlign: 'center',
    paddingHorizontal: 4,
  },
});