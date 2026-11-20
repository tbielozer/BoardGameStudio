import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { useSQLiteContext } from 'expo-sqlite';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { BoardTileArtworkPreview, type BoardTileVisual } from './DrawingCanvas';
import { withSafeWriteTransaction } from './databaseTransactions';
import { gameplayStyles as styles } from './gameplayStyles';

type Player = { id: number; name: string; order_index: number };
type HandCard = {
  id: number;
  card_id: number;
  name: string;
  surface_id: string;
  back_surface_id: string | null;
  width_inches: number;
  height_inches: number;
  face_up: number;
};
type PlayCardSnapshot = {
  id: number;
  project_id: string;
  card_id: number;
  deck_spot_id: number | null;
  player_id: number | null;
  face_up: number;
  hand_order: number;
  pile_order: number;
};
type InitializedSpotSnapshot = { project_id: string; spot_id: number; deck_id: number; initialized_at: number };
type TileReturnSnapshot = { project_id: string; deck_id: number; tile_id: number; quantity: number; updated_at: number };
type TokenReturnSnapshot = { project_id: string; supply_id: number; quantity: number; updated_at: number };
type TileTakeSnapshot = TileReturnSnapshot;
type TokenTakeSnapshot = TokenReturnSnapshot;
type TilePlacementStateSnapshot = {
  project_id: string; placement_id: number; x: number; y: number; orientation: number;
  face_up: number; is_returned: number; is_added: number; returned_deck_id: number | null;
};
type TokenPlacementStateSnapshot = {
  project_id: string; placement_id: number; x: number; y: number; orientation: number;
  face_up: number; is_returned: number; is_added: number; returned_supply_id: number | null;
};
type DiePlacementStateSnapshot = { project_id: string; placement_id: number; face_number: number; updated_at: number };
type AddedTileSnapshot = {
  tile_id: number; x: number; y: number; orientation: number; face_up: number;
  is_returned: number; returned_deck_id: number | null;
};
type AddedTokenSnapshot = {
  token_id: number; x: number; y: number; orientation: number; face_up: number;
  is_returned: number; returned_supply_id: number | null;
};
type GameplaySnapshot = {
  players: Player[];
  cards: PlayCardSnapshot[];
  initializedSpots: InitializedSpotSnapshot[];
  tileReturns?: TileReturnSnapshot[];
  tokenReturns?: TokenReturnSnapshot[];
  tileTakes?: TileTakeSnapshot[];
  tokenTakes?: TokenTakeSnapshot[];
  tilePlacementStates?: TilePlacementStateSnapshot[];
  tokenPlacementStates?: TokenPlacementStateSnapshot[];
  diePlacementStates?: DiePlacementStateSnapshot[];
  addedTiles?: AddedTileSnapshot[];
  addedTokens?: AddedTokenSnapshot[];
  activePlayerId: number | null;
};
type GameplaySave = { id: number; name: string; created_at: number };

type DropRequest = { requestId: number; cardInstanceId: number; absoluteX: number; absoluteY: number };

export type GameplayPanelHandle = {
  /** Finish a dragged card from a deck pile onto the hand area or another pile. */
  resolveDeckCardDrop: (sourceSpotId: number, targetSpotId: number | null, absoluteY: number) => void;
  /** Continue a hand-card drag after the board has identified the target spot. */
  resolveHandCardDrop: (cardInstanceId: number, spotId: number | null) => void;
};

type GameplayPanelProps = {
  projectId: string;
  topInset: number;
  bottomInset: number;
  onClose: () => void;
  onBoardPilesChanged: (spotIds?: number[]) => void;
  onGameplayStateChanged: () => void;
  drawFaceUp: boolean;
  onDrawFaceUpChange: (faceUp: boolean) => void;
  onHandCardDropRequest: (cardInstanceId: number, absoluteX: number, absoluteY: number) => void;
};

/**
 * The hot-seat play layer. The board remains visible underneath while this
 * component manages players, hands, and the movable cards in each deck spot.
 */
