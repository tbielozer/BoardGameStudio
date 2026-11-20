import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import type { Stroke } from './types';
import { DrawingCanvas, type BoardDieVisual, type BoardTileDeckPlacement, type BoardTileVisual, type BoardTokenSupply, type DrawingCanvasHandle } from './DrawingCanvas';
import { CardEditor } from './CardEditor';
import { TileEditor } from './TileEditor';
import { TokenEditor } from './TokenEditor';
import { DiceEditor } from './DiceEditor';
import { GameplayPanel, type GameplayPanelHandle } from './GameplayPanel';
import { styles } from './styles';

// This file is the main screen for the app.
// It controls which screen the user sees, manages custom symbols, and creates the
// layout for the home screen, game board, and symbol editor.
// If you are new to this file, read it top-to-bottom like this:
// 1) type definitions
// 2) the main App component
// 3) AppContent where the app state lives
// 4) the JSX that renders the screens
// 5) styles.ts for the visual design

// These are the only screen names this app knows about right now.
// Think of these as the "pages" in the app.
type AppScreen = 
  'home' 
  | 'createGame' 
  | 'symbolLibrary'
  | 'symbolEditor'
  | 'cardEditor'
  | 'tileEditor'
  | 'tokenEditor'
  | 'diceEditor'
  | 'projectPicker';

// A custom symbol is just a simple object with:
// - an id so we can identify it
// - a name so we can show it in the list
// This is a lightweight data model for now.
type SymbolItem = {
  id: number;
  name: string;
};

type DeckSpotSetup = {
  spotType: 'deck' | 'discard';
  deckId: number | null;
  faceUp: boolean;
};

type DeckSpotDeckOption = {
  id: number;
  name: string;
  card_count: number;
};

type TileVisualOption = {
  id: number;
  name: string;
  shape: 'hexagon' | 'square' | 'triangle' | 'circle';
  width_inches: number;
  height_inches: number;
  color: string;
  surface_id: string;
  back_surface_id: string | null;
};

type TileDeckPlacementOption = {
  id: number;
  name: string;
  tile_count: number;
  top_tile_id: number | null;
  top_tile_name: string | null;
  top_tile_shape: TileVisualOption['shape'] | null;
  top_tile_width: number | null;
  top_tile_height: number | null;
  top_tile_color: string | null;
  top_tile_surface_id: string | null;
  top_tile_back_surface_id: string | null;
};

type TokenSupplyOption = {
  id: number;
  name: string;
  shape: BoardTileVisual['shape'];
  width_inches: number;
  height_inches: number;
  color: string;
  surface_id: string;
  back_surface_id: string | null;
};