export const GameplayPanel = forwardRef<GameplayPanelHandle, GameplayPanelProps>(function GameplayPanel({
  projectId,
  topInset,
  bottomInset,
  onClose,
  onBoardPilesChanged,
  onGameplayStateChanged,
  drawFaceUp,
  onDrawFaceUpChange,
  onHandCardDropRequest,
}, ref) {
  const db = useSQLiteContext();
  const [players, setPlayers] = useState<Player[]>([]);
  const [isPreparingGame, setIsPreparingGame] = useState(true);
  const [activePlayerId, setActivePlayerId] = useState<number | null>(null);
  const [hand, setHand] = useState<HandCard[]>([]);
  const [dropCardId, setDropCardId] = useState<number | null>(null);
  const [playerName, setPlayerName] = useState('');
  const [addPlayerOpen, setAddPlayerOpen] = useState(false);
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [savedGamesOpen, setSavedGamesOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [savedGames, setSavedGames] = useState<GameplaySave[]>([]);
  const [heldCard, setHeldCard] = useState<HandCard | null>(null);
  // Repeated gestures should not start overlapping card-write transactions.
  const cardDrawInFlightRef = useRef(false);
  // Shared values move the held card without re-rendering the board and every
  // card preview for each finger update.
  const heldX = useSharedValue(0);
  const heldY = useSharedValue(0);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const refreshPlayers = useCallback(async () => {
    const rows = await db.getAllAsync<Player>(
      'SELECT id, name, order_index FROM game_players WHERE project_id = ? ORDER BY order_index, id',
      projectId
    );
    setPlayers(rows);
    setActivePlayerId((current) => rows.some((player) => player.id === current) ? current : rows[0]?.id ?? null);
  }, [db, projectId]);

  const refreshHand = useCallback(async (playerId = activePlayerId) => {
    if (playerId === null) { setHand([]); return; }
    const rows = await db.getAllAsync<HandCard>(
      `SELECT instance.id, instance.card_id, instance.face_up,
        card.name, card.surface_id, card.back_surface_id, card.width_inches, card.height_inches
      FROM play_card_instances instance
      JOIN cards card ON card.id = instance.card_id
      WHERE instance.project_id = ? AND instance.player_id = ?
      ORDER BY instance.hand_order, instance.id`,
      projectId,
      playerId
    );
    // Keep unchanged card objects so memoized thumbnails for the rest of the
    // hand do not redraw just because one card was added or removed.
    setHand((current) => {
      const previousById = new Map(current.map((card) => [card.id, card]));
      return rows.map((row) => {
        const previous = previousById.get(row.id);
        return previous && previous.card_id === row.card_id
          && previous.face_up === row.face_up
          && previous.name === row.name
          && previous.surface_id === row.surface_id
          && previous.back_surface_id === row.back_surface_id
          ? previous
          : row;
      });
    });
  }, [activePlayerId, db, projectId]);

  // Each saved deck marker gets its own physical shuffled pile. Seeding happens
  // once per marker; it never changes the reusable card_deck_items recipe.
  const initializeDeckSpots = useCallback(async () => {
    const spots = await db.getAllAsync<{ id: number; deck_id: number; face_up: number }>(
      `SELECT id, deck_id, face_up FROM deck_spots
      WHERE surface_id = ? AND spot_type = 'deck' AND deck_id IS NOT NULL`,
      `${projectId}-board`
    );
    for (const spot of spots) {
      const initialized = await db.getFirstAsync<{ spot_id: number }>(
        'SELECT spot_id FROM play_initialized_spots WHERE project_id = ? AND spot_id = ?',
        projectId,
        spot.id
      );
      if (initialized) continue;

      const recipe = await db.getAllAsync<{ card_id: number; quantity: number }>(
        'SELECT card_id, quantity FROM card_deck_items WHERE deck_id = ?',
        spot.deck_id
      );
      const cards = recipe.flatMap((item) => Array.from({ length: item.quantity }, () => item.card_id));
      // Fisher-Yates shuffle gives each placed deck a fresh, randomized order.
      for (let index = cards.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
      }

      await db.withTransactionAsync(async () => {
        for (let index = 0; index < cards.length; index += 1) {
          await db.runAsync(
            `INSERT INTO play_card_instances
              (project_id, card_id, deck_spot_id, player_id, face_up, pile_order)
            VALUES (?, ?, ?, NULL, ?, ?)`,
            projectId,
            cards[index],
            spot.id,
            spot.face_up,
            index
          );
        }
        await db.runAsync(
          `INSERT OR IGNORE INTO play_initialized_spots (project_id, spot_id, deck_id, initialized_at)
          VALUES (?, ?, ?, ?)`,
          projectId,
          spot.id,
          spot.deck_id,
          Date.now()
        );
      });
    }
  }, [db, projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initializeDeckSpots();
        onBoardPilesChanged();
        const rows = await db.getAllAsync<Player>(
          'SELECT id, name, order_index FROM game_players WHERE project_id = ? ORDER BY order_index, id',
          projectId
        );
        if (!cancelled) {
          setPlayers(rows);
          setActivePlayerId((current) => rows.some((player) => player.id === current) ? current : rows[0]?.id ?? null);
          setIsPreparingGame(false);
        }
      } catch (error) {
        console.error('Could not load gameplay state:', error);
        Alert.alert('Could not start game', 'The saved deck data could not be loaded.');
      }
    })();
    return () => { cancelled = true; };
  }, [db, initializeDeckSpots, onBoardPilesChanged, projectId]);

  useEffect(() => { void refreshHand(); }, [refreshHand]);

  // A deck card is moved by dragging it directly to the hand area or another
  // pile. Only its final destination triggers a database update.
  const drawDraggedCard = useCallback(async (
    sourceSpotId: number,
    targetSpotId: number | null,
    absoluteY: number
  ) => {
    if (isPreparingGame) return;
    if (cardDrawInFlightRef.current) return;
    const droppedOnHand = absoluteY >= windowHeight - 185 - bottomInset;
    if (!droppedOnHand && (targetSpotId === null || targetSpotId === sourceSpotId)) return;
    if (droppedOnHand && activePlayerId === null) {
      Alert.alert('Add a player first', 'Create a player before drawing cards into a hand.');
      return;
    }

    cardDrawInFlightRef.current = true;
    try {
      await withSafeWriteTransaction(db, async (txn) => {
        if (droppedOnHand) {
          // Move the current top card and calculate its hand position in one
          // statement. This avoids a read round trip and keeps order correct if
          // two gameplay surfaces ever issue writes at the same time.
          const movedCard = await txn.getFirstAsync<{ id: number }>(
            `UPDATE play_card_instances
             SET deck_spot_id = NULL,
               player_id = ?,
               face_up = ?,
               hand_order = COALESCE((
                 SELECT MAX(hand_order) + 1 FROM play_card_instances
                 WHERE project_id = ? AND player_id = ?
               ), 0)
             WHERE id = (
               SELECT id FROM play_card_instances
               WHERE project_id = ? AND deck_spot_id = ? AND player_id IS NULL
               ORDER BY pile_order, id LIMIT 1
             ) AND project_id = ?
             RETURNING id`,
            activePlayerId,
            drawFaceUp ? 1 : 0,
            projectId,
            activePlayerId,
            projectId,
            sourceSpotId,
            projectId
          );
          if (!movedCard) return;
        } else {
          // Pile order is only used for sorting, so gaps are safe. Put the
          // moved card just ahead of the destination's current top instead of
          // shifting every card in both piles on each draw.
          const movedCard = await txn.getFirstAsync<{ id: number }>(
            `UPDATE play_card_instances
             SET deck_spot_id = ?,
               player_id = NULL,
               face_up = ?,
               pile_order = COALESCE((
                 SELECT MIN(pile_order) FROM play_card_instances
                 WHERE project_id = ? AND deck_spot_id = ? AND player_id IS NULL
               ), 0) - 1
             WHERE id = (
               SELECT id FROM play_card_instances
               WHERE project_id = ? AND deck_spot_id = ? AND player_id IS NULL
               ORDER BY pile_order, id LIMIT 1
             ) AND project_id = ?
             RETURNING id`,
            targetSpotId,
            drawFaceUp ? 1 : 0,
            projectId,
            targetSpotId,
            projectId,
            sourceSpotId,
            projectId
          );
          if (!movedCard) return;
        }
      });
      if (droppedOnHand && activePlayerId !== null) await refreshHand(activePlayerId);
      onBoardPilesChanged(droppedOnHand ? [sourceSpotId] : [sourceSpotId, targetSpotId!]);
    } catch (error) {
      console.error('Could not move card from deck:', error);
      Alert.alert('Could not move card', 'Please try again.');
    } finally {
      cardDrawInFlightRef.current = false;
    }
  }, [activePlayerId, bottomInset, db, drawFaceUp, isPreparingGame, onBoardPilesChanged, projectId, refreshHand, windowHeight]);

  const addPlayer = useCallback(async () => {
    const name = playerName.trim() || `Player ${players.length + 1}`;
    try {
      const result = await db.runAsync(
        'INSERT INTO game_players (project_id, name, order_index, created_at) VALUES (?, ?, ?, ?)',
        projectId,
        name,
        players.length,
        Date.now()
      );
      const newPlayerId = result.lastInsertRowId;
      setPlayerName('');
      setAddPlayerOpen(false);
      await refreshPlayers();
      setActivePlayerId(newPlayerId);
      await refreshHand(newPlayerId);
    } catch (error) {
      console.error('Could not add player:', error);
      Alert.alert('Could not add player', 'Please try again.');
    }
  }, [db, playerName, players.length, projectId, refreshHand, refreshPlayers]);

  // Face-up state belongs to each physical card copy, so flipping one hand
  // card does not change other copies or the saved card definition.
  const flipHandCard = useCallback(async (card: HandCard) => {
    if (activePlayerId === null) return;
    const nextFaceUp = card.face_up === 1 ? 0 : 1;
    try {
      await db.runAsync(
        'UPDATE play_card_instances SET face_up = ? WHERE id = ? AND project_id = ? AND player_id = ?',
        nextFaceUp,
        card.id,
        projectId,
        activePlayerId
      );
      await refreshHand(activePlayerId);
    } catch (error) {
      console.error('Could not flip hand card:', error);
      Alert.alert('Could not flip card', 'Please try again.');
    }
  }, [activePlayerId, db, projectId, refreshHand]);

  const releaseHandCard = useCallback((cardId: number, absoluteX: number, absoluteY: number) => {
    setHeldCard(null);
    onHandCardDropRequest(cardId, absoluteX, absoluteY);
  }, [onHandCardDropRequest]);
  const cancelHeldCard = useCallback(() => setHeldCard(null), []);

  const saveCurrentGameplay = useCallback(async () => {
    const name = saveName.trim() || `Save ${new Date().toLocaleString()}`;
    try {
      const [savedPlayers, cards, initializedSpots, tileReturns, tokenReturns, tileTakes, tokenTakes,
        tilePlacementStates, tokenPlacementStates, diePlacementStates, addedTiles, addedTokens] = await Promise.all([
        db.getAllAsync<Player>(
          'SELECT id, name, order_index FROM game_players WHERE project_id = ? ORDER BY order_index, id',
          projectId
        ),
        db.getAllAsync<PlayCardSnapshot>(
          `SELECT id, project_id, card_id, deck_spot_id, player_id, face_up, hand_order, pile_order
          FROM play_card_instances WHERE project_id = ? ORDER BY id`,
          projectId
        ),
        db.getAllAsync<InitializedSpotSnapshot>(
          'SELECT project_id, spot_id, deck_id, initialized_at FROM play_initialized_spots WHERE project_id = ?',
          projectId
        ),
        db.getAllAsync<TileReturnSnapshot>(
          'SELECT project_id, deck_id, tile_id, quantity, updated_at FROM gameplay_tile_deck_returns WHERE project_id = ?',
          projectId
        ),
        db.getAllAsync<TokenReturnSnapshot>(
          'SELECT project_id, supply_id, quantity, updated_at FROM gameplay_token_supply_returns WHERE project_id = ?',
          projectId
        ),
        db.getAllAsync<TileTakeSnapshot>(
          'SELECT project_id, deck_id, tile_id, quantity, updated_at FROM gameplay_tile_deck_takes WHERE project_id = ?',
          projectId
        ),
        db.getAllAsync<TokenTakeSnapshot>(
          'SELECT project_id, supply_id, quantity, updated_at FROM gameplay_token_supply_takes WHERE project_id = ?',
          projectId
        ),
        db.getAllAsync<TilePlacementStateSnapshot>(
          `SELECT project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_deck_id
           FROM gameplay_tile_placement_states WHERE project_id = ?`, projectId
        ),
        db.getAllAsync<TokenPlacementStateSnapshot>(
          `SELECT project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_supply_id
           FROM gameplay_token_placement_states WHERE project_id = ?`, projectId
        ),
        db.getAllAsync<DiePlacementStateSnapshot>(
          `SELECT project_id, placement_id, face_number, updated_at
           FROM gameplay_die_placement_states WHERE project_id = ?`, projectId
        ),
        db.getAllAsync<AddedTileSnapshot>(
          `SELECT placement.tile_id, COALESCE(state.x, placement.x) AS x,
              COALESCE(state.y, placement.y) AS y,
              COALESCE(state.orientation, placement.orientation) AS orientation,
              COALESCE(state.face_up, placement.face_up) AS face_up,
              state.is_returned, state.returned_deck_id
           FROM tile_board_placements AS placement
           JOIN gameplay_tile_placement_states AS state ON state.placement_id = placement.id
           WHERE state.project_id = ? AND state.is_added = 1`, projectId
        ),
        db.getAllAsync<AddedTokenSnapshot>(
          `SELECT placement.token_id, COALESCE(state.x, placement.x) AS x,
              COALESCE(state.y, placement.y) AS y,
              COALESCE(state.orientation, placement.orientation) AS orientation,
              COALESCE(state.face_up, placement.face_up) AS face_up,
              state.is_returned, state.returned_supply_id
           FROM token_board_placements AS placement
           JOIN gameplay_token_placement_states AS state ON state.placement_id = placement.id
           WHERE state.project_id = ? AND state.is_added = 1`, projectId
        ),
      ]);
      const snapshot: GameplaySnapshot = {
        players: savedPlayers, cards, initializedSpots, tileReturns, tokenReturns, tileTakes, tokenTakes,
        tilePlacementStates, tokenPlacementStates, diePlacementStates, addedTiles, addedTokens, activePlayerId,
      };
      await db.runAsync(
        `INSERT INTO gameplay_saves (project_id, name, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
        projectId,
        name,
        JSON.stringify(snapshot),
        Date.now(),
        Date.now()
      );
      setSaveDialogOpen(false);
      setSaveName('');
      Alert.alert('Game saved', `“${name}” is available from Load Saved Game.`);
    } catch (error) {
      console.error('Could not save gameplay state:', error);
      Alert.alert('Could not save game', 'Please try again.');
    }
  }, [activePlayerId, db, projectId, saveName]);

  const openSavedGames = useCallback(async () => {
    try {
      const rows = await db.getAllAsync<GameplaySave>(
        'SELECT id, name, created_at FROM gameplay_saves WHERE project_id = ? ORDER BY updated_at DESC, id DESC',
        projectId
      );
      setGameMenuOpen(false);
      if (rows.length === 0) {
        Alert.alert('No saved games', 'Save a gameplay state first.');
        return;
      }
      setSavedGames(rows);
      setSavedGamesOpen(true);
    } catch (error) {
      console.error('Could not load saved games:', error);
      Alert.alert('Could not load saved games', 'Please try again.');
    }
  }, [db, projectId]);

  const loadSavedGameplay = useCallback(async (saveId: number) => {
    try {
      const row = await db.getFirstAsync<{ snapshot_json: string }>(
        'SELECT snapshot_json FROM gameplay_saves WHERE id = ? AND project_id = ?',
        saveId,
        projectId
      );
      if (!row) throw new Error('Saved game was not found.');
      const snapshot = JSON.parse(row.snapshot_json) as GameplaySnapshot;
      if (!Array.isArray(snapshot.players) || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.initializedSpots)) {
        throw new Error('Saved game data is incomplete.');
      }

      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM play_card_instances WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM game_players WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM play_initialized_spots WHERE project_id = ?', projectId);
        await db.runAsync(`DELETE FROM tile_board_placements WHERE id IN (
          SELECT placement_id FROM gameplay_tile_placement_states WHERE project_id = ? AND is_added = 1)`, projectId);
        await db.runAsync(`DELETE FROM token_board_placements WHERE id IN (
          SELECT placement_id FROM gameplay_token_placement_states WHERE project_id = ? AND is_added = 1)`, projectId);
        await db.runAsync('DELETE FROM gameplay_tile_placement_states WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_token_placement_states WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_die_placement_states WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_tile_deck_returns WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_token_supply_returns WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_tile_deck_takes WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_token_supply_takes WHERE project_id = ?', projectId);

        const restoredPlayerIds = new Map<number, number>();
        for (const player of snapshot.players) {
          const result = await db.runAsync(
            `INSERT INTO game_players (project_id, name, order_index, created_at)
            VALUES (?, ?, ?, ?)`,
            projectId,
            player.name,
            player.order_index,
            Date.now()
          );
          restoredPlayerIds.set(player.id, result.lastInsertRowId);
        }
        for (const card of snapshot.cards) {
          await db.runAsync(
            `INSERT INTO play_card_instances
              (project_id, card_id, deck_spot_id, player_id, face_up, hand_order, pile_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            projectId,
            card.card_id,
            card.deck_spot_id,
            card.player_id === null ? null : restoredPlayerIds.get(card.player_id) ?? null,
            card.face_up,
            card.hand_order,
            card.pile_order
          );
        }
        for (const spot of snapshot.initializedSpots) {
          await db.runAsync(
            `INSERT INTO play_initialized_spots (project_id, spot_id, deck_id, initialized_at)
            VALUES (?, ?, ?, ?)`,
            projectId,
            spot.spot_id,
            spot.deck_id,
            spot.initialized_at
          );
        }
        for (const item of snapshot.tileReturns ?? []) {
          await db.runAsync(
            `INSERT INTO gameplay_tile_deck_returns (project_id, deck_id, tile_id, quantity, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            projectId, item.deck_id, item.tile_id, item.quantity, item.updated_at
          );
        }
        for (const item of snapshot.tileTakes ?? []) {
          await db.runAsync(
            `INSERT INTO gameplay_tile_deck_takes (project_id, deck_id, tile_id, quantity, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            projectId, item.deck_id, item.tile_id, item.quantity, item.updated_at
          );
        }
        for (const item of snapshot.tokenReturns ?? []) {
          await db.runAsync(
            `INSERT INTO gameplay_token_supply_returns (project_id, supply_id, quantity, updated_at)
             VALUES (?, ?, ?, ?)`,
            projectId, item.supply_id, item.quantity, item.updated_at
          );
        }
        for (const item of snapshot.tokenTakes ?? []) {
          await db.runAsync(
            `INSERT INTO gameplay_token_supply_takes (project_id, supply_id, quantity, updated_at)
             VALUES (?, ?, ?, ?)`,
            projectId, item.supply_id, item.quantity, item.updated_at
          );
        }
        for (const item of snapshot.tilePlacementStates ?? []) {
          if (item.is_added) continue;
          await db.runAsync(
            `INSERT INTO gameplay_tile_placement_states
              (project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_deck_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            projectId, item.placement_id, item.x, item.y, item.orientation, item.face_up,
            item.is_returned, item.is_added, item.returned_deck_id
          );
        }
        for (const item of snapshot.tokenPlacementStates ?? []) {
          if (item.is_added) continue;
          await db.runAsync(
            `INSERT INTO gameplay_token_placement_states
              (project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_supply_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            projectId, item.placement_id, item.x, item.y, item.orientation, item.face_up,
            item.is_returned, item.is_added, item.returned_supply_id
          );
        }
        for (const item of snapshot.diePlacementStates ?? []) {
          await db.runAsync(
            `INSERT INTO gameplay_die_placement_states (project_id, placement_id, face_number, updated_at)
             VALUES (?, ?, ?, ?)`,
            projectId, item.placement_id, item.face_number, item.updated_at
          );
        }
        for (const tile of snapshot.addedTiles ?? []) {
          const result = await db.runAsync(
            `INSERT INTO tile_board_placements (surface_id, tile_id, deck_id, x, y, orientation, face_up)
             VALUES (?, ?, NULL, ?, ?, ?, ?)`,
            `${projectId}-board`, tile.tile_id, tile.x, tile.y, tile.orientation, tile.face_up
          );
          await db.runAsync(
            `INSERT INTO gameplay_tile_placement_states
              (project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_deck_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            projectId, result.lastInsertRowId, tile.x, tile.y, tile.orientation, tile.face_up,
            tile.is_returned, tile.returned_deck_id
          );
        }
        for (const token of snapshot.addedTokens ?? []) {
          const result = await db.runAsync(
            `INSERT INTO token_board_placements (surface_id, token_id, x, y, orientation, face_up)
             VALUES (?, ?, ?, ?, ?, ?)`,
            `${projectId}-board`, token.token_id, token.x, token.y, token.orientation, token.face_up
          );
          await db.runAsync(
            `INSERT INTO gameplay_token_placement_states
              (project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_supply_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            projectId, result.lastInsertRowId, token.x, token.y, token.orientation, token.face_up,
            token.is_returned, token.returned_supply_id
          );
        }
      });

      setSavedGamesOpen(false);
      await refreshPlayers();
      const restoredActivePlayerId = snapshot.players.some((player) => player.id === snapshot.activePlayerId)
        ? snapshot.activePlayerId
        : snapshot.players[0]?.id ?? null;
      setActivePlayerId(restoredActivePlayerId);
      await refreshHand(restoredActivePlayerId);
      await initializeDeckSpots();
      onGameplayStateChanged();
    } catch (error) {
      console.error('Could not restore gameplay state:', error);
      Alert.alert('Could not load saved game', 'The saved state could not be restored.');
    }
  }, [db, initializeDeckSpots, onGameplayStateChanged, projectId, refreshHand, refreshPlayers]);

  const startFreshGame = useCallback(async () => {
    try {
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM play_card_instances WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM game_players WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM play_initialized_spots WHERE project_id = ?', projectId);
        await db.runAsync(`DELETE FROM tile_board_placements WHERE id IN (
          SELECT placement_id FROM gameplay_tile_placement_states WHERE project_id = ? AND is_added = 1)`, projectId);
        await db.runAsync(`DELETE FROM token_board_placements WHERE id IN (
          SELECT placement_id FROM gameplay_token_placement_states WHERE project_id = ? AND is_added = 1)`, projectId);
        await db.runAsync('DELETE FROM gameplay_tile_placement_states WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_token_placement_states WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_die_placement_states WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_tile_deck_returns WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_token_supply_returns WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_tile_deck_takes WHERE project_id = ?', projectId);
        await db.runAsync('DELETE FROM gameplay_token_supply_takes WHERE project_id = ?', projectId);
      });
      setPlayers([]);
      setActivePlayerId(null);
      setHand([]);
      setGameMenuOpen(false);
      await initializeDeckSpots();
      onGameplayStateChanged();
    } catch (error) {
      console.error('Could not start a fresh game:', error);
      Alert.alert('Could not start fresh game', 'Please try again.');
    }
  }, [db, initializeDeckSpots, onGameplayStateChanged, projectId]);

  const [pendingDropSpotId, setPendingDropSpotId] = useState<number | null>(null);

  const discardCard = useCallback(async (position: 'top' | 'middle' | 'bottom') => {
    if (dropCardId === null) return;
    const target = await db.getFirstAsync<{ id: number; spot_type: string }>(
      'SELECT id, spot_type FROM deck_spots WHERE id = ?',
      // the spot is held separately in component state below
      pendingDropSpotId
    );
    if (!target) return;
    try {
      await withSafeWriteTransaction(db, async (txn) => {
        const pile = await txn.getAllAsync<{ id: number }>(
          `SELECT id FROM play_card_instances WHERE deck_spot_id = ? AND id != ?
          ORDER BY pile_order, id`,
          target.id,
          dropCardId
        );
        const insertAt = position === 'top' ? 0 : position === 'middle' ? Math.floor(pile.length / 2) : pile.length;
        const orderedIds = pile.map((card) => card.id);
        orderedIds.splice(insertAt, 0, dropCardId);
        for (let index = 0; index < orderedIds.length; index += 1) {
          if (orderedIds[index] === dropCardId) {
            await txn.runAsync(
              `UPDATE play_card_instances SET deck_spot_id = ?, player_id = NULL, pile_order = ? WHERE id = ?`,
              target.id,
              index,
              dropCardId
            );
          } else {
            await txn.runAsync('UPDATE play_card_instances SET pile_order = ? WHERE id = ?', index, orderedIds[index]);
          }
        }
      });
      setDropCardId(null);
      setPendingDropSpotId(null);
      await refreshHand();
      onBoardPilesChanged([target.id]);
    } catch (error) {
      console.error('Could not discard card:', error);
      Alert.alert('Could not discard card', 'Please try again.');
    }
  }, [db, dropCardId, onBoardPilesChanged, pendingDropSpotId, refreshHand]);

  // Resolve a card drop onto a board marker, then ask where inside that pile it belongs.
  const confirmDropTarget = useCallback(async (cardInstanceId: number, spotId: number | null) => {
    if (spotId === null) return;
    const spot = await db.getFirstAsync<{ spot_type: string }>('SELECT spot_type FROM deck_spots WHERE id = ?', spotId);
    if (!spot) return;
    setPendingDropSpotId(spotId);
    setDropCardId(cardInstanceId);
  }, [db]);

  useImperativeHandle(ref, () => ({
    resolveDeckCardDrop: (sourceSpotId, targetSpotId, absoluteY) => {
      void drawDraggedCard(sourceSpotId, targetSpotId, absoluteY);
    },
    resolveHandCardDrop: confirmDropTarget,
  }), [confirmDropTarget, drawDraggedCard]);

  const activePlayer = useMemo(() => players.find((player) => player.id === activePlayerId) ?? null, [activePlayerId, players]);
  const heldCardRatio = heldCard ? heldCard.height_inches / heldCard.width_inches : 1.4;
  const heldCardPositionStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: heldY.value < windowHeight - 185 - bottomInset ? heldX.value : windowWidth / 2 },
      { translateY: heldY.value < windowHeight - 185 - bottomInset ? heldY.value : windowHeight / 2 },
    ],
  }));
  // Shrink the card on the UI thread once the finger leaves the hand panel.
  const heldCardScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heldY.value < windowHeight - 185 - bottomInset ? 0.52 : 1 }],
  }));

  return (
    <View pointerEvents="box-none" style={styles.overlay}>
      <View style={[styles.topBar, { top: topInset + 8 }]}>
        <Text style={styles.gameTitle}>{isPreparingGame ? 'Preparing deck piles…' : `Playing · ${activePlayer?.name ?? 'Add a player to begin'}`}</Text>
        <View style={styles.topActions}>
          <Pressable accessibilityRole="button" style={styles.manageButton} onPress={() => setGameMenuOpen(true)}>
            <Text style={styles.manageButtonText}>Game</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.doneButton} onPress={onClose}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      </View>

      {/* This persistent control sets the side for the next card moved from a pile. */}
      <View style={[styles.drawFaceToggleDock, { top: topInset + 62 }]}>
        <Text style={styles.drawFaceLabel}>Draw cards</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Draw cards face down"
          accessibilityState={{ selected: !drawFaceUp }}
          style={[styles.drawFaceButton, !drawFaceUp && styles.drawFaceButtonActive]}
          onPress={() => onDrawFaceUpChange(false)}
        >
          <Text style={[styles.drawFaceButtonText, !drawFaceUp && styles.drawFaceButtonTextActive]}>Down</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Draw cards face up"
          accessibilityState={{ selected: drawFaceUp }}
          style={[styles.drawFaceButton, drawFaceUp && styles.drawFaceButtonActive]}
          onPress={() => onDrawFaceUpChange(true)}
        >
          <Text style={[styles.drawFaceButtonText, drawFaceUp && styles.drawFaceButtonTextActive]}>Up</Text>
        </Pressable>
      </View>

      <View style={[styles.handPanel, { paddingBottom: Math.max(bottomInset, 8) }]}>
        <View style={styles.playerRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.playerList}>
            {players.map((player) => (
              <Pressable key={player.id} style={[styles.playerChip, player.id === activePlayerId && styles.activePlayerChip]} onPress={() => setActivePlayerId(player.id)}>
                <Text style={[styles.playerChipText, player.id === activePlayerId && styles.activePlayerChipText]}>{player.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable style={styles.addPlayerButton} onPress={() => setAddPlayerOpen(true)}><Text style={styles.addPlayerText}>+ Player</Text></Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.handList}>
          {hand.length === 0 ? (
            <Text style={styles.emptyHandText}>{activePlayer ? 'Hold a deck on the board to draw cards.' : 'Add a player to start.'}</Text>
          ) : hand.map((card) => (
            <HandCardItem key={card.id} card={card} dragX={heldX} dragY={heldY}
              onFlipCard={flipHandCard} onHoldCard={setHeldCard}
              onReleaseCard={releaseHandCard} onCancel={cancelHeldCard} />
          ))}
        </ScrollView>
      </View>

      {heldCard && (
        <Animated.View pointerEvents="none" style={[styles.heldCardAnchor, heldCardPositionStyle]}>
          <Animated.View style={[styles.heldCardPreview, {
            left: -86,
            top: -(172 * heldCardRatio) / 2,
          }, heldCardScaleStyle]}>
            <CardFaceArtwork card={heldCard} width={172} height={172 * heldCardRatio} />
          </Animated.View>
        </Animated.View>
      )}

      <Modal visible={gameMenuOpen} transparent animationType="fade" onRequestClose={() => setGameMenuOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Gameplay</Text>
            <Pressable style={styles.manageOption} onPress={() => {
              setGameMenuOpen(false);
              setSaveName(`Save ${new Date().toLocaleString()}`);
              setSaveDialogOpen(true);
            }}>
              <Text style={styles.manageOptionText}>Save Current Game</Text>
            </Pressable>
            <Pressable style={styles.manageOption} onPress={() => void openSavedGames()}>
              <Text style={styles.manageOptionText}>Load Saved Game</Text>
            </Pressable>
            <Pressable style={[styles.manageOption, styles.freshGameOption]} onPress={() => {
              setGameMenuOpen(false);
              Alert.alert(
                'Start a fresh game?',
                'This resets the current players and piles to the project setup. Named saved games will remain available to load.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Start Fresh', style: 'destructive', onPress: () => void startFreshGame() },
                ]
              );
            }}>
              <Text style={styles.freshGameText}>Start Fresh</Text>
            </Pressable>
            <Pressable style={styles.cancelButton} onPress={() => setGameMenuOpen(false)}><Text>Close</Text></Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={saveDialogOpen} transparent animationType="fade" onRequestClose={() => setSaveDialogOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Save Gameplay State</Text>
            <TextInput value={saveName} onChangeText={setSaveName} placeholder="Save name" style={styles.nameInput} returnKeyType="done" onSubmitEditing={() => void saveCurrentGameplay()} />
            <View style={styles.choiceRow}>
              <Pressable style={styles.cancelButton} onPress={() => setSaveDialogOpen(false)}><Text>Cancel</Text></Pressable>
              <Pressable style={styles.choiceButton} onPress={() => void saveCurrentGameplay()}><Text style={styles.choiceText}>Save Game</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={savedGamesOpen} transparent animationType="fade" onRequestClose={() => setSavedGamesOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Saved Games</Text>
            <ScrollView style={styles.savedGamesList} contentContainerStyle={styles.savedGamesContent}>
              {savedGames.map((save) => (
                <Pressable key={save.id} style={styles.savedGameOption} onPress={() => void loadSavedGameplay(save.id)}>
                  <Text style={styles.savedGameName}>{save.name}</Text>
                  <Text style={styles.savedGameDate}>{new Date(save.created_at).toLocaleString()}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.cancelButton} onPress={() => setSavedGamesOpen(false)}><Text>Close</Text></Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={dropCardId !== null && pendingDropSpotId !== null} transparent animationType="fade" onRequestClose={() => { setDropCardId(null); setPendingDropSpotId(null); }}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Place card in pile</Text>
            <Text style={styles.dialogHint}>Choose where the card goes.</Text>
            <View style={styles.dropChoices}>
              {(['top', 'middle', 'bottom'] as const).map((position) => (
                <Pressable key={position} style={styles.dropChoice} onPress={() => void discardCard(position)}>
                  <Text style={styles.choiceText}>{position[0].toUpperCase() + position.slice(1)}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={styles.cancelButton} onPress={() => { setDropCardId(null); setPendingDropSpotId(null); }}><Text>Cancel</Text></Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={addPlayerOpen} transparent animationType="fade" onRequestClose={() => setAddPlayerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Add a player</Text>
            <TextInput value={playerName} onChangeText={setPlayerName} placeholder={`Player ${players.length + 1}`} style={styles.nameInput} returnKeyType="done" onSubmitEditing={() => void addPlayer()} />
            <View style={styles.choiceRow}>
              <Pressable style={styles.cancelButton} onPress={() => setAddPlayerOpen(false)}><Text>Cancel</Text></Pressable>
              <Pressable style={styles.choiceButton} onPress={() => void addPlayer()}><Text style={styles.choiceText}>Add Player</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
});

function asTile(card: HandCard): BoardTileVisual {
  return {
    id: card.card_id,
    name: card.name,
    shape: 'square',
    widthInches: card.width_inches,
    heightInches: card.height_inches,
    color: '#FFFFFF',
    frontSurfaceId: card.surface_id,
    backSurfaceId: card.back_surface_id,
  };
}

const HandCardItem = memo(function HandCardItem({
  card,
  dragX,
  dragY,
  onFlipCard,
  onHoldCard,
  onReleaseCard,
  onCancel,
}: {
  card: HandCard;
  dragX: SharedValue<number>;
  dragY: SharedValue<number>;
  onFlipCard: (card: HandCard) => void;
  onHoldCard: (card: HandCard) => void;
  onReleaseCard: (cardId: number, x: number, y: number) => void;
  onCancel: () => void;
}) {
  const pan = usePanGesture({
    minPointers: 1,
    maxPointers: 1,
    activateAfterLongPress: 350,
    onActivate: ({ absoluteX, absoluteY }) => {
      dragX.value = absoluteX;
      dragY.value = absoluteY;
      scheduleOnRN(onHoldCard, card);
    },
    onUpdate: ({ absoluteX, absoluteY }) => {
      dragX.value = absoluteX;
      dragY.value = absoluteY;
    },
    onDeactivate: ({ absoluteX, absoluteY, canceled }) => {
      if (canceled) scheduleOnRN(onCancel);
      else scheduleOnRN(onReleaseCard, card.id, absoluteX, absoluteY);
    },
  });

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.handCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Flip ${card.name}`}
          onPress={() => onFlipCard(card)}
          style={[styles.cardMiniature, card.face_up === 0 && styles.faceDownMiniature]}
        >
          <CardFaceArtwork card={card} width={56} height={56 * card.height_inches / card.width_inches} />
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.flipButton} onPress={() => onFlipCard(card)}>
          <Text style={styles.flipButtonText}>Flip</Text>
        </Pressable>
      </View>
    </GestureDetector>
  );
});

function CardFaceArtwork({ card, width, height }: { card: HandCard; width: number; height: number }) {
  if (card.face_up === 0 && !card.back_surface_id) {
    return (
      <View style={[styles.genericCardBack, { width, height }]}>
        <View style={styles.genericCardBackInset}>
          <Text style={styles.genericCardBackText}>CARD</Text>
        </View>
      </View>
    );
  }

  return (
    <BoardTileArtworkPreview
      tile={asTile(card)}
      width={width}
      height={height}
      faceUp={card.face_up === 1}
    />
  );
}