type DiePlacementOption = BoardDieVisual;

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
      background_image_data TEXT,
      background_image_mime_type TEXT,
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
      group_id TEXT,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );

    -- Symbols belong to the user's shared library, not to an individual project.
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS symbol_strokes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol_id INTEGER NOT NULL,
      points_json TEXT NOT NULL,
      width REAL NOT NULL,
      color TEXT NOT NULL,
      is_eraser INTEGER NOT NULL DEFAULT 0,
      order_index INTEGER NOT NULL,
      FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
    );

    -- A saved card owns a dedicated drawing surface, so each card keeps its
    -- artwork and background separate while belonging to one project.
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      surface_id TEXT NOT NULL UNIQUE,
      back_surface_id TEXT UNIQUE,
      name TEXT NOT NULL,
      width_inches REAL NOT NULL DEFAULT 2.5,
      height_inches REAL NOT NULL DEFAULT 3.5,
      preview_scale REAL NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS card_images (
      card_id INTEGER PRIMARY KEY NOT NULL,
      base64_data TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS surface_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      base64_data TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      center_x REAL NOT NULL,
      center_y REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      order_index INTEGER NOT NULL,
      legacy_card_id INTEGER UNIQUE,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE,
      FOREIGN KEY (legacy_card_id) REFERENCES card_images(card_id) ON DELETE CASCADE
    );

    -- Deck and discard markers are points on the board with a saved facing.
    CREATE TABLE IF NOT EXISTS deck_spots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      orientation REAL NOT NULL DEFAULT 0,
      spot_type TEXT NOT NULL CHECK (spot_type IN ('deck', 'discard')),
      deck_id INTEGER,
      face_up INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );

    -- Tile snap points are simple board anchors: a position and a saved facing.
    CREATE TABLE IF NOT EXISTS tile_snap_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      orientation REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );

    -- Tile types and decks belong to one project. Deck items store tile counts.
    CREATE TABLE IF NOT EXISTS game_tiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      surface_id TEXT UNIQUE,
      back_surface_id TEXT UNIQUE,
      name TEXT NOT NULL,
      shape TEXT NOT NULL CHECK (shape IN ('hexagon', 'square', 'triangle', 'circle')),
      width_inches REAL NOT NULL,
      height_inches REAL NOT NULL,
      preview_scale REAL NOT NULL DEFAULT 1,
      color TEXT NOT NULL DEFAULT '#E9C46A',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );

    -- Reusable tokens keep their editable artwork on a dedicated drawing surface.
    CREATE TABLE IF NOT EXISTS game_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      surface_id TEXT NOT NULL UNIQUE,
      back_surface_id TEXT UNIQUE,
      name TEXT NOT NULL,
      shape TEXT NOT NULL CHECK (shape IN ('circle', 'square', 'hexagon', 'triangle')),
      width_inches REAL NOT NULL,
      height_inches REAL NOT NULL,
      preview_scale REAL NOT NULL DEFAULT 1,
      color TEXT NOT NULL DEFAULT '#E9C46A',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );

    -- A token supply is a map location with either a finite stock or no limit.
    CREATE TABLE IF NOT EXISTS token_supply_placements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      token_id INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      orientation REAL NOT NULL DEFAULT 0,
      quantity INTEGER CHECK (quantity IS NULL OR quantity > 0),
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE,
      FOREIGN KEY (token_id) REFERENCES game_tokens(id) ON DELETE CASCADE
    );

    -- Individual board tokens are separate from token supplies: they have no
    -- count badge and can be placed anywhere on the board.
    CREATE TABLE IF NOT EXISTS token_board_placements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      token_id INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      orientation REAL NOT NULL DEFAULT 0,
      face_up INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE,
      FOREIGN KEY (token_id) REFERENCES game_tokens(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tile_decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Back artwork templates can be reused across any project's tiles.
    CREATE TABLE IF NOT EXISTS saved_tile_backs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      artwork_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Token backs can be saved as templates and reused on other token types.
    CREATE TABLE IF NOT EXISTS saved_token_backs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      artwork_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- A die has its own editable drawing surface for each numbered side.
    CREATE TABLE IF NOT EXISTS game_dice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      side_count INTEGER NOT NULL CHECK (side_count BETWEEN 2 AND 100),
      width_inches REAL NOT NULL DEFAULT 1,
      height_inches REAL NOT NULL DEFAULT 1,
      color TEXT NOT NULL DEFAULT '#FFFFFF',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS game_die_faces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      die_id INTEGER NOT NULL,
      side_number INTEGER NOT NULL,
      surface_id TEXT NOT NULL UNIQUE,
      UNIQUE (die_id, side_number),
      FOREIGN KEY (die_id) REFERENCES game_dice(id) ON DELETE CASCADE,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS die_board_placements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      die_id INTEGER NOT NULL,
      face_number INTEGER NOT NULL DEFAULT 1,
      x REAL NOT NULL,
      y REAL NOT NULL,
      orientation REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE,
      FOREIGN KEY (die_id) REFERENCES game_dice(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tile_deck_items (
      deck_id INTEGER NOT NULL,
      tile_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (deck_id, tile_id),
      FOREIGN KEY (deck_id) REFERENCES tile_decks(id) ON DELETE CASCADE,
      FOREIGN KEY (tile_id) REFERENCES game_tiles(id) ON DELETE CASCADE
    );

    -- Tile faces and tile decks can be placed on the board as movable objects.
    CREATE TABLE IF NOT EXISTS tile_board_placements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id TEXT NOT NULL,
      tile_id INTEGER,
      deck_id INTEGER,
      x REAL NOT NULL,
      y REAL NOT NULL,
      orientation REAL NOT NULL DEFAULT 0,
      face_up INTEGER NOT NULL DEFAULT 1,
      CHECK ((tile_id IS NOT NULL AND deck_id IS NULL) OR (tile_id IS NULL AND deck_id IS NOT NULL)),
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE,
      FOREIGN KEY (tile_id) REFERENCES game_tiles(id) ON DELETE CASCADE,
      FOREIGN KEY (deck_id) REFERENCES tile_decks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS card_decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS card_deck_items (
      deck_id INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (deck_id, card_id),
      FOREIGN KEY (deck_id) REFERENCES card_decks(id) ON DELETE CASCADE,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    );

    -- A project's play state is separate from the reusable deck recipe. Each
    -- row represents one physical card copy in a board pile or a player hand.
    CREATE TABLE IF NOT EXISTS game_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS play_initialized_spots (
      project_id TEXT NOT NULL,
      spot_id INTEGER NOT NULL,
      deck_id INTEGER NOT NULL,
      initialized_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, spot_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (spot_id) REFERENCES deck_spots(id) ON DELETE CASCADE,
      FOREIGN KEY (deck_id) REFERENCES card_decks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS play_card_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      card_id INTEGER NOT NULL,
      deck_spot_id INTEGER,
      player_id INTEGER,
      face_up INTEGER NOT NULL DEFAULT 0,
      hand_order INTEGER NOT NULL DEFAULT 0,
      pile_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
      FOREIGN KEY (deck_spot_id) REFERENCES deck_spots(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES game_players(id) ON DELETE CASCADE
    );

    -- Named snapshots let a project keep multiple gameplay runs while the board
    -- setup and reusable deck recipes remain unchanged.
    CREATE TABLE IF NOT EXISTS gameplay_saves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Tiles returned during play are tracked separately from the saved deck
    -- recipe so Start Fresh can restore the original setup.
    CREATE TABLE IF NOT EXISTS gameplay_tile_deck_returns (
      project_id TEXT NOT NULL,
      deck_id INTEGER NOT NULL,
      tile_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, deck_id, tile_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (deck_id) REFERENCES tile_decks(id) ON DELETE CASCADE,
      FOREIGN KEY (tile_id) REFERENCES game_tiles(id) ON DELETE CASCADE
    );

    -- Token returns are also kept in the live game state, leaving supply
    -- quantities in the board setup untouched when a game is reset.
    CREATE TABLE IF NOT EXISTS gameplay_token_supply_returns (
      project_id TEXT NOT NULL,
      supply_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, supply_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (supply_id) REFERENCES token_supply_placements(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS gameplay_token_supply_takes (
      project_id TEXT NOT NULL,
      supply_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, supply_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (supply_id) REFERENCES token_supply_placements(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS gameplay_tile_deck_takes (
      project_id TEXT NOT NULL,
      deck_id INTEGER NOT NULL,
      tile_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, deck_id, tile_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (deck_id) REFERENCES tile_decks(id) ON DELETE CASCADE,
      FOREIGN KEY (tile_id) REFERENCES game_tiles(id) ON DELETE CASCADE
    );

    -- Piece transforms and returns belong to a live game, not the reusable
    -- board layout. Clearing these rows starts the project from its setup again.
    CREATE TABLE IF NOT EXISTS gameplay_tile_placement_states (
      project_id TEXT NOT NULL,
      placement_id INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      orientation REAL NOT NULL,
      face_up INTEGER NOT NULL,
      is_returned INTEGER NOT NULL DEFAULT 0,
      is_added INTEGER NOT NULL DEFAULT 0,
      returned_deck_id INTEGER,
      PRIMARY KEY (project_id, placement_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (placement_id) REFERENCES tile_board_placements(id) ON DELETE CASCADE,
      FOREIGN KEY (returned_deck_id) REFERENCES tile_decks(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS gameplay_token_placement_states (
      project_id TEXT NOT NULL,
      placement_id INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      orientation REAL NOT NULL,
      face_up INTEGER NOT NULL,
      is_returned INTEGER NOT NULL DEFAULT 0,
      is_added INTEGER NOT NULL DEFAULT 0,
      returned_supply_id INTEGER,
      PRIMARY KEY (project_id, placement_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (placement_id) REFERENCES token_board_placements(id) ON DELETE CASCADE,
      FOREIGN KEY (returned_supply_id) REFERENCES token_supply_placements(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS gameplay_die_placement_states (
      project_id TEXT NOT NULL,
      placement_id INTEGER NOT NULL,
      face_number INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, placement_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (placement_id) REFERENCES die_board_placements(id) ON DELETE CASCADE
    );

    -- Saved card backs are reusable across cards and projects. The artwork is
    -- stored as one JSON snapshot so a template can restore all its layers.
    CREATE TABLE IF NOT EXISTS saved_card_backs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      artwork_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // These runtime tables are created in newer schemas. Add their columns to
  // databases that already had the simpler transform-and-return records.
  const gameplayTileStateColumns = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(gameplay_tile_placement_states)'
  );
  if (!gameplayTileStateColumns.some((column) => column.name === 'is_added')) {
    await db.execAsync('ALTER TABLE gameplay_tile_placement_states ADD COLUMN is_added INTEGER NOT NULL DEFAULT 0');
  }
  const gameplayTokenStateColumns = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(gameplay_token_placement_states)'
  );
  if (!gameplayTokenStateColumns.some((column) => column.name === 'is_added')) {
    await db.execAsync('ALTER TABLE gameplay_token_placement_states ADD COLUMN is_added INTEGER NOT NULL DEFAULT 0');
  }

  // Existing token libraries only had a front. Add a separate back surface
  // once so old tokens can be edited on both sides without changing their art.
  const tokenColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(game_tokens)');
  if (!tokenColumns.some((column) => column.name === 'back_surface_id')) {
    await db.execAsync('ALTER TABLE game_tokens ADD COLUMN back_surface_id TEXT');
  }
  const tokensWithoutBack = await db.getAllAsync<{
    id: number; project_id: string; name: string; surface_id: string; color: string;
  }>('SELECT id, project_id, name, surface_id, color FROM game_tokens WHERE back_surface_id IS NULL');
  for (const token of tokensWithoutBack) {
    const backSurfaceId = `${token.surface_id}-back`;
    await db.runAsync(
      `INSERT OR IGNORE INTO drawing_surfaces (id, project_id, kind, name, background_color)
       VALUES (?, ?, 'token', ?, ?)`,
      backSurfaceId, token.project_id, `${token.name} Back`, token.color
    );
    await db.runAsync('UPDATE game_tokens SET back_surface_id = ? WHERE id = ?', backSurfaceId, token.id);
  }

  // Tiles created by earlier versions may not have their own drawing surface.
  // Add the optional fields once, then give older tiles a blank surface so they
  // can be opened in the drawing editor without losing their saved dimensions.
  const tileColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(game_tiles)');
  if (!tileColumns.some((column) => column.name === 'surface_id')) {
    await db.execAsync('ALTER TABLE game_tiles ADD COLUMN surface_id TEXT');
  }
  if (!tileColumns.some((column) => column.name === 'preview_scale')) {
    await db.execAsync('ALTER TABLE game_tiles ADD COLUMN preview_scale REAL NOT NULL DEFAULT 1');
  }
  if (!tileColumns.some((column) => column.name === 'back_surface_id')) {
    await db.execAsync('ALTER TABLE game_tiles ADD COLUMN back_surface_id TEXT');
  }
  const tilesWithoutSurface = await db.getAllAsync<{
    id: number; project_id: string; name: string; color: string; surface_id: string | null;
  }>('SELECT id, project_id, name, color, surface_id FROM game_tiles WHERE surface_id IS NULL');
  for (const tile of tilesWithoutSurface) {
    const surfaceId = `${tile.project_id}-tile-${tile.id}`;
    await db.runAsync(
      `INSERT OR IGNORE INTO drawing_surfaces (id, project_id, kind, name, background_color)
       VALUES (?, ?, 'tile', ?, ?)`,
      surfaceId, tile.project_id, tile.name, tile.color
    );
    await db.runAsync('UPDATE game_tiles SET surface_id = ? WHERE id = ?', surfaceId, tile.id);
  }
  const tilesWithoutBack = await db.getAllAsync<{
    id: number; project_id: string; name: string; surface_id: string; color: string;
  }>('SELECT id, project_id, name, surface_id, color FROM game_tiles WHERE back_surface_id IS NULL');
  for (const tile of tilesWithoutBack) {
    const backSurfaceId = `${tile.surface_id}-back`;
    await db.runAsync(
      `INSERT OR IGNORE INTO drawing_surfaces (id, project_id, kind, name, background_color)
       VALUES (?, ?, 'tile', ?, ?)`,
      backSurfaceId, tile.project_id, `${tile.name} Back`, tile.color
    );
    await db.runAsync('UPDATE game_tiles SET back_surface_id = ? WHERE id = ?', backSurfaceId, tile.id);
  }

  // Older databases already have a strokes table without group_id. Add the
  // optional column once so every stroke from one placed symbol can be undone as a unit.
  const strokeColumns = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(strokes)'
  );
  if (!strokeColumns.some((column) => column.name === 'group_id')) {
    await db.execAsync('ALTER TABLE strokes ADD COLUMN group_id TEXT');
  }

  // CREATE TABLE does not change an existing table. Add this column separately
  // so projects created by older app versions can still remember their board color.
  const drawingSurfaceColumns = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(drawing_surfaces)'
  );
  if (!drawingSurfaceColumns.some((column) => column.name === 'background_color')) {
    await db.execAsync('ALTER TABLE drawing_surfaces ADD COLUMN background_color TEXT');
  }
  if (!drawingSurfaceColumns.some((column) => column.name === 'background_image_data')) {
    await db.execAsync('ALTER TABLE drawing_surfaces ADD COLUMN background_image_data TEXT');
  }
  if (!drawingSurfaceColumns.some((column) => column.name === 'background_image_mime_type')) {
    await db.execAsync('ALTER TABLE drawing_surfaces ADD COLUMN background_image_mime_type TEXT');
  }

  // Existing markers can be linked to one of the project's saved decks and
  // remember whether their top card is displayed face up or face down.
  const deckSpotColumns = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(deck_spots)'
  );
  if (!deckSpotColumns.some((column) => column.name === 'deck_id')) {
    await db.execAsync('ALTER TABLE deck_spots ADD COLUMN deck_id INTEGER');
  }
  if (!deckSpotColumns.some((column) => column.name === 'face_up')) {
    await db.execAsync('ALTER TABLE deck_spots ADD COLUMN face_up INTEGER NOT NULL DEFAULT 1');
  }

  // Older cards have only a front surface. Give each one a saved back surface
  // so artwork and imported back images persist independently from the front.
  const cardColumns = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(cards)'
  );
  if (!cardColumns.some((column) => column.name === 'back_surface_id')) {
    await db.execAsync('ALTER TABLE cards ADD COLUMN back_surface_id TEXT');
  }
  const cardsWithoutBack = await db.getAllAsync<{
    id: number;
    project_id: string;
    surface_id: string;
    name: string;
  }>(
    `SELECT id, project_id, surface_id, name
    FROM cards WHERE back_surface_id IS NULL`
  );
  for (const card of cardsWithoutBack) {
    const backSurfaceId = `${card.surface_id}-back`;
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT OR IGNORE INTO drawing_surfaces
          (id, project_id, kind, name, background_color)
        VALUES (?, ?, ?, ?, ?)`,
        backSurfaceId,
        card.project_id,
        'card',
        `${card.name} Back`,
        '#FFFFFF'
      );
      await db.runAsync(
        'UPDATE cards SET back_surface_id = ? WHERE id = ?',
        backSurfaceId,
        card.id
      );
    });
  }

  // Move images from the earlier one-image-per-card format into reusable image
  // layers. legacy_card_id makes this migration safe to run at every startup.
  await db.execAsync(`
    INSERT OR IGNORE INTO surface_images
      (surface_id, base64_data, mime_type, center_x, center_y, width, height,
        order_index, legacy_card_id)
    SELECT cards.surface_id, card_images.base64_data, card_images.mime_type,
      cards.width_inches / 2, cards.height_inches / 2,
      cards.width_inches, cards.height_inches, 0, card_images.card_id
    FROM card_images
    JOIN cards ON cards.id = card_images.card_id;
  `);

  // Gameplay repeatedly asks for a pile's top card, the next hand position,
  // and each board surface's pieces. These indexes keep those reads bounded
  // by one pile/surface instead of scanning every saved card or placement.
  await db.execAsync(`
    -- Board previews store one lossless flattened face image for fast rendering.
    -- The original strokes and image layers stay editable; these rows are a cache.
    CREATE TABLE IF NOT EXISTS surface_artwork_rasters (
      surface_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      png_data BLOB NOT NULL,
      pixel_width INTEGER NOT NULL,
      pixel_height INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (surface_id, variant),
      FOREIGN KEY (surface_id) REFERENCES drawing_surfaces(id) ON DELETE CASCADE
    );

    CREATE TRIGGER IF NOT EXISTS invalidate_surface_raster_after_stroke_insert
    AFTER INSERT ON strokes BEGIN
      DELETE FROM surface_artwork_rasters WHERE surface_id = NEW.surface_id;
    END;
    CREATE TRIGGER IF NOT EXISTS invalidate_surface_raster_after_stroke_update
    AFTER UPDATE ON strokes BEGIN
      DELETE FROM surface_artwork_rasters WHERE surface_id IN (OLD.surface_id, NEW.surface_id);
    END;
    CREATE TRIGGER IF NOT EXISTS invalidate_surface_raster_after_stroke_delete
    AFTER DELETE ON strokes BEGIN
      DELETE FROM surface_artwork_rasters WHERE surface_id = OLD.surface_id;
    END;
    CREATE TRIGGER IF NOT EXISTS invalidate_surface_raster_after_image_insert
    AFTER INSERT ON surface_images BEGIN
      DELETE FROM surface_artwork_rasters WHERE surface_id = NEW.surface_id;
    END;
    CREATE TRIGGER IF NOT EXISTS invalidate_surface_raster_after_image_update
    AFTER UPDATE ON surface_images BEGIN
      DELETE FROM surface_artwork_rasters WHERE surface_id IN (OLD.surface_id, NEW.surface_id);
    END;
    CREATE TRIGGER IF NOT EXISTS invalidate_surface_raster_after_image_delete
    AFTER DELETE ON surface_images BEGIN
      DELETE FROM surface_artwork_rasters WHERE surface_id = OLD.surface_id;
    END;
    CREATE TRIGGER IF NOT EXISTS invalidate_surface_raster_after_background_update
    AFTER UPDATE OF background_color, background_image_data, background_image_mime_type ON drawing_surfaces BEGIN
      DELETE FROM surface_artwork_rasters WHERE surface_id = NEW.id;
    END;

    CREATE INDEX IF NOT EXISTS idx_play_cards_project_pile_order
      ON play_card_instances(project_id, deck_spot_id, player_id, pile_order, id);
    CREATE INDEX IF NOT EXISTS idx_play_cards_spot_order
      ON play_card_instances(deck_spot_id, player_id, pile_order, id);
    CREATE INDEX IF NOT EXISTS idx_play_cards_hand_order
      ON play_card_instances(project_id, player_id, hand_order, id);
    CREATE INDEX IF NOT EXISTS idx_deck_spots_surface
      ON deck_spots(surface_id, id);
    CREATE INDEX IF NOT EXISTS idx_tile_board_surface
      ON tile_board_placements(surface_id, id);
    CREATE INDEX IF NOT EXISTS idx_token_board_surface
      ON token_board_placements(surface_id, id);
    CREATE INDEX IF NOT EXISTS idx_token_supply_surface
      ON token_supply_placements(surface_id, id);
    CREATE INDEX IF NOT EXISTS idx_die_board_surface
      ON die_board_placements(surface_id, id);
    CREATE INDEX IF NOT EXISTS idx_strokes_surface_order
      ON strokes(surface_id, order_index);
    CREATE INDEX IF NOT EXISTS idx_surface_images_surface_order
      ON surface_images(surface_id, order_index);
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
  const [projectPickerMode, setProjectPickerMode] = useState<'create' | 'play'>('create');
  const [isPlaying, setIsPlaying] = useState(false);
  const [gameplayDrawFaceUp, setGameplayDrawFaceUp] = useState(false);
  const [handCardDropRequest, setHandCardDropRequest] = useState<{
    requestId: number; cardInstanceId: number; absoluteX: number; absoluteY: number;
  } | null>(null);
  const gameplayRef = useRef<GameplayPanelHandle | null>(null);
  const handDropRequestCounterRef = useRef(0);
  const boardCanvasRef = useRef<DrawingCanvasHandle | null>(null);
  const notifyGameplayPilesChanged = useCallback((spotIds?: number[]) => {
    boardCanvasRef.current?.refreshGameplayPiles(spotIds);
  }, []);
  const notifyGameplayStateChanged = useCallback(() => {
    boardCanvasRef.current?.refreshGameplayState();
  }, []);

  // createMenuOpen controls whether the create-game dropdown menu is visible.
  // This is a true/false state value.
  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  // symbols holds the shared custom-symbol library loaded from SQLite on startup.
  // Creating, renaming, and deleting symbols updates both this list and the database.
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);

  // activeSymbolId remembers which symbol is currently selected.
  // This lets the app know which symbol to show in the editor screen.
  const [activeSymbolId, setActiveSymbolId] = useState<number | null>(null);
  const [isPlacingSymbol, setIsPlacingSymbol] = useState(false);
  const [pendingSymbolId, setPendingSymbolId] = useState<number | null>(null);
  const [isEditingSymbols, setIsEditingSymbols] = useState(false);
  const [pendingDeckSpot, setPendingDeckSpot] = useState<DeckSpotSetup | null>(null);
  const [deckSpotSetupStep, setDeckSpotSetupStep] = useState<'choice' | 'deck' | 'face' | null>(null);
  const [deckSpotDeckOptions, setDeckSpotDeckOptions] = useState<DeckSpotDeckOption[]>([]);
  const [chosenDeckSpotDeckId, setChosenDeckSpotDeckId] = useState<number | null>(null);
  const [isPlacingTileSnapPoint, setIsPlacingTileSnapPoint] = useState(false);
  const [tilePlacementMode, setTilePlacementMode] = useState<'tile' | 'deck' | null>(null);
  const [tilePlacementOptions, setTilePlacementOptions] = useState<TileVisualOption[]>([]);
  const [diePlacementOptions, setDiePlacementOptions] = useState<DiePlacementOption[]>([]);
  const [diePlacementPickerOpen, setDiePlacementPickerOpen] = useState(false);
  const [tileDeckPlacementOptions, setTileDeckPlacementOptions] = useState<TileDeckPlacementOption[]>([]);
  const [pendingBoardTile, setPendingBoardTile] = useState<BoardTileVisual | null>(null);
  const [pendingBoardDie, setPendingBoardDie] = useState<BoardDieVisual | null>(null);
  const [pendingTileDeck, setPendingTileDeck] = useState<BoardTileDeckPlacement | null>(null);
  const [replacingBoardTileId, setReplacingBoardTileId] = useState<number | null>(null);
  const [tilePlacementRevision, setTilePlacementRevision] = useState(0);
  const [tokenSupplySetupStep, setTokenSupplySetupStep] = useState<'token' | 'quantity' | null>(null);
  const [tokenPlacementKind, setTokenPlacementKind] = useState<'supply' | 'single'>('supply');
  const [tokenSupplyOptions, setTokenSupplyOptions] = useState<TokenSupplyOption[]>([]);
  const [chosenSupplyToken, setChosenSupplyToken] = useState<TokenSupplyOption | null>(null);
  const [supplyQuantityText, setSupplyQuantityText] = useState('10');
  const [pendingTokenSupply, setPendingTokenSupply] = useState<BoardTokenSupply | null>(null);
  const [pendingBoardToken, setPendingBoardToken] = useState<BoardTileVisual | null>(null);

  // isSymbolPage is a shortcut boolean.
  // It is true whenever the current screen is either the library or editor.
  const isSymbolPage =
    screen === 'symbolLibrary' || screen === 'symbolEditor';

  // activeSymbol looks up the selected symbol object from the symbols array.
  // If no symbol is selected, this value will be undefined.
  const activeSymbol = symbols.find(
    (symbol) => symbol.id === activeSymbolId
  );
  const pendingSymbol = symbols.find(
    (symbol) => symbol.id === pendingSymbolId
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

  // Symbols are stored in a global library, not under a project ID. Load that shared
  // library when the app opens so the same symbols appear in every project.
  const loadSymbols = useCallback(async () => {
    try {
      const rows = await db.getAllAsync<SymbolItem>(
        'SELECT id, name FROM symbols ORDER BY updated_at DESC'
      );
      setSymbols(rows);
    } catch (error) {
      console.error('Could not load symbols:', error);
    }
  }, [db]);

  useEffect(() => {
    void loadSymbols();
  }, [loadSymbols]);

  const deleteSymbol = async (symbol: SymbolItem) => {
    try {
      // Delete strokes explicitly as well as the symbol row so cleanup does not
      // depend on a platform's foreign-key configuration.
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          'DELETE FROM symbol_strokes WHERE symbol_id = ?',
          symbol.id
        );
        await db.runAsync(
          'DELETE FROM symbols WHERE id = ?',
          symbol.id
        );
      });

      setSymbols((current) => current.filter((item) => item.id !== symbol.id));
      setActiveSymbolId((currentId) =>
        currentId === symbol.id ? null : currentId
      );
    } catch (error) {
      console.error('Could not delete symbol:', error);
      Alert.alert('Delete failed', 'The symbol could not be deleted.');
    }
  };

  const saveSymbolName = async () => {
    const newName = renameText.trim();

    if (newName.length === 0 || renameSymbolId === null) {
      return;
    }

    try {
      await db.runAsync(
        'UPDATE symbols SET name = ?, updated_at = ? WHERE id = ?',
        newName,
        Date.now(),
        renameSymbolId
      );

      setSymbols((current) => current.map((symbol) =>
        symbol.id === renameSymbolId
          ? { ...symbol, name: newName }
          : symbol
      ));
      setRenameSymbolId(null);
    } catch (error) {
      console.error('Could not rename symbol:', error);
      Alert.alert('Rename failed', 'The symbol name could not be saved.');
    }
  };

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

  const beginDeckSpotPlacement = () => {
    setPendingTokenSupply(null);
    setPendingBoardTile(null);
    setPendingTileDeck(null);
    setPendingDeckSpot(null);
    setChosenDeckSpotDeckId(null);
    setDeckSpotSetupStep('choice');
  };

  const chooseSavedDeckForSpot = async () => {
    if (!activeProjectId) {
      setDeckSpotDeckOptions([]);
      setDeckSpotSetupStep('deck');
      return;
    }
    try {
      const availableDecks = await db.getAllAsync<DeckSpotDeckOption>(
        `SELECT d.id, d.name, SUM(i.quantity) AS card_count
        FROM card_decks d
        JOIN card_deck_items i ON i.deck_id = d.id AND i.quantity > 0
        WHERE d.project_id = ?
        GROUP BY d.id, d.name
        ORDER BY d.updated_at DESC`,
        activeProjectId
      );
      setDeckSpotDeckOptions(availableDecks);
      setDeckSpotSetupStep('deck');
    } catch (error) {
      console.error('Could not load saved decks for a board spot:', error);
      Alert.alert('Could not load saved decks', 'Please try again.');
    }
  };

  const prepareSavedDeckSpot = (faceUp: boolean) => {
    if (chosenDeckSpotDeckId === null) return;
    setPendingDeckSpot({
      spotType: 'deck',
      deckId: chosenDeckSpotDeckId,
      faceUp,
    });
    setDeckSpotSetupStep(null);
  };

  const prepareEmptyDeckSpot = () => {
    setPendingDeckSpot({
      spotType: 'discard',
      deckId: null,
      faceUp: false,
    });
    setDeckSpotSetupStep(null);
  };

  const beginTilePlacement = async (kind: 'tile' | 'deck') => {
    if (!activeProjectId) {
      Alert.alert('Choose a project first', 'Tiles and tile decks belong to a project.');
      return;
    }
    try {
      if (kind === 'tile') {
        const options = await db.getAllAsync<TileVisualOption>(
          `SELECT id, name, shape, width_inches, height_inches, color, surface_id, back_surface_id
           FROM game_tiles WHERE project_id = ? ORDER BY name`,
          activeProjectId
        );
        setTilePlacementOptions(options);
      } else {
        const options = await db.getAllAsync<TileDeckPlacementOption>(
          `SELECT deck.id, deck.name, COALESCE(SUM(item.quantity), 0) AS tile_count,
            top_tile.id AS top_tile_id, top_tile.name AS top_tile_name,
            top_tile.shape AS top_tile_shape, top_tile.width_inches AS top_tile_width,
            top_tile.height_inches AS top_tile_height, top_tile.color AS top_tile_color,
            top_tile.surface_id AS top_tile_surface_id,
            top_tile.back_surface_id AS top_tile_back_surface_id
          FROM tile_decks AS deck
          LEFT JOIN tile_deck_items AS item ON item.deck_id = deck.id AND item.quantity > 0
          LEFT JOIN game_tiles AS top_tile ON top_tile.id = (
            SELECT contents.tile_id FROM tile_deck_items AS contents
            WHERE contents.deck_id = deck.id AND contents.quantity > 0
            ORDER BY contents.tile_id LIMIT 1
          )
          WHERE deck.project_id = ?
          GROUP BY deck.id, deck.name, top_tile.id
          ORDER BY deck.name`,
          activeProjectId
        );
        setTileDeckPlacementOptions(options);
      }
      setTilePlacementMode(kind);
    } catch (error) {
      console.error(`Could not load ${kind} placement options:`, error);
      Alert.alert('Could not load tiles', 'Please try again.');
    }
  };

  const beginDiePlacement = async () => {
    if (!activeProjectId) {
      Alert.alert('Choose a project first', 'Dice belong to a project.');
      return;
    }
    try {
      const rows = await db.getAllAsync<{
        id: number; name: string; side_count: number; width_inches: number;
        height_inches: number; color: string;
      }>(
        'SELECT id, name, side_count, width_inches, height_inches, color FROM game_dice WHERE project_id = ? ORDER BY name',
        activeProjectId
      );
      const faceRows = await db.getAllAsync<{ die_id: number; side_number: number; surface_id: string }>(
        `SELECT face.die_id, face.side_number, face.surface_id
         FROM game_die_faces AS face JOIN game_dice AS die ON die.id = face.die_id
         WHERE die.project_id = ? ORDER BY face.die_id, face.side_number`,
        activeProjectId
      );
      const options: BoardDieVisual[] = rows.map((die) => ({
        id: die.id,
        name: die.name,
        sideCount: die.side_count,
        widthInches: die.width_inches,
        heightInches: die.height_inches,
        color: die.color,
        faces: faceRows.filter((face) => face.die_id === die.id).map((face) => ({
          sideNumber: face.side_number,
          surfaceId: face.surface_id,
        })),
      }));
      if (options.length === 0) {
        Alert.alert('No dice yet', 'Create a die in Dice Editor before placing one.');
        return;
      }
      setDiePlacementOptions(options);
      setDiePlacementPickerOpen(true);
    } catch (error) {
      console.error('Could not load dice for placement:', error);
      Alert.alert('Could not load dice', 'Please try again.');
    }
  };

  const beginTokenSupplyPlacement = async (kind: 'supply' | 'single' = 'supply') => {
    if (!activeProjectId) {
      Alert.alert('Choose a project first', 'Token libraries belong to a project.');
      return;
    }
    try {
      const options = await db.getAllAsync<TokenSupplyOption>(
        `SELECT id, name, shape, width_inches, height_inches, color, surface_id, back_surface_id
         FROM game_tokens WHERE project_id = ? ORDER BY name`,
        activeProjectId
      );
      if (options.length === 0) {
        Alert.alert('No tokens yet', 'Create a token in Token Editor before placing a supply.');
        return;
      }
      setTokenSupplyOptions(options);
      setChosenSupplyToken(null);
      setTokenPlacementKind(kind);
      setTokenSupplySetupStep('token');
    } catch (error) {
      console.error('Could not load tokens for map placement:', error);
      Alert.alert('Could not load tokens', 'Please try again.');
    }
  };

  const prepareTokenSupply = (quantity: number | null) => {
    if (!chosenSupplyToken) return;
    setPendingTokenSupply({
      token: {
        id: chosenSupplyToken.id,
        name: chosenSupplyToken.name,
        shape: chosenSupplyToken.shape,
        widthInches: chosenSupplyToken.width_inches,
        heightInches: chosenSupplyToken.height_inches,
        color: chosenSupplyToken.color,
        frontSurfaceId: chosenSupplyToken.surface_id,
        backSurfaceId: chosenSupplyToken.back_surface_id,
      },
      quantity,
    });
    setPendingBoardToken(null);
    setTokenSupplySetupStep(null);
    setIsPlacingTileSnapPoint(false);
    setIsPlacingSymbol(false);
    setIsEditingSymbols(false);
    setPendingSymbolId(null);
    setPendingDeckSpot(null);
    setPendingBoardTile(null);
    setPendingTileDeck(null);
    setReplacingBoardTileId(null);
  };

  const prepareSingleToken = (token: TokenSupplyOption) => {
    setPendingBoardToken({
      id: token.id,
      name: token.name,
      shape: token.shape,
      widthInches: token.width_inches,
      heightInches: token.height_inches,
      color: token.color,
      frontSurfaceId: token.surface_id,
      backSurfaceId: token.back_surface_id,
    });
    setPendingTokenSupply(null);
    setTokenSupplySetupStep(null);
    setIsPlacingTileSnapPoint(false);
    setIsPlacingSymbol(false);
    setIsEditingSymbols(false);
    setPendingSymbolId(null);
    setPendingDeckSpot(null);
    setPendingBoardTile(null);
    setPendingTileDeck(null);
    setReplacingBoardTileId(null);
  };

  const prepareFiniteTokenSupply = () => {
    const quantity = Number(supplyQuantityText);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      Alert.alert('Enter a valid amount', 'The supply count must be a positive whole number.');
      return;
    }
    prepareTokenSupply(quantity);
  };

  const startPlacingTile = async (tile: TileVisualOption) => {
    if (replacingBoardTileId !== null) {
      try {
        await db.runAsync(
          'UPDATE tile_board_placements SET tile_id = ?, deck_id = NULL, face_up = 1 WHERE id = ?',
          tile.id, replacingBoardTileId
        );
        setReplacingBoardTileId(null);
        setTilePlacementMode(null);
        setTilePlacementRevision((revision) => revision + 1);
      } catch (error) {
        console.error('Could not change the placed tile type:', error);
        Alert.alert('Could not change tile', 'Please try again.');
      }
      return;
    }
    setPendingBoardTile({
      id: tile.id,
      name: tile.name,
      shape: tile.shape,
      widthInches: tile.width_inches,
      heightInches: tile.height_inches,
      color: tile.color,
      frontSurfaceId: tile.surface_id,
      backSurfaceId: tile.back_surface_id,
    });
    setPendingTileDeck(null);
    setPendingTokenSupply(null);
    setTilePlacementMode(null);
    setIsPlacingTileSnapPoint(false);
    setIsPlacingSymbol(false);
    setIsEditingSymbols(false);
    setPendingSymbolId(null);
    setPendingDeckSpot(null);
  };

  const startPlacingTileDeck = (deck: TileDeckPlacementOption) => {
    const topTile = deck.top_tile_id === null || !deck.top_tile_name || !deck.top_tile_shape ||
      !deck.top_tile_width || !deck.top_tile_height || !deck.top_tile_surface_id
      ? null
      : {
          id: deck.top_tile_id,
          name: deck.top_tile_name,
          shape: deck.top_tile_shape,
          widthInches: deck.top_tile_width,
          heightInches: deck.top_tile_height,
          color: deck.top_tile_color ?? '#E9C46A',
          frontSurfaceId: deck.top_tile_surface_id,
          backSurfaceId: deck.top_tile_back_surface_id,
        };
    setPendingTileDeck({ id: deck.id, name: deck.name, tileCount: deck.tile_count, topTile });
    setPendingBoardTile(null);
    setPendingTokenSupply(null);
    setReplacingBoardTileId(null);
    setTilePlacementMode(null);
    setIsPlacingTileSnapPoint(false);
    setIsPlacingSymbol(false);
    setIsEditingSymbols(false);
    setPendingSymbolId(null);
    setPendingDeckSpot(null);
  };

  const requestTileTypeChange = (placementId: number) => {
    setReplacingBoardTileId(placementId);
    void beginTilePlacement('tile');
  };

  if (screen === 'projectPicker') {
    return (
      <View style={styles.projectPickerScreen}>
        <Text style={styles.createTitle}>{projectPickerMode === 'play' ? 'Choose a Game to Play' : 'My Projects'}</Text>
        {projectPickerMode === 'play' && <Text style={{ color: '#4B5563', marginBottom: 12 }}>Load a saved project to begin gameplay.</Text>}

        <ScrollView
          style={styles.projectScroll}
          contentContainerStyle={styles.projectGrid}
        >
          {projects.length === 0 ? (
            <Text>{projectPickerMode === 'play' ? 'No saved games yet. Create a game first.' : 'No projects yet. Create one to get started.'}</Text>
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
                    if (projectPickerMode === 'play') {
                      setCreateMenuOpen(false);
                      setIsEditingSymbols(false);
                      // Placement pickers and hints belong to the editor. Do
                      // not carry an unfinished placement popup into play.
                      setIsPlacingSymbol(false);
                      setPendingSymbolId(null);
                      setPendingDeckSpot(null);
                      setDeckSpotSetupStep(null);
                      setIsPlacingTileSnapPoint(false);
                      setTilePlacementMode(null);
                      setPendingBoardTile(null);
                      setPendingTileDeck(null);
                      setReplacingBoardTileId(null);
                      setDiePlacementPickerOpen(false);
                      setPendingBoardDie(null);
                      setTokenSupplySetupStep(null);
                      setPendingTokenSupply(null);
                      setPendingBoardToken(null);
                      setIsPlaying(true);
                    } else {
                      setIsPlaying(false);
                    }
                    setScreen('createGame');
                  }}
                >
                  <Text style={styles.projectTileText}>{projectPickerMode === 'play' ? `Play ${project.name}` : project.name}</Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${project.name}`}
                  style={[styles.projectDeleteButton, projectPickerMode === 'play' && { display: 'none' }]}
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
                  style={[styles.projectRenameButton, projectPickerMode === 'play' && { display: 'none' }]}
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

          {projectPickerMode === 'create' && <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.projectActionButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={createProject}
          >
            <Text style={styles.buttonText}>New Project</Text>
          </Pressable>}
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
  if (screen === 'createGame' || isSymbolPage || screen === 'cardEditor' || screen === 'tileEditor' || screen === 'tokenEditor' || screen === 'diceEditor') {
    return (
      <View style={styles.gameCanvas}>
        <Modal
          visible={!isPlaying && deckSpotSetupStep !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setDeckSpotSetupStep(null)}
        >
          <View style={styles.renameBackdrop}>
            <View style={styles.renameDialog}>
              <Text style={styles.menuTitle}>
                {deckSpotSetupStep === 'choice'
                  ? 'Add a Deck Spot'
                  : deckSpotSetupStep === 'deck'
                    ? 'Choose a Saved Deck'
                    : 'Show the Top Card'}
              </Text>
              {deckSpotSetupStep === 'choice' && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.menuOption}
                    onPress={() => void chooseSavedDeckForSpot()}
                  >
                    <Text>Use a Saved Deck</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.menuOption}
                    onPress={prepareEmptyDeckSpot}
                  >
                    <Text>Empty Deck / Discard Pile</Text>
                  </Pressable>
                </>
              )}
              {deckSpotSetupStep === 'deck' && (
                deckSpotDeckOptions.length === 0 ? (
                  <Text style={styles.spotSetupHelperText}>
                    There are no saved decks with cards in this project yet.
                  </Text>
                ) : (
                  <ScrollView style={{ maxHeight: 280 }} keyboardShouldPersistTaps="handled">
                    {deckSpotDeckOptions.map((deck) => (
                      <Pressable
                        key={deck.id}
                        accessibilityRole="button"
                        style={styles.menuOption}
                        onPress={() => {
                          setChosenDeckSpotDeckId(deck.id);
                          setDeckSpotSetupStep('face');
                        }}
                      >
                        <Text>{deck.name} · {deck.card_count} cards</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                )
              )}
              {deckSpotSetupStep === 'face' && (
                <>
                  <Text style={styles.spotSetupHelperText}>
                    Choose which side of the top card to show on the map marker.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.menuOption}
                    onPress={() => prepareSavedDeckSpot(true)}
                  >
                    <Text>Face Up · Show the card front</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.menuOption}
                    onPress={() => prepareSavedDeckSpot(false)}
                  >
                    <Text>Face Down · Show the card back</Text>
                  </Pressable>
                </>
              )}
              <View style={styles.renameActions}>
                {deckSpotSetupStep !== 'choice' && (
                  <Pressable
                    style={styles.renameActionButton}
                    onPress={() => setDeckSpotSetupStep(
                      deckSpotSetupStep === 'face' ? 'deck' : 'choice'
                    )}
                  >
                    <Text>Back</Text>
                  </Pressable>
                )}
                <Pressable
                  style={styles.renameActionButton}
                  onPress={() => setDeckSpotSetupStep(null)}
                >
                  <Text>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
        <Modal
          visible={!isPlaying && tilePlacementMode !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setTilePlacementMode(null)}
        >
          <View style={styles.renameBackdrop}>
            <View style={styles.renameDialog}>
              <Text style={styles.menuTitle}>{tilePlacementMode === 'tile' ? 'Choose a Tile' : 'Choose a Tile Deck'}</Text>
              {tilePlacementMode === 'tile' && (tilePlacementOptions.length === 0 ? (
                <Text style={styles.spotSetupHelperText}>Create tile types in Tile Editor before placing them.</Text>
              ) : <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {tilePlacementOptions.map((tile) => (
                  <Pressable key={tile.id} style={styles.menuOption} onPress={() => void startPlacingTile(tile)}>
                    <Text>{tile.name} · {tile.shape} · {tile.width_inches} × {tile.height_inches} in</Text>
                  </Pressable>
                ))}
              </ScrollView>)}
              {tilePlacementMode === 'deck' && (tileDeckPlacementOptions.length === 0 ? (
                <Text style={styles.spotSetupHelperText}>Create tile decks in Tile Editor before placing them.</Text>
              ) : <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {tileDeckPlacementOptions.map((deck) => (
                  <Pressable key={deck.id} style={styles.menuOption} onPress={() => startPlacingTileDeck(deck)}>
                    <Text>{deck.name} · {deck.tile_count} tiles</Text>
                  </Pressable>
                ))}
              </ScrollView>)}
              <View style={styles.renameActions}>
                <Pressable style={styles.renameActionButton} onPress={() => { setTilePlacementMode(null); setReplacingBoardTileId(null); }}><Text>Cancel</Text></Pressable>
              </View>
            </View>
          </View>
        </Modal>
        <Modal
          visible={!isPlaying && tokenSupplySetupStep !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setTokenSupplySetupStep(null)}
        >
          <View style={styles.renameBackdrop}>
            <View style={styles.renameDialog}>
              <Text style={styles.menuTitle}>{tokenSupplySetupStep === 'token'
                ? tokenPlacementKind === 'single' ? 'Choose a Token to Place' : 'Choose a Token for Supply'
                : 'Set Supply Amount'}</Text>
              {tokenSupplySetupStep === 'token' ? (
                <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                  {tokenSupplyOptions.length === 0 && (
                    <Text style={styles.spotSetupHelperText}>No tokens are available in this project yet.</Text>
                  )}
                  {tokenSupplyOptions.map((token) => (
                    <Pressable key={token.id} style={styles.tokenSupplyChoice} onPress={() => {
                      if (tokenPlacementKind === 'single') {
                        prepareSingleToken(token);
                        return;
                      }
                      setChosenSupplyToken(token);
                      setSupplyQuantityText('10');
                      setTokenSupplySetupStep('quantity');
                    }}>
                      <Text numberOfLines={1} style={styles.tokenSupplyChoiceName}>{token.name}</Text>
                      <Text numberOfLines={1} style={styles.tokenSupplyChoiceDetails}>
                        {token.shape} · {token.width_inches} × {token.height_inches} in
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <>
                  <Text style={styles.spotSetupHelperText}>
                    {chosenSupplyToken?.name} can have unlimited stock or a fixed number of tokens.
                  </Text>
                  <Pressable style={styles.menuOption} onPress={() => prepareTokenSupply(null)}>
                    <Text>Unlimited Supply</Text>
                  </Pressable>
                  <TextInput
                    style={styles.renameInput}
                    value={supplyQuantityText}
                    onChangeText={setSupplyQuantityText}
                    keyboardType="number-pad"
                    placeholder="Number of tokens"
                  />
                  <Pressable style={styles.menuOption} onPress={prepareFiniteTokenSupply}>
                    <Text>Place Set Number</Text>
                  </Pressable>
                </>
              )}
              <View style={styles.renameActions}>
                {tokenSupplySetupStep === 'quantity' && (
                  <Pressable style={styles.renameActionButton} onPress={() => setTokenSupplySetupStep('token')}>
                    <Text>Back</Text>
                  </Pressable>
                )}
                <Pressable style={styles.renameActionButton} onPress={() => setTokenSupplySetupStep(null)}>
                  <Text>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
        <Modal
          visible={!isPlaying && diePlacementPickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setDiePlacementPickerOpen(false)}
        >
          <View style={styles.renameBackdrop}>
            <View style={styles.renameDialog}>
              <Text style={styles.menuTitle}>Choose a Die to Place</Text>
              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {diePlacementOptions.map((die) => (
                  <Pressable key={die.id} style={styles.tokenSupplyChoice} onPress={() => {
                    setPendingBoardDie(die);
                    setPendingBoardTile(null);
                    setPendingTileDeck(null);
                    setPendingTokenSupply(null);
                    setPendingBoardToken(null);
                    setPendingDeckSpot(null);
                    setPendingSymbolId(null);
                    setIsPlacingTileSnapPoint(false);
                    setIsPlacingSymbol(false);
                    setIsEditingSymbols(false);
                    setDiePlacementPickerOpen(false);
                  }}>
                    <Text numberOfLines={1} style={styles.tokenSupplyChoiceName}>{die.name}</Text>
                    <Text numberOfLines={1} style={styles.tokenSupplyChoiceDetails}>
                      d{die.sideCount} · {die.widthInches} × {die.heightInches} in per face
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={styles.renameActions}>
                <Pressable style={styles.renameActionButton} onPress={() => setDiePlacementPickerOpen(false)}><Text>Cancel</Text></Pressable>
              </View>
            </View>
          </View>
        </Modal>
        {/* This is the big background area behind the menu and symbol panels.
            Think of it like the tabletop or game mat. Right now it's just a placeholder.
            The rest of the UI sits on top of it. */}
        <DrawingCanvas
          ref={boardCanvasRef}
          key={activeProjectId ?? 'no-project'}
          bottomInset={0}
          topInset={insets.top + 5}
          surfaceId={activeProjectId ? `${activeProjectId}-board` : undefined}
          placementSymbolId={pendingSymbolId ?? undefined}
          placementSymbolName={pendingSymbol?.name}
          repeatSymbolPlacement
          placementDeckSpot={pendingDeckSpot ?? undefined}
          placementTileSnapPoint={isPlacingTileSnapPoint}
          placementTile={pendingBoardTile ?? undefined}
          placementTileDeck={pendingTileDeck ?? undefined}
          placementTokenSupply={pendingTokenSupply ?? undefined}
          placementToken={pendingBoardToken ?? undefined}
          placementDie={pendingBoardDie ?? undefined}
          tilePlacementRevision={tilePlacementRevision}
          onSymbolPlaced={() => setPendingSymbolId(null)}
          onCancelDeckSpotPlacement={() => setPendingDeckSpot(null)}
          onCancelTileSnapPointPlacement={() => setIsPlacingTileSnapPoint(false)}
          onCancelTilePlacement={() => { setPendingBoardTile(null); setPendingTileDeck(null); setReplacingBoardTileId(null); }}
          onCancelTokenSupplyPlacement={() => setPendingTokenSupply(null)}
          onCancelTokenPlacement={() => setPendingBoardToken(null)}
          onCancelDiePlacement={() => setPendingBoardDie(null)}
          onBoardTileTypeChangeRequested={requestTileTypeChange}
          isEditingSymbols={isEditingSymbols}
          onStopEditingSymbols={() => setIsEditingSymbols(false)}
            gameplayMode={isPlaying}
            gameplayDrawFaceUp={gameplayDrawFaceUp}
            onDeckCardDragRequest={(sourceSpotId, targetSpotId, absoluteY) => {
              gameplayRef.current?.resolveDeckCardDrop(sourceSpotId, targetSpotId, absoluteY);
            }}
            handCardDropRequest={handCardDropRequest ?? undefined}
            onHandCardDropResolved={(request, deckSpotId) => {
              setHandCardDropRequest((current) => current?.requestId === request.requestId ? null : current);
              gameplayRef.current?.resolveHandCardDrop(request.cardInstanceId, deckSpotId);
            }}
        />

        {isPlaying && activeProjectId && (
          <GameplayPanel
            ref={gameplayRef}
            projectId={activeProjectId}
            topInset={insets.top}
            bottomInset={insets.bottom}
            drawFaceUp={gameplayDrawFaceUp}
            onDrawFaceUpChange={setGameplayDrawFaceUp}
            onClose={() => {
              setIsPlaying(false);
              setHandCardDropRequest(null);
              setCreateMenuOpen(false);
              setIsEditingSymbols(false);
              setScreen('home');
            }}
            onBoardPilesChanged={notifyGameplayPilesChanged}
            onGameplayStateChanged={notifyGameplayStateChanged}
            onHandCardDropRequest={(cardInstanceId, absoluteX, absoluteY) => {
              handDropRequestCounterRef.current += 1;
              setHandCardDropRequest({
                requestId: handDropRequestCounterRef.current,
                cardInstanceId,
                absoluteX,
                absoluteY,
              });
            }}
          />
        )}

        {/* A colored status bar at the top of the screen to avoid the content feeling
            cut off behind the device notch or notch-safe area. */}
        <View pointerEvents="none" style={[styles.topLine, { height: insets.top }]} />

        {screen === 'cardEditor' && (
          <CardEditor
            topInset={insets.top}
            bottomInset={insets.bottom}
            projectId={activeProjectId ?? undefined}
            symbols={symbols}
            onClose={() => setScreen('createGame')}
          />
        )}

        {screen === 'tileEditor' && (
          <TileEditor
            projectId={activeProjectId ?? undefined}
            symbols={symbols}
            topInset={insets.top}
            bottomInset={insets.bottom}
            onClose={() => setScreen('createGame')}
          />
        )}

        {screen === 'tokenEditor' && (
          <TokenEditor
            projectId={activeProjectId ?? undefined}
            symbols={symbols}
            topInset={insets.top}
            bottomInset={insets.bottom}
            onClose={() => setScreen('createGame')}
          />
        )}

        {screen === 'diceEditor' && (
          <DiceEditor
            projectId={activeProjectId ?? undefined}
            symbols={symbols}
            topInset={insets.top}
            bottomInset={insets.bottom}
            onClose={() => setScreen('createGame')}
          />
        )}

        {/* The game menu appears only while the user is on the create-game screen.
            It is either an open dropdown or a small hamburger button depending on
            whether createMenuOpen is true or false. */}
        {screen === 'createGame' && !isEditingSymbols && !isPlaying && (
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

              <ScrollView
                style={styles.menuOptionsScroll}
                contentContainerStyle={styles.menuOptionsContent}
                showsVerticalScrollIndicator
              >
              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  boardCanvasRef.current?.importImage();
                }}
              >
                <Text>Add Image</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(false);
                  setPendingTokenSupply(null);
                  setScreen('tileEditor');
                }}
              >
                <Text>Tile Editor</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(false);
                  setIsPlacingSymbol(false);
                  setIsEditingSymbols(false);
                  setPendingSymbolId(null);
                  setPendingDeckSpot(null);
                  setPendingBoardTile(null);
                  setPendingTileDeck(null);
                  setPendingTokenSupply(null);
                  setScreen('tokenEditor');
                }}
              >
                <Text>Token Editor</Text>
              </Pressable>

              <Pressable style={styles.menuOption} onPress={() => {
                setCreateMenuOpen(false);
                setPendingBoardDie(null);
                setPendingBoardTile(null);
                setPendingTileDeck(null);
                setPendingTokenSupply(null);
                setPendingBoardToken(null);
                setIsPlacingTileSnapPoint(false);
                setIsPlacingSymbol(false);
                setIsEditingSymbols(false);
                setScreen('diceEditor');
              }}>
                <Text>Dice Editor</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(true);
                  setPendingTokenSupply(null);
                  setIsPlacingSymbol(false);
                  setIsEditingSymbols(false);
                  setPendingBoardTile(null);
                  setPendingTileDeck(null);
                  setPendingSymbolId(null);
                  setPendingDeckSpot(null);
                }}
              >
                <Text>Place Tile Snap Point</Text>
              </Pressable>

              <Pressable style={styles.menuOption} onPress={() => {
                setCreateMenuOpen(false);
                setIsPlacingTileSnapPoint(false);
                setIsPlacingSymbol(false);
                setIsEditingSymbols(false);
                setReplacingBoardTileId(null);
                setPendingTileDeck(null);
                setPendingTokenSupply(null);
                setPendingSymbolId(null);
                setPendingDeckSpot(null);
                void beginTilePlacement('tile');
              }}>
                <Text>Place Tile</Text>
              </Pressable>

              <Pressable style={styles.menuOption} onPress={() => {
                setCreateMenuOpen(false);
                setIsPlacingTileSnapPoint(false);
                setIsPlacingSymbol(false);
                setIsEditingSymbols(false);
                setPendingBoardTile(null);
                setReplacingBoardTileId(null);
                setPendingTokenSupply(null);
                setPendingSymbolId(null);
                setPendingDeckSpot(null);
                void beginTilePlacement('deck');
              }}>
                <Text>Place Tile Deck</Text>
              </Pressable>

              <Pressable style={styles.menuOption} onPress={() => {
                setCreateMenuOpen(false);
                setIsPlacingTileSnapPoint(false);
                setIsPlacingSymbol(false);
                setIsEditingSymbols(false);
                setPendingBoardTile(null);
                setPendingTileDeck(null);
                setPendingSymbolId(null);
                setPendingDeckSpot(null);
                setPendingTokenSupply(null);
                void beginTokenSupplyPlacement();
              }}>
                <Text>Place Token Supply</Text>
              </Pressable>

              <Pressable style={styles.menuOption} onPress={() => {
                setCreateMenuOpen(false);
                setIsPlacingTileSnapPoint(false);
                setIsPlacingSymbol(false);
                setIsEditingSymbols(false);
                setPendingBoardTile(null);
                setPendingTileDeck(null);
                setPendingTokenSupply(null);
                setPendingSymbolId(null);
                setPendingDeckSpot(null);
                void beginTokenSupplyPlacement('single');
              }}>
                <Text>Place Token</Text>
              </Pressable>

              <Pressable style={styles.menuOption} onPress={() => {
                setCreateMenuOpen(false);
                setPendingBoardDie(null);
                setPendingBoardTile(null);
                setPendingTileDeck(null);
                setPendingTokenSupply(null);
                setPendingBoardToken(null);
                void beginDiePlacement();
              }}>
                <Text>Place Die</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(false);
                  setIsPlacingSymbol(false);
                  setPendingSymbolId(null);
                  setPendingDeckSpot(null);
                  setPendingBoardTile(null);
                  setPendingTileDeck(null);
                  setPendingTokenSupply(null);
                  setScreen('home');
                }}
              >
                <Text>Return to Menu</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(false);
                  setIsPlacingSymbol(false);
                  setIsEditingSymbols(false);
                  setPendingSymbolId(null);
                  setPendingBoardTile(null);
                  setPendingTileDeck(null);
                  setPendingTokenSupply(null);
                  beginDeckSpotPlacement();
                }}
              >
                <Text>Place Deck / Discard Spot</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(false);
                  setIsPlacingSymbol(false);
                  setIsEditingSymbols(false);
                  setPendingSymbolId(null);
                  setPendingDeckSpot(null);
                  setPendingBoardTile(null);
                  setPendingTileDeck(null);
                  setPendingTokenSupply(null);
                  setScreen('symbolLibrary');
                }}
              >
                <Text>Open Symbol Editor</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(false);
                  setIsPlacingSymbol(true);
                  setIsEditingSymbols(false);
                  setPendingSymbolId(null);
                  setPendingDeckSpot(null);
                  setPendingBoardTile(null);
                  setPendingTileDeck(null);
                  setPendingTokenSupply(null);
                  setScreen('symbolLibrary');
                }}
              >
                <Text>Place Symbol</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(false);
                  setIsPlacingSymbol(false);
                  setPendingSymbolId(null);
                  setPendingDeckSpot(null);
                  setPendingBoardTile(null);
                  setPendingTileDeck(null);
                  setPendingTokenSupply(null);
                  setIsEditingSymbols((editing) => !editing);
                }}
              >
                <Text>{isEditingSymbols ? 'Done Moving' : 'Move Mode'}</Text>
              </Pressable>

              <Pressable
                style={styles.menuOption}
                onPress={() => {
                  setCreateMenuOpen(false);
                  setIsPlacingTileSnapPoint(false);
                  setIsPlacingSymbol(false);
                  setIsEditingSymbols(false);
                  setPendingSymbolId(null);
                  setPendingDeckSpot(null);
                  setPendingBoardTile(null);
                  setPendingTileDeck(null);
                  setPendingTokenSupply(null);
                  setScreen('cardEditor');
                }}
              >
                <Text>Card Editor</Text>
              </Pressable>
              </ScrollView>
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
                    <Text style={styles.createTitle}>
                      {isPlacingSymbol ? 'Choose a Symbol' : 'Custom Symbols'}
                    </Text>

                    <View style={styles.libraryHeaderActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Create new symbol"
                        style={styles.libraryIconButton}
                        onPress={async () => {
                          const id = Date.now();
                          const now = Date.now();
                          const name = `Symbol ${symbols.length + 1}`;

                          try {
                            // Create the symbol row first so its strokes can reference it.
                            await db.runAsync(
                              `INSERT INTO symbols (id, name, created_at, updated_at)
                              VALUES (?, ?, ?, ?)`,
                              id,
                              name,
                              now,
                              now
                            );

                            setSymbols((current) => [...current, { id, name }]);
                            setActiveSymbolId(id);
                            setScreen('symbolEditor');
                          } catch (error) {
                            console.error('Could not create symbol:', error);
                            Alert.alert('Could not create symbol', 'Please try again.');
                          }
                        }}
                      >
                        <Text style={styles.libraryIconText}>+</Text>
                      </Pressable>

                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Close symbol library"
                        style={styles.libraryIconButton}
                onPress={() => {
                  setIsPlacingSymbol(false);
                  setPendingSymbolId(null);
                  setPendingDeckSpot(null);
                  setScreen('createGame');
                }}
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
                            if (isPlacingSymbol) {
                              // Return to the map with this shared-library symbol armed
                              // for placement at the next map tap.
                              setPendingSymbolId(symbol.id);
                              setIsPlacingSymbol(false);
                              setScreen('createGame');
                            } else {
                              // In the normal library flow, selecting a symbol opens its editor.
                              setActiveSymbolId(symbol.id);
                              setScreen('symbolEditor');
                            }
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
                          onPress: () => void deleteSymbol(symbol),
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
                            onPress={() => void saveSymbolName()}
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
                      {/* The symbol canvas is fixed at 300 points, so use a
                          compact one-row toolbar to keep every button inside it. */}
                      <DrawingCanvas
                        key={activeSymbolId ?? 'no-symbol'}
                        bottomInset={0}
                        transparentBackground
                        compactToolbar
                        symbolId={activeSymbolId ?? undefined}
                      />
                    </View>
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
          onPress={() => { setProjectPickerMode('create'); setScreen('projectPicker'); }}
        >
          <Text style={styles.buttonText}>Create Game</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.button,
            buttonLayout,
            pressed && styles.buttonPressed,
          ]}
          onPress={() => { setProjectPickerMode('play'); setScreen('projectPicker'); }}
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
