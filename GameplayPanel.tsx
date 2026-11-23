import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions, type ViewInstance } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { useSQLiteContext } from 'expo-sqlite';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { BoardTileArtworkPreview, type BoardTileVisual } from './DrawingCanvas';
import { insertRows, withSafeWriteTransaction, type SQLiteTransactionConnection } from './databaseTransactions';
import { gameplayStyles as styles } from './gameplayStyles';
import type { Point } from './types';

/** Height of the hand panel at the bottom of the screen; drops below this line land in the hand. */
const HAND_PANEL_HEIGHT = 198;

/**
 * Remove every row that belongs to the live game for this project. Pieces taken
 * from a deck or supply during play are stored as board placements flagged
 * is_added, so they are deleted too; the creator's own placements, decks and
 * supplies are never touched here.
 */
async function clearGameplayState(txn: SQLiteTransactionConnection, projectId: string) {
  await txn.runAsync('DELETE FROM play_card_instances WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM gameplay_card_piles WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM game_players WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM play_initialized_spots WHERE project_id = ?', projectId);
  await txn.runAsync(`DELETE FROM tile_board_placements WHERE id IN (
    SELECT placement_id FROM gameplay_tile_placement_states WHERE project_id = ? AND is_added = 1)`, projectId);
  await txn.runAsync(`DELETE FROM token_board_placements WHERE id IN (
    SELECT placement_id FROM gameplay_token_placement_states WHERE project_id = ? AND is_added = 1)`, projectId);
  await txn.runAsync('DELETE FROM gameplay_tile_placement_states WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM gameplay_token_placement_states WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM gameplay_die_placement_states WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM gameplay_tile_deck_returns WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM gameplay_token_supply_returns WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM gameplay_tile_deck_takes WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM gameplay_tile_deck_order WHERE project_id = ?', projectId);
  await txn.runAsync('DELETE FROM gameplay_token_supply_takes WHERE project_id = ?', projectId);
}

async function idSet(txn: SQLiteTransactionConnection, sql: string, param: string) {
  const rows = await txn.getAllAsync<{ id: number }>(sql, param);
  return new Set(rows.map((row) => row.id));
}

type Player = { id: number; name: string; order_index: number; hand_count?: number };
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
  gameplay_pile_id?: number | null;
  gameplay_pile_order?: number | null;
  face_up: number;
  hand_order: number;
  pile_order: number;
};
type GameplayCardPileSnapshot = {
  id: number;
  project_id: string;
  x: number;
  y: number;
  orientation: number;
  created_at: number;
};
type InitializedSpotSnapshot = { project_id: string; spot_id: number; deck_id: number; initialized_at: number };
type TileReturnSnapshot = { project_id: string; deck_id: number; tile_id: number; quantity: number; updated_at: number };
type TokenReturnSnapshot = { project_id: string; supply_id: number; quantity: number; updated_at: number };
type TileTakeSnapshot = TileReturnSnapshot;
type TileDeckOrderSnapshot = { project_id: string; deck_id: number; tile_id: number | null; order_index: number };
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
  cardPiles?: GameplayCardPileSnapshot[];
  initializedSpots: InitializedSpotSnapshot[];
  tileReturns?: TileReturnSnapshot[];
  tokenReturns?: TokenReturnSnapshot[];
  tileTakes?: TileTakeSnapshot[];
  tileDeckOrder?: TileDeckOrderSnapshot[];
  tokenTakes?: TokenTakeSnapshot[];
  tilePlacementStates?: TilePlacementStateSnapshot[];
  tokenPlacementStates?: TokenPlacementStateSnapshot[];
  diePlacementStates?: DiePlacementStateSnapshot[];
  addedTiles?: AddedTileSnapshot[];
  addedTokens?: AddedTokenSnapshot[];
  activePlayerId: number | null;
};
type GameplaySave = { id: number; name: string; created_at: number; updated_at: number };
type DeckOrderTarget = {
  kind: 'card' | 'tile';
  id: number;
  name: string;
  detail: string;
  count: number;
};

type DropRequest = { requestId: number; cardInstanceId: number; absoluteX: number; absoluteY: number };

function shuffleInPlace<T>(items: T[]) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

export type GameplayPanelHandle = {
  /** Finish a dragged card from a deck pile onto the hand area or another pile. */
  resolveDeckCardDrop: (sourceSpotId: number, targetSpotId: number | null, absoluteY: number, dropPoint: Point) => void;
  /** Continue a hand-card drag after the board has identified the target spot. */
  resolveHandCardDrop: (cardInstanceId: number, spotId: number | null, dropPoint: Point | null) => void;
  /** Open order controls for the card pile or tile deck the player tapped. */
  openDeckOrderManager: (kind: 'card' | 'tile', deckId: number) => void;
};

type GameplayPanelProps = {
  projectId: string;
  topInset: number;
  bottomInset: number;
  onClose: () => void;
  onBoardPilesChanged: (spotIds?: number[]) => void;
  onGameplayStateChanged: () => void;
  /** Wait for the board's queued piece writes so a save or reset sees the latest moves. */
  waitForBoardWrites: () => Promise<void>;
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
  waitForBoardWrites,
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
  const [deckOrderOpen, setDeckOrderOpen] = useState(false);
  const [deckOrderLoading, setDeckOrderLoading] = useState(false);
  const [selectedDeckOrderTarget, setSelectedDeckOrderTarget] = useState<DeckOrderTarget | null>(null);
  const [currentSaveId, setCurrentSaveId] = useState<number | null>(null);
  const [currentSaveName, setCurrentSaveName] = useState('');
  const [saveName, setSaveName] = useState('');
  const [savedGames, setSavedGames] = useState<GameplaySave[]>([]);
  const [heldCard, setHeldCard] = useState<HandCard | null>(null);
  const [pendingPlayer, setPendingPlayer] = useState<Player | null>(null);
  // Repeated gestures should not start overlapping card-write transactions.
  const cardDrawInFlightRef = useRef(false);
  const saveInFlightRef = useRef(false);
  // Shared values move the held card without re-rendering the board and every
  // card preview for each finger update.
  const heldX = useSharedValue(0);
  const heldY = useSharedValue(0);
  // These views are drop targets for hand-to-hand card transfers. Measuring
  // them at release time keeps the hand UI responsive while a card is moving.
  const playerDropTargetRefs = useRef(new Map<number, ViewInstance>());
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const refreshPlayers = useCallback(async () => {
    const rows = await db.getAllAsync<Player>(
      `SELECT player.id, player.name, player.order_index,
        (SELECT COUNT(*) FROM play_card_instances AS instance
         WHERE instance.project_id = player.project_id AND instance.player_id = player.id) AS hand_count
       FROM game_players AS player WHERE player.project_id = ? ORDER BY player.order_index, player.id`,
      projectId
    );
    setPlayers(rows);
    setActivePlayerId((current) => rows.some((player) => player.id === current) ? current : rows[0]?.id ?? null);
  }, [db, projectId]);

  // Update the visible counts from the completed card action instead of
  // rereading every player's hand after each draw, transfer, or discard.
  const adjustHandCounts = useCallback((changes: Array<{ playerId: number; amount: number }>) => {
    const amountByPlayer = new Map(changes.map(({ playerId, amount }) => [playerId, amount]));
    setPlayers((current) => current.map((player) => {
      const amount = amountByPlayer.get(player.id) ?? 0;
      return amount === 0
        ? player
        : { ...player, hand_count: Math.max(0, (player.hand_count ?? 0) + amount) };
    }));
  }, []);

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
    // One read finds only the piles that still need seeding, instead of one
    // lookup per marker every time play starts.
    const spots = await db.getAllAsync<{ id: number; deck_id: number; face_up: number }>(
      `SELECT spot.id, spot.deck_id, spot.face_up FROM deck_spots AS spot
      WHERE spot.surface_id = ? AND spot.spot_type = 'deck' AND spot.deck_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM play_initialized_spots AS done
          WHERE done.project_id = ? AND done.spot_id = spot.id
        )`,
      `${projectId}-board`,
      projectId
    );
    if (spots.length === 0) return;

    const deckIds = [...new Set(spots.map((spot) => spot.deck_id))];
    const recipeRows = await db.getAllAsync<{ deck_id: number; card_id: number; quantity: number }>(
      `SELECT deck_id, card_id, quantity FROM card_deck_items
      WHERE deck_id IN (${deckIds.map(() => '?').join(', ')})`,
      deckIds
    );
    const recipeByDeck = new Map<number, { card_id: number; quantity: number }[]>();
    for (const row of recipeRows) {
      const items = recipeByDeck.get(row.deck_id) ?? [];
      items.push(row);
      recipeByDeck.set(row.deck_id, items);
    }

    await withSafeWriteTransaction(db, async (txn) => {
      for (const spot of spots) {
        // Claim the pile first. If a reset or load is seeding at the same
        // moment, only one of them inserts cards, so a pile is never doubled.
        const claim = await txn.runAsync(
          `INSERT OR IGNORE INTO play_initialized_spots (project_id, spot_id, deck_id, initialized_at)
          VALUES (?, ?, ?, ?)`,
          projectId,
          spot.id,
          spot.deck_id,
          Date.now()
        );
        if (claim.changes === 0) continue;

        const cards = (recipeByDeck.get(spot.deck_id) ?? [])
          .flatMap((item) => Array.from({ length: item.quantity }, () => item.card_id));
        // Fisher-Yates shuffle gives each placed deck a fresh, randomized order.
        for (let index = cards.length - 1; index > 0; index -= 1) {
          const swapIndex = Math.floor(Math.random() * (index + 1));
          [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
        }
        await insertRows(
          txn,
          `INSERT INTO play_card_instances
            (project_id, card_id, deck_spot_id, player_id, face_up, pile_order)`,
          cards.map((cardId, index) => [projectId, cardId, spot.id, null, spot.face_up, index])
        );
      }
    });
  }, [db, projectId]);

  const loadDeckOrderTargets = useCallback(async (): Promise<DeckOrderTarget[]> => {
    const [cardPiles, gameplayPiles, tileDecks] = await Promise.all([
      db.getAllAsync<{
        id: number; spot_type: 'deck' | 'discard'; deck_name: string | null; card_count: number;
      }>(
        `SELECT spot.id, spot.spot_type, deck.name AS deck_name, COUNT(instance.id) AS card_count
         FROM deck_spots AS spot
         LEFT JOIN card_decks AS deck ON deck.id = spot.deck_id
         LEFT JOIN play_card_instances AS instance
           ON instance.deck_spot_id = spot.id AND instance.project_id = ? AND instance.player_id IS NULL
         WHERE spot.surface_id = ?
         GROUP BY spot.id, spot.spot_type, deck.name
         ORDER BY COALESCE(deck.name, 'Empty'), spot.id`,
        projectId,
        `${projectId}-board`
      ),
      db.getAllAsync<{
        id: number; card_count: number;
      }>(
        `SELECT pile.id,
          (SELECT COUNT(*) FROM play_card_instances AS instance
           WHERE instance.project_id = pile.project_id AND instance.gameplay_pile_id = pile.id) AS card_count
         FROM gameplay_card_piles AS pile WHERE pile.project_id = ? ORDER BY pile.id`,
        projectId
      ),
      db.getAllAsync<{
        id: number; name: string; tile_count: number;
      }>(
        `SELECT deck.id, deck.name,
          COALESCE((SELECT SUM(item.quantity) FROM tile_deck_items AS item WHERE item.deck_id = deck.id), 0) +
          COALESCE((SELECT SUM(returned.quantity) FROM gameplay_tile_deck_returns AS returned
            WHERE returned.project_id = deck.project_id AND returned.deck_id = deck.id), 0) -
          COALESCE((SELECT SUM(taken.quantity) FROM gameplay_tile_deck_takes AS taken
            WHERE taken.project_id = deck.project_id AND taken.deck_id = deck.id), 0) AS tile_count
         FROM tile_decks AS deck WHERE deck.project_id = ? ORDER BY deck.name, deck.id`,
        projectId
      ),
    ]);

    const targets: DeckOrderTarget[] = [
      ...cardPiles.map((pile) => ({
        kind: 'card' as const,
        id: pile.id,
        name: pile.deck_name ?? 'Card pile',
        detail: `${pile.spot_type === 'deck' ? 'Card deck' : 'Discard pile'} · Spot ${pile.id}`,
        count: pile.card_count,
      })),
      ...gameplayPiles.map((pile) => ({
        kind: 'card' as const,
        // Temporary board piles use negative IDs in the canvas so they cannot
        // collide with the positive IDs of saved deck spots.
        id: -pile.id,
        name: 'Card stack',
        detail: `Gameplay stack · ${pile.card_count} ${pile.card_count === 1 ? 'card' : 'cards'}`,
        count: pile.card_count,
      })),
      ...tileDecks.map((deck) => ({
        kind: 'tile' as const,
        id: deck.id,
        name: deck.name,
        detail: 'Tile deck',
        count: deck.tile_count,
      })),
    ];
    return targets;
  }, [db, projectId]);

  const openDeckOrderManager = useCallback((kind: 'card' | 'tile', deckId: number) => {
    setGameMenuOpen(false);
    setSelectedDeckOrderTarget(null);
    setDeckOrderLoading(true);
    setDeckOrderOpen(true);
    void loadDeckOrderTargets().then((targets) => {
      setSelectedDeckOrderTarget(targets.find((target) => target.kind === kind && target.id === deckId) ?? null);
    }).catch((error) => {
      console.error('Could not load gameplay decks:', error);
      Alert.alert('Could not load decks', 'Please try again.');
    }).finally(() => {
      setDeckOrderLoading(false);
    });
  }, [loadDeckOrderTargets]);

  const applyDeckOrder = useCallback(async (order: 'shuffle' | 'sort') => {
    const target = selectedDeckOrderTarget;
    if (!target) return;

    try {
      if (target.kind === 'card') {
        const isGameplayPile = target.id < 0;
        const pileId = isGameplayPile ? -target.id : null;
        await withSafeWriteTransaction(db, async (txn) => {
          const cards = await txn.getAllAsync<{ id: number }>(
            isGameplayPile
              ? order === 'sort'
                ? `SELECT instance.id FROM play_card_instances AS instance
                   JOIN cards AS card ON card.id = instance.card_id
                   WHERE instance.project_id = ? AND instance.gameplay_pile_id = ?
                   ORDER BY lower(card.name), card.id, instance.id`
                : `SELECT id FROM play_card_instances
                   WHERE project_id = ? AND gameplay_pile_id = ? ORDER BY gameplay_pile_order, id`
              : order === 'sort'
              ? `SELECT instance.id FROM play_card_instances AS instance
                 JOIN cards AS card ON card.id = instance.card_id
                 WHERE instance.project_id = ? AND instance.deck_spot_id = ? AND instance.player_id IS NULL
                 ORDER BY lower(card.name), card.id, instance.id`
              : `SELECT id FROM play_card_instances
                 WHERE project_id = ? AND deck_spot_id = ? AND player_id IS NULL ORDER BY pile_order, id`,
            projectId,
            pileId ?? target.id
          );
          const orderedCards = order === 'shuffle' ? shuffleInPlace(cards) : cards;
          for (let index = 0; index < orderedCards.length; index += 1) {
            await txn.runAsync(
              isGameplayPile
                ? 'UPDATE play_card_instances SET gameplay_pile_order = ? WHERE id = ? AND project_id = ?'
                : 'UPDATE play_card_instances SET pile_order = ? WHERE id = ? AND project_id = ?',
              index,
              orderedCards[index].id,
              projectId
            );
          }
        });
        if (isGameplayPile) onGameplayStateChanged();
        else onBoardPilesChanged([target.id]);
      } else {
        await withSafeWriteTransaction(db, async (txn) => {
          const tiles = await txn.getAllAsync<{
            tile_id: number; name: string; quantity: number;
          }>(
            `SELECT item.tile_id, tile.name,
              MAX(0, item.quantity +
                COALESCE((SELECT SUM(returned.quantity) FROM gameplay_tile_deck_returns AS returned
                  WHERE returned.project_id = ? AND returned.deck_id = item.deck_id
                    AND returned.tile_id = item.tile_id), 0) -
                COALESCE((SELECT SUM(taken.quantity) FROM gameplay_tile_deck_takes AS taken
                  WHERE taken.project_id = ? AND taken.deck_id = item.deck_id
                    AND taken.tile_id = item.tile_id), 0)) AS quantity
             FROM tile_deck_items AS item
             JOIN game_tiles AS tile ON tile.id = item.tile_id
             WHERE item.deck_id = ?
             ORDER BY lower(tile.name), tile.id`,
            projectId,
            projectId,
            target.id
          );
          const copies = tiles.flatMap((tile) => Array.from(
            { length: Math.max(0, Math.trunc(tile.quantity)) },
            () => tile.tile_id
          ));
          if (order === 'shuffle') shuffleInPlace(copies);

          // The marker says this game has an explicit order, including when
          // every tile has been drawn. Copies then hold the actual draw order.
          await txn.runAsync(
            `INSERT OR IGNORE INTO gameplay_tile_deck_order
              (project_id, deck_id, tile_id, order_index) VALUES (?, ?, NULL, -1)`,
            projectId,
            target.id
          );
          await txn.runAsync(
            'DELETE FROM gameplay_tile_deck_order WHERE project_id = ? AND deck_id = ? AND tile_id IS NOT NULL',
            projectId,
            target.id
          );
          await insertRows(
            txn,
            'INSERT INTO gameplay_tile_deck_order (project_id, deck_id, tile_id, order_index)',
            copies.map((tileId, index) => [projectId, target.id, tileId, index])
          );
        });
        onGameplayStateChanged();
      }

      const updatedTargets = await loadDeckOrderTargets();
      setSelectedDeckOrderTarget(updatedTargets.find((item) => item.kind === target.kind && item.id === target.id) ?? null);
      Alert.alert(order === 'shuffle' ? 'Deck shuffled' : 'Deck sorted', `${target.name} was ${order === 'shuffle' ? 'shuffled' : 'sorted by tile or card name'}.`);
    } catch (error) {
      console.error(`Could not ${order} gameplay deck:`, error);
      Alert.alert(`Could not ${order} deck`, 'Please try again.');
    }
  }, [db, loadDeckOrderTargets, onBoardPilesChanged, onGameplayStateChanged, projectId, selectedDeckOrderTarget]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initializeDeckSpots();
        onBoardPilesChanged();
        const rows = await db.getAllAsync<Player>(
          `SELECT player.id, player.name, player.order_index,
            (SELECT COUNT(*) FROM play_card_instances AS instance
             WHERE instance.project_id = player.project_id AND instance.player_id = player.id) AS hand_count
           FROM game_players AS player WHERE player.project_id = ? ORDER BY player.order_index, player.id`,
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
    absoluteY: number,
    dropPoint: Point
  ) => {
    if (isPreparingGame) return;
    if (cardDrawInFlightRef.current) return;
    const droppedOnHand = absoluteY >= windowHeight - HAND_PANEL_HEIGHT - bottomInset;
    if (!droppedOnHand && targetSpotId === sourceSpotId) return;
    if (!droppedOnHand && targetSpotId === null && !dropPoint) return;
    if (droppedOnHand && activePlayerId === null) {
      Alert.alert('Add a player first', 'Create a player before drawing cards into a hand.');
      return;
    }

    cardDrawInFlightRef.current = true;
    let movedToHand = false;
    let runtimePileChanged = sourceSpotId < 0 || targetSpotId === null || (targetSpotId ?? 0) < 0;
    let targetRuntimePileId = targetSpotId !== null && targetSpotId < 0 ? -targetSpotId : null;
    let movedCardToBoard = false;
    try {
      await withSafeWriteTransaction(db, async (txn) => {
        const sourceRuntimePileId = sourceSpotId < 0 ? -sourceSpotId : null;
        const sourceCard = await txn.getFirstAsync<{ id: number }>(
          sourceRuntimePileId !== null
            ? `SELECT id FROM play_card_instances
               WHERE project_id = ? AND gameplay_pile_id = ? AND player_id IS NULL
               ORDER BY gameplay_pile_order, id LIMIT 1`
            : `SELECT id FROM play_card_instances
               WHERE project_id = ? AND deck_spot_id = ? AND player_id IS NULL
               ORDER BY pile_order, id LIMIT 1`,
          projectId,
          sourceRuntimePileId ?? sourceSpotId
        );
        if (!sourceCard) return;

        if (droppedOnHand) {
          await txn.runAsync(
            `UPDATE play_card_instances
             SET deck_spot_id = NULL,
               gameplay_pile_id = NULL,
               gameplay_pile_order = NULL,
               player_id = ?,
               face_up = ?,
               hand_order = COALESCE((
                 SELECT MAX(hand_order) + 1 FROM play_card_instances
                 WHERE project_id = ? AND player_id = ?
               ), 0)
             WHERE id = ? AND project_id = ?`,
            activePlayerId,
            drawFaceUp ? 1 : 0,
            projectId,
            activePlayerId,
            sourceCard.id,
            projectId
          );
          movedToHand = true;
        } else {
          if (targetSpotId === null) {
            const result = await txn.runAsync(
              `INSERT INTO gameplay_card_piles (project_id, x, y, orientation, created_at)
               VALUES (?, ?, ?, 0, ?)`,
              projectId,
              dropPoint.x,
              dropPoint.y,
              Date.now()
            );
            targetRuntimePileId = result.lastInsertRowId;
            runtimePileChanged = true;
          }

          if (targetRuntimePileId !== null) {
            const destination = await txn.getFirstAsync<{ id: number }>(
              'SELECT id FROM gameplay_card_piles WHERE id = ? AND project_id = ?',
              targetRuntimePileId,
              projectId
            );
            if (!destination) return;
            const update = await txn.runAsync(
              `UPDATE play_card_instances SET deck_spot_id = NULL, player_id = NULL,
                gameplay_pile_id = ?, face_up = ?, gameplay_pile_order = COALESCE((
                  SELECT MIN(gameplay_pile_order) FROM play_card_instances
                  WHERE project_id = ? AND gameplay_pile_id = ?
                ), 0) - 1 WHERE id = ? AND project_id = ?`,
              targetRuntimePileId,
              drawFaceUp ? 1 : 0,
              projectId,
              targetRuntimePileId,
              sourceCard.id,
              projectId
            );
            movedCardToBoard = update.changes > 0;
          } else {
            const update = await txn.runAsync(
              `UPDATE play_card_instances SET deck_spot_id = ?, player_id = NULL,
                gameplay_pile_id = NULL, gameplay_pile_order = NULL, face_up = ?, pile_order = COALESCE((
                  SELECT MIN(pile_order) FROM play_card_instances
                  WHERE project_id = ? AND deck_spot_id = ? AND player_id IS NULL
                ), 0) - 1 WHERE id = ? AND project_id = ?`,
              targetSpotId,
              drawFaceUp ? 1 : 0,
              projectId,
              targetSpotId,
              sourceCard.id,
              projectId
            );
            movedCardToBoard = update.changes > 0;
          }
        }

        // Empty temporary piles have no marker and no lingering saved state.
        if (sourceRuntimePileId !== null) {
          await txn.runAsync(
            `DELETE FROM gameplay_card_piles WHERE id = ? AND project_id = ?
             AND NOT EXISTS (SELECT 1 FROM play_card_instances WHERE project_id = ? AND gameplay_pile_id = ?)`,
            sourceRuntimePileId,
            projectId,
            projectId,
            sourceRuntimePileId
          );
        }
      });
      if (droppedOnHand && activePlayerId !== null && movedToHand) {
        adjustHandCounts([{ playerId: activePlayerId, amount: 1 }]);
        await refreshHand(activePlayerId);
      }
      if (movedToHand || movedCardToBoard) {
        if (runtimePileChanged) onBoardPilesChanged();
        else onBoardPilesChanged(droppedOnHand ? [sourceSpotId] : [sourceSpotId, targetSpotId!]);
      }
    } catch (error) {
      console.error('Could not move card from deck:', error);
      Alert.alert('Could not move card', 'Please try again.');
    } finally {
      cardDrawInFlightRef.current = false;
    }
  }, [activePlayerId, adjustHandCounts, bottomInset, db, drawFaceUp, isPreparingGame, onBoardPilesChanged, projectId, refreshHand, windowHeight]);

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

  // Move a card instance between hands without changing its face-up state.
  // The card data remains part of gameplay state and is included in saves.
  const giveHandCardToPlayer = useCallback(async (cardId: number, recipientId: number) => {
    if (activePlayerId === null || recipientId === activePlayerId || cardDrawInFlightRef.current) return;
    cardDrawInFlightRef.current = true;
    try {
      await withSafeWriteTransaction(db, async (txn) => {
        const moved = await txn.getFirstAsync<{ id: number }>(
          `UPDATE play_card_instances
           SET deck_spot_id = NULL, player_id = ?, hand_order = COALESCE((
             SELECT MAX(hand_order) + 1 FROM play_card_instances
             WHERE project_id = ? AND player_id = ?
           ), 0)
           WHERE id = ? AND project_id = ? AND player_id = ?
           RETURNING id`,
          recipientId,
          projectId,
          recipientId,
          cardId,
          projectId,
          activePlayerId
        );
        if (!moved) throw new Error('That card is no longer in the active hand.');
      });
      adjustHandCounts([
        { playerId: activePlayerId, amount: -1 },
        { playerId: recipientId, amount: 1 },
      ]);
      await refreshHand(activePlayerId);
    } catch (error) {
      console.error('Could not give card to player:', error);
      Alert.alert('Could not give card', 'Please try again.');
    } finally {
      cardDrawInFlightRef.current = false;
    }
  }, [activePlayerId, adjustHandCounts, db, projectId, refreshHand]);

  // Selecting this action takes one randomly chosen card from another player's
  // hand and appends it to the active player's hand without revealing its face.
  const drawRandomCardFromPlayer = useCallback(async (sourcePlayerId: number) => {
    if (activePlayerId === null || sourcePlayerId === activePlayerId || cardDrawInFlightRef.current) return;
    cardDrawInFlightRef.current = true;
    let movedSuccessfully = false;
    try {
      await withSafeWriteTransaction(db, async (txn) => {
        const moved = await txn.getFirstAsync<{ id: number }>(
          `UPDATE play_card_instances
           SET player_id = ?, hand_order = COALESCE((
             SELECT MAX(hand_order) + 1 FROM play_card_instances
             WHERE project_id = ? AND player_id = ?
           ), 0)
           WHERE id = (
             SELECT id FROM play_card_instances
             WHERE project_id = ? AND player_id = ?
             ORDER BY RANDOM() LIMIT 1
           ) AND project_id = ? AND player_id = ?
           RETURNING id`,
          activePlayerId,
          projectId,
          activePlayerId,
          projectId,
          sourcePlayerId,
          projectId,
          sourcePlayerId
        );
        movedSuccessfully = moved !== null;
      });
      if (!movedSuccessfully) {
        Alert.alert('No cards to draw', 'That player’s hand is empty.');
        return;
      }
      adjustHandCounts([
        { playerId: activePlayerId, amount: 1 },
        { playerId: sourcePlayerId, amount: -1 },
      ]);
      await refreshHand(activePlayerId);
    } catch (error) {
      console.error('Could not draw a random card from player:', error);
      Alert.alert('Could not draw card', 'Please try again.');
    } finally {
      cardDrawInFlightRef.current = false;
    }
  }, [activePlayerId, adjustHandCounts, db, projectId, refreshHand]);

  const releaseHandCard = useCallback((cardId: number, absoluteX: number, absoluteY: number) => {
    setHeldCard(null);
    // Player chips are checked first, so dropping directly on one transfers a
    // card to that player's hand instead of forwarding the drop to the board.
    const measurements = players.map((player) => new Promise<{
      playerId: number; left: number; top: number; width: number; height: number;
    } | null>((resolve) => {
      const target = playerDropTargetRefs.current.get(player.id);
      if (!target) {
        resolve(null);
        return;
      }
      target.measureInWindow((left, top, width, height) => {
        resolve({ playerId: player.id, left, top, width, height });
      });
    }));
    void Promise.all(measurements).then((bounds) => {
      const target = bounds.find((item) => item
        && absoluteX >= item.left && absoluteX <= item.left + item.width
        && absoluteY >= item.top && absoluteY <= item.top + item.height);
      if (target) {
        if (target.playerId !== activePlayerId) void giveHandCardToPlayer(cardId, target.playerId);
        return;
      }
      onHandCardDropRequest(cardId, absoluteX, absoluteY);
    }).catch((error) => {
      console.error('Could not check player card-drop targets:', error);
      onHandCardDropRequest(cardId, absoluteX, absoluteY);
    });
  }, [activePlayerId, giveHandCardToPlayer, onHandCardDropRequest, players]);
  const cancelHeldCard = useCallback(() => setHeldCard(null), []);

  const saveCurrentGameplay = useCallback(async () => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    const name = saveName.trim() || currentSaveName || `Save ${new Date().toLocaleString()}`;
    try {
      // A piece dropped just before tapping Save may still be in the board's
      // write queue. Let it land so the snapshot matches what is on screen.
      await waitForBoardWrites();
      const [savedPlayers, cards, cardPiles, initializedSpots, tileReturns, tokenReturns, tileTakes, tokenTakes,
        tileDeckOrder, tilePlacementStates, tokenPlacementStates, diePlacementStates, addedTiles, addedTokens] = await Promise.all([
        db.getAllAsync<Player>(
          'SELECT id, name, order_index FROM game_players WHERE project_id = ? ORDER BY order_index, id',
          projectId
        ),
        db.getAllAsync<PlayCardSnapshot>(
          `SELECT id, project_id, card_id, deck_spot_id, player_id, gameplay_pile_id, gameplay_pile_order,
            face_up, hand_order, pile_order
          FROM play_card_instances WHERE project_id = ? ORDER BY id`,
          projectId
        ),
        db.getAllAsync<GameplayCardPileSnapshot>(
          'SELECT id, project_id, x, y, orientation, created_at FROM gameplay_card_piles WHERE project_id = ? ORDER BY id',
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
        db.getAllAsync<TileDeckOrderSnapshot>(
          `SELECT project_id, deck_id, tile_id, order_index FROM gameplay_tile_deck_order
           WHERE project_id = ? ORDER BY deck_id, order_index, id`,
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
        players: savedPlayers, cards, cardPiles, initializedSpots, tileReturns, tokenReturns, tileTakes, tokenTakes,
        tileDeckOrder, tilePlacementStates, tokenPlacementStates, diePlacementStates, addedTiles, addedTokens, activePlayerId,
      };
      const now = Date.now();
      const snapshotJson = JSON.stringify(snapshot);
      let savedId = currentSaveId;
      if (savedId !== null) {
        const update = await db.runAsync(
          `UPDATE gameplay_saves SET name = ?, snapshot_json = ?, updated_at = ?
           WHERE id = ? AND project_id = ?`,
          name,
          snapshotJson,
          now,
          savedId,
          projectId
        );
        if (update.changes === 0) savedId = null;
      }
      if (savedId === null) {
        const insert = await db.runAsync(
          `INSERT INTO gameplay_saves (project_id, name, snapshot_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          projectId,
          name,
          snapshotJson,
          now,
          now
        );
        savedId = insert.lastInsertRowId;
      }
      setCurrentSaveId(savedId);
      setCurrentSaveName(name);
      setSavedGames((current) => {
        const existing = current.find((save) => save.id === savedId);
        const savedRow = { id: savedId!, name, created_at: existing?.created_at ?? now, updated_at: now };
        return [savedRow, ...current.filter((save) => save.id !== savedId)];
      });
      setSaveDialogOpen(false);
      setSaveName('');
      Alert.alert('Game saved', `“${name}” is available from Load Saved Game.`);
    } catch (error) {
      console.error('Could not save gameplay state:', error);
      Alert.alert('Could not save game', 'Please try again.');
    } finally {
      saveInFlightRef.current = false;
    }
  }, [activePlayerId, currentSaveId, currentSaveName, db, projectId, saveName, waitForBoardWrites]);

  const openSavedGames = useCallback(async () => {
    try {
      const rows = await db.getAllAsync<GameplaySave>(
        'SELECT id, name, created_at, updated_at FROM gameplay_saves WHERE project_id = ? ORDER BY updated_at DESC, id DESC',
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

  const deleteSavedGame = useCallback((save: GameplaySave) => {
    Alert.alert(
      'Delete saved game?',
      `“${save.name}” will be permanently deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await db.runAsync(
                  'DELETE FROM gameplay_saves WHERE id = ? AND project_id = ?',
                  save.id,
                  projectId
                );
                setSavedGames((current) => current.filter((item) => item.id !== save.id));
                if (savedGames.length <= 1) setSavedGamesOpen(false);
                if (currentSaveId === save.id) {
                  setCurrentSaveId(null);
                  setCurrentSaveName('');
                  setSaveName('');
                }
              } catch (error) {
                console.error('Could not delete saved game:', error);
                Alert.alert('Could not delete saved game', 'Please try again.');
              }
            })();
          },
        },
      ]
    );
  }, [currentSaveId, db, projectId, savedGames.length]);

  const loadSavedGameplay = useCallback(async (saveId: number) => {
    try {
      const row = await db.getFirstAsync<{ snapshot_json: string; name: string }>(
        'SELECT snapshot_json, name FROM gameplay_saves WHERE id = ? AND project_id = ?',
        saveId,
        projectId
      );
      if (!row) throw new Error('Saved game was not found.');
      const snapshot = JSON.parse(row.snapshot_json) as GameplaySnapshot;
      if (!Array.isArray(snapshot.players) || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.initializedSpots)) {
        throw new Error('Saved game data is incomplete.');
      }

      // Queued piece writes from the current game must not land on top of the
      // restored state.
      await waitForBoardWrites();
      const boardSurfaceId = `${projectId}-board`;
      let restoredActivePlayerId: number | null = null;
      let skippedItems = 0;

      await withSafeWriteTransaction(db, async (txn) => {
        await clearGameplayState(txn, projectId);

        // The creator may have edited the game since this save was made. Look
        // up what still exists so a deleted card, pile, piece, deck or supply
        // is skipped instead of failing the whole restore on a foreign key.
        const spotIds = await idSet(txn, 'SELECT id FROM deck_spots WHERE surface_id = ?', boardSurfaceId);
        const cardIds = await idSet(txn, 'SELECT id FROM cards WHERE project_id = ?', projectId);
        const cardDeckIds = await idSet(txn, 'SELECT id FROM card_decks WHERE project_id = ?', projectId);
        const tilePlacementIds = await idSet(txn, 'SELECT id FROM tile_board_placements WHERE surface_id = ?', boardSurfaceId);
        const tokenPlacementIds = await idSet(txn, 'SELECT id FROM token_board_placements WHERE surface_id = ?', boardSurfaceId);
        const diePlacementIds = await idSet(txn, 'SELECT id FROM die_board_placements WHERE surface_id = ?', boardSurfaceId);
        const tileDeckIds = await idSet(txn, 'SELECT id FROM tile_decks WHERE project_id = ?', projectId);
        const tileIds = await idSet(txn, 'SELECT id FROM game_tiles WHERE project_id = ?', projectId);
        const supplyIds = await idSet(txn, 'SELECT id FROM token_supply_placements WHERE surface_id = ?', boardSurfaceId);
        const tokenIds = await idSet(txn, 'SELECT id FROM game_tokens WHERE project_id = ?', projectId);
        const keep = <T,>(items: T[] | undefined, isValid: (item: T) => boolean) => {
          const list = items ?? [];
          const kept = list.filter(isValid);
          skippedItems += list.length - kept.length;
          return kept;
        };
        const now = Date.now();

        // Players get new row IDs on restore, so every saved player reference
        // (hands and the active player) is translated through this map.
        const restoredPlayerIds = new Map<number, number>();
        for (const player of snapshot.players) {
          const result = await txn.runAsync(
            'INSERT INTO game_players (project_id, name, order_index, created_at) VALUES (?, ?, ?, ?)',
            projectId,
            player.name,
            player.order_index,
            now
          );
          restoredPlayerIds.set(player.id, result.lastInsertRowId);
        }
        restoredActivePlayerId = (snapshot.activePlayerId !== null
          ? restoredPlayerIds.get(snapshot.activePlayerId)
          : undefined) ?? restoredPlayerIds.values().next().value ?? null;

        const restoredCardPileIds = new Map<number, number>();
        for (const pile of keep(snapshot.cardPiles, (item) =>
          Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.orientation))) {
          const result = await txn.runAsync(
            `INSERT INTO gameplay_card_piles (project_id, x, y, orientation, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            projectId,
            pile.x,
            pile.y,
            pile.orientation,
            pile.created_at
          );
          restoredCardPileIds.set(pile.id, result.lastInsertRowId);
        }

        const cards = keep(snapshot.cards, (card) => {
          if (!cardIds.has(card.card_id)) return false;
          if (card.deck_spot_id !== null) {
            return card.player_id === null
              && (card.gameplay_pile_id === null || card.gameplay_pile_id === undefined)
              && spotIds.has(card.deck_spot_id);
          }
          if (card.gameplay_pile_id !== null && card.gameplay_pile_id !== undefined) {
            return card.player_id === null && restoredCardPileIds.has(card.gameplay_pile_id);
          }
          return card.player_id !== null && restoredPlayerIds.has(card.player_id);
        });
        await insertRows(
          txn,
          `INSERT INTO play_card_instances
            (project_id, card_id, deck_spot_id, player_id, gameplay_pile_id, gameplay_pile_order, face_up, hand_order, pile_order)`,
          cards.map((card) => [
            projectId,
            card.card_id,
            card.deck_spot_id,
            card.deck_spot_id === null && card.player_id !== null ? restoredPlayerIds.get(card.player_id)! : null,
            card.gameplay_pile_id !== null && card.gameplay_pile_id !== undefined
              ? restoredCardPileIds.get(card.gameplay_pile_id) ?? null
              : null,
            card.gameplay_pile_order ?? null,
            card.face_up,
            card.hand_order,
            card.pile_order,
          ])
        );

        const spots = keep(snapshot.initializedSpots, (spot) => spotIds.has(spot.spot_id) && cardDeckIds.has(spot.deck_id));
        await insertRows(
          txn,
          'INSERT INTO play_initialized_spots (project_id, spot_id, deck_id, initialized_at)',
          spots.map((spot) => [projectId, spot.spot_id, spot.deck_id, spot.initialized_at])
        );

        const tileDeckRowIsValid = (item: TileReturnSnapshot) => tileDeckIds.has(item.deck_id) && tileIds.has(item.tile_id);
        await insertRows(
          txn,
          'INSERT INTO gameplay_tile_deck_returns (project_id, deck_id, tile_id, quantity, updated_at)',
          keep(snapshot.tileReturns, tileDeckRowIsValid)
            .map((item) => [projectId, item.deck_id, item.tile_id, item.quantity, item.updated_at])
        );
        await insertRows(
          txn,
          'INSERT INTO gameplay_tile_deck_takes (project_id, deck_id, tile_id, quantity, updated_at)',
          keep(snapshot.tileTakes, tileDeckRowIsValid)
            .map((item) => [projectId, item.deck_id, item.tile_id, item.quantity, item.updated_at])
        );
        await insertRows(
          txn,
          'INSERT INTO gameplay_tile_deck_order (project_id, deck_id, tile_id, order_index)',
          keep(snapshot.tileDeckOrder, (item) => tileDeckIds.has(item.deck_id)
            && (item.tile_id === null || tileIds.has(item.tile_id)))
            .map((item) => [projectId, item.deck_id, item.tile_id, item.order_index])
        );
        await insertRows(
          txn,
          'INSERT INTO gameplay_token_supply_returns (project_id, supply_id, quantity, updated_at)',
          keep(snapshot.tokenReturns, (item) => supplyIds.has(item.supply_id))
            .map((item) => [projectId, item.supply_id, item.quantity, item.updated_at])
        );
        await insertRows(
          txn,
          'INSERT INTO gameplay_token_supply_takes (project_id, supply_id, quantity, updated_at)',
          keep(snapshot.tokenTakes, (item) => supplyIds.has(item.supply_id))
            .map((item) => [projectId, item.supply_id, item.quantity, item.updated_at])
        );

        // Added pieces are restored from addedTiles/addedTokens below with new
        // placement IDs, so their old state rows are not copied here.
        await insertRows(
          txn,
          `INSERT INTO gameplay_tile_placement_states
            (project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_deck_id)`,
          keep((snapshot.tilePlacementStates ?? []).filter((item) => !item.is_added), (item) => tilePlacementIds.has(item.placement_id))
            .map((item) => [
              projectId, item.placement_id, item.x, item.y, item.orientation, item.face_up, item.is_returned, 0,
              item.returned_deck_id !== null && tileDeckIds.has(item.returned_deck_id) ? item.returned_deck_id : null,
            ])
        );
        await insertRows(
          txn,
          `INSERT INTO gameplay_token_placement_states
            (project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_supply_id)`,
          keep((snapshot.tokenPlacementStates ?? []).filter((item) => !item.is_added), (item) => tokenPlacementIds.has(item.placement_id))
            .map((item) => [
              projectId, item.placement_id, item.x, item.y, item.orientation, item.face_up, item.is_returned, 0,
              item.returned_supply_id !== null && supplyIds.has(item.returned_supply_id) ? item.returned_supply_id : null,
            ])
        );
        await insertRows(
          txn,
          'INSERT INTO gameplay_die_placement_states (project_id, placement_id, face_number, updated_at)',
          keep(snapshot.diePlacementStates, (item) => diePlacementIds.has(item.placement_id))
            .map((item) => [projectId, item.placement_id, item.face_number, item.updated_at])
        );

        for (const tile of keep(snapshot.addedTiles, (item) => tileIds.has(item.tile_id))) {
          const result = await txn.runAsync(
            `INSERT INTO tile_board_placements (surface_id, tile_id, deck_id, x, y, orientation, face_up)
             VALUES (?, ?, NULL, ?, ?, ?, ?)`,
            boardSurfaceId, tile.tile_id, tile.x, tile.y, tile.orientation, tile.face_up
          );
          await txn.runAsync(
            `INSERT INTO gameplay_tile_placement_states
              (project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_deck_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            projectId, result.lastInsertRowId, tile.x, tile.y, tile.orientation, tile.face_up,
            tile.is_returned ?? 0,
            tile.returned_deck_id !== null && tileDeckIds.has(tile.returned_deck_id) ? tile.returned_deck_id : null
          );
        }
        for (const token of keep(snapshot.addedTokens, (item) => tokenIds.has(item.token_id))) {
          const result = await txn.runAsync(
            `INSERT INTO token_board_placements (surface_id, token_id, x, y, orientation, face_up)
             VALUES (?, ?, ?, ?, ?, ?)`,
            boardSurfaceId, token.token_id, token.x, token.y, token.orientation, token.face_up
          );
          await txn.runAsync(
            `INSERT INTO gameplay_token_placement_states
              (project_id, placement_id, x, y, orientation, face_up, is_returned, is_added, returned_supply_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            projectId, result.lastInsertRowId, token.x, token.y, token.orientation, token.face_up,
            token.is_returned ?? 0,
            token.returned_supply_id !== null && supplyIds.has(token.returned_supply_id) ? token.returned_supply_id : null
          );
        }
      });

      setSavedGamesOpen(false);
      setCurrentSaveId(saveId);
      setCurrentSaveName(row.name);
      await refreshPlayers();
      setActivePlayerId(restoredActivePlayerId);
      await refreshHand(restoredActivePlayerId);
      // Piles added to the board after this save was made start fresh.
      await initializeDeckSpots();
      onGameplayStateChanged();
      if (skippedItems > 0) {
        Alert.alert(
          'Game loaded with changes',
          `${skippedItems} saved ${skippedItems === 1 ? 'item was' : 'items were'} left out because the game setup changed since this save.`
        );
      }
    } catch (error) {
      console.error('Could not restore gameplay state:', error);
      Alert.alert('Could not load saved game', 'The saved state could not be restored.');
    }
  }, [db, initializeDeckSpots, onGameplayStateChanged, projectId, refreshHand, refreshPlayers, waitForBoardWrites]);

  const startFreshGame = useCallback(async () => {
    try {
      await waitForBoardWrites();
      await withSafeWriteTransaction(db, (txn) => clearGameplayState(txn, projectId));
      setPlayers([]);
      setActivePlayerId(null);
      setHand([]);
      setCurrentSaveId(null);
      setCurrentSaveName('');
      setGameMenuOpen(false);
      await initializeDeckSpots();
      onGameplayStateChanged();
    } catch (error) {
      console.error('Could not start a fresh game:', error);
      Alert.alert('Could not start fresh game', 'Please try again.');
    }
  }, [db, initializeDeckSpots, onGameplayStateChanged, projectId, waitForBoardWrites]);

  const [pendingDropSpotId, setPendingDropSpotId] = useState<number | null>(null);

  const discardCard = useCallback(async (position: 'top' | 'middle' | 'bottom') => {
    const cardId = dropCardId;
    const spotId = pendingDropSpotId;
    if (cardId === null || spotId === null) return;
    try {
      await withSafeWriteTransaction(db, async (txn) => {
        if (position !== 'middle') {
          // Top and bottom only need one write: pile_order is just a sort key,
          // so going one past the current end avoids renumbering the pile.
          await txn.runAsync(
            `UPDATE play_card_instances
             SET deck_spot_id = ?, player_id = NULL,
               pile_order = COALESCE((
                 SELECT ${position === 'top' ? 'MIN(pile_order) - 1' : 'MAX(pile_order) + 1'}
                 FROM play_card_instances
                 WHERE deck_spot_id = ? AND player_id IS NULL AND id != ?
               ), 0)
             WHERE id = ? AND project_id = ?`,
            spotId, spotId, cardId, cardId, projectId
          );
          return;
        }
        const pile = await txn.getAllAsync<{ id: number }>(
          `SELECT id FROM play_card_instances
          WHERE deck_spot_id = ? AND player_id IS NULL AND id != ?
          ORDER BY pile_order, id`,
          spotId,
          cardId
        );
        const orderedIds = pile.map((card) => card.id);
        orderedIds.splice(Math.floor(pile.length / 2), 0, cardId);
        for (let index = 0; index < orderedIds.length; index += 1) {
          if (orderedIds[index] === cardId) {
            await txn.runAsync(
              'UPDATE play_card_instances SET deck_spot_id = ?, player_id = NULL, pile_order = ? WHERE id = ? AND project_id = ?',
              spotId,
              index,
              cardId,
              projectId
            );
          } else {
            await txn.runAsync('UPDATE play_card_instances SET pile_order = ? WHERE id = ?', index, orderedIds[index]);
          }
        }
      });
      setDropCardId(null);
      setPendingDropSpotId(null);
      await refreshHand();
      if (activePlayerId !== null) adjustHandCounts([{ playerId: activePlayerId, amount: -1 }]);
      onBoardPilesChanged([spotId]);
    } catch (error) {
      console.error('Could not discard card:', error);
      Alert.alert('Could not discard card', 'Please try again.');
    }
  }, [activePlayerId, adjustHandCounts, db, dropCardId, onBoardPilesChanged, pendingDropSpotId, projectId, refreshHand]);

  // Hand cards dropped on a saved deck keep the existing top/middle/bottom
  // choice. Dropping onto a temporary stack adds to it; dropping on open board
  // space creates a new one-card stack at that location.
  const confirmDropTarget = useCallback(async (
    cardInstanceId: number,
    spotId: number | null,
    dropPoint: Point | null
  ) => {
    if (spotId !== null && spotId > 0) {
      try {
        const spot = await db.getFirstAsync<{ id: number }>(
          'SELECT id FROM deck_spots WHERE id = ? AND surface_id = ?',
          spotId,
          `${projectId}-board`
        );
        if (!spot) return;
        setPendingDropSpotId(spotId);
        setDropCardId(cardInstanceId);
      } catch (error) {
        console.error('Could not find the drop pile:', error);
      }
      return;
    }
    if (activePlayerId === null || dropPoint === null) return;

    try {
      let moved = false;
      await withSafeWriteTransaction(db, async (txn) => {
        const handCard = await txn.getFirstAsync<{ id: number }>(
          'SELECT id FROM play_card_instances WHERE id = ? AND project_id = ? AND player_id = ?',
          cardInstanceId,
          projectId,
          activePlayerId
        );
        if (!handCard) return;
        let gameplayPileId = spotId !== null && spotId < 0 ? -spotId : null;
        if (gameplayPileId === null) {
          const result = await txn.runAsync(
            `INSERT INTO gameplay_card_piles (project_id, x, y, orientation, created_at)
             VALUES (?, ?, ?, 0, ?)`,
            projectId,
            dropPoint.x,
            dropPoint.y,
            Date.now()
          );
          gameplayPileId = result.lastInsertRowId;
        } else {
          const existingPile = await txn.getFirstAsync<{ id: number }>(
            'SELECT id FROM gameplay_card_piles WHERE id = ? AND project_id = ?',
            gameplayPileId,
            projectId
          );
          if (!existingPile) return;
        }
        const update = await txn.runAsync(
          `UPDATE play_card_instances SET player_id = NULL, deck_spot_id = NULL,
            gameplay_pile_id = ?, gameplay_pile_order = COALESCE((
              SELECT MIN(gameplay_pile_order) FROM play_card_instances
              WHERE project_id = ? AND gameplay_pile_id = ?
            ), 0) - 1
           WHERE id = ? AND project_id = ? AND player_id = ?`,
          gameplayPileId,
          projectId,
          gameplayPileId,
          cardInstanceId,
          projectId,
          activePlayerId
        );
        moved = update.changes > 0;
      });
      if (!moved) return;
      adjustHandCounts([{ playerId: activePlayerId, amount: -1 }]);
      await refreshHand(activePlayerId);
      onBoardPilesChanged();
    } catch (error) {
      console.error('Could not place hand card on the board:', error);
      Alert.alert('Could not place card', 'Please try again.');
    }
  }, [activePlayerId, adjustHandCounts, db, onBoardPilesChanged, projectId, refreshHand]);

  useImperativeHandle(ref, () => ({
    resolveDeckCardDrop: (sourceSpotId, targetSpotId, absoluteY, dropPoint) => {
      void drawDraggedCard(sourceSpotId, targetSpotId, absoluteY, dropPoint);
    },
    resolveHandCardDrop: confirmDropTarget,
    openDeckOrderManager,
  }), [confirmDropTarget, drawDraggedCard, openDeckOrderManager]);

  const activePlayer = useMemo(() => players.find((player) => player.id === activePlayerId) ?? null, [activePlayerId, players]);
  // In pass-and-play, pause before changing hands so the current player can
  // cover their cards before the next player's hand is shown.
  const requestPlayerChange = useCallback((nextPlayer: Player) => {
    if (nextPlayer.id === activePlayerId) return;
    // Clear both the hand strip and the enlarged-card preview before opening
    // the pass screen, so the current cards are not visible behind the prompt.
    setHand([]);
    setHeldCard(null);
    setPendingPlayer(nextPlayer);
  }, [activePlayerId]);
  const cancelPlayerChange = useCallback(() => {
    setPendingPlayer(null);
    if (activePlayerId !== null) void refreshHand(activePlayerId);
  }, [activePlayerId, refreshHand]);
  const confirmPlayerChange = useCallback(() => {
    if (pendingPlayer) setActivePlayerId(pendingPlayer.id);
    setPendingPlayer(null);
  }, [pendingPlayer]);
  const heldCardRatio = heldCard ? heldCard.height_inches / heldCard.width_inches : 1.4;
  const heldCardPositionStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: heldY.value < windowHeight - HAND_PANEL_HEIGHT - bottomInset ? heldX.value : windowWidth / 2 },
      { translateY: heldY.value < windowHeight - HAND_PANEL_HEIGHT - bottomInset ? heldY.value : windowHeight / 2 },
    ],
  }));
  // Shrink the card on the UI thread once the finger leaves the hand panel.
  const heldCardScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heldY.value < windowHeight - HAND_PANEL_HEIGHT - bottomInset ? 0.52 : 1 }],
  }));
  // Virtualize a large hand so offscreen card artwork is not all mounted and
  // rasterized at once. The item itself is memoized to keep visible cards stable.
  const renderHandCard = useCallback(({ item }: { item: HandCard }) => (
    <View style={styles.handCardCell}>
      <HandCardItem
        card={item}
        dragX={heldX}
        dragY={heldY}
        onFlipCard={flipHandCard}
        onHoldCard={setHeldCard}
        onReleaseCard={releaseHandCard}
        onCancel={cancelHeldCard}
      />
    </View>
  ), [cancelHeldCard, flipHandCard, heldX, heldY, releaseHandCard]);

  return (
    <View pointerEvents="box-none" style={styles.overlay}>
      <View style={[styles.topBar, { top: topInset + 8 }]}>
        <Text accessibilityRole="header" style={styles.gameTitle}>{isPreparingGame ? 'Preparing deck piles…' : `Playing · ${activePlayer?.name ?? 'Add a player to begin'}`}</Text>
        <View style={styles.topActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Game menu" accessibilityHint="Save, load, or restart this game" style={styles.manageButton} onPress={() => setGameMenuOpen(true)}>
            <Text style={styles.manageButtonText}>Game</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Done playing" style={styles.doneButton} onPress={onClose}>
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
            {players.map((player) => {
              const isActivePlayer = player.id === activePlayerId;
              const handCount = player.hand_count ?? 0;
              return (
                <View
                  key={player.id}
                  ref={(node) => {
                    if (node) playerDropTargetRefs.current.set(player.id, node);
                    else playerDropTargetRefs.current.delete(player.id);
                  }}
                  collapsable={false}
                  style={[
                    styles.playerChip,
                    isActivePlayer && styles.activePlayerChip,
                    heldCard && !isActivePlayer && styles.playerDropTargetActive,
                  ]}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${player.name}'s hand, ${handCount} cards`}
                    accessibilityHint="Pass the device and confirm before showing this player's hand. Drag a card here to give it to them."
                    accessibilityState={{ selected: isActivePlayer }}
                    style={styles.playerChipMain}
                    onPress={() => requestPlayerChange(player)}
                  >
                    <Text numberOfLines={1} style={[styles.playerChipText, isActivePlayer && styles.activePlayerChipText]}>{player.name}</Text>
                    <Text style={[styles.playerChipCount, isActivePlayer && styles.activePlayerChipText]}>{handCount} cards</Text>
                  </Pressable>
                  {!isActivePlayer && (
                    <>
                      <Text style={styles.playerDropHint}>Drop</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Take a random card from ${player.name}`}
                        disabled={handCount === 0 || activePlayerId === null}
                        style={[styles.playerRandomButton, handCount === 0 && styles.playerRandomButtonDisabled]}
                        onPress={() => void drawRandomCardFromPlayer(player.id)}
                      >
                        <Text style={styles.playerRandomButtonText}>Random</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              );
            })}
          </ScrollView>
          <Pressable accessibilityRole="button" accessibilityLabel="Add player" style={styles.addPlayerButton} onPress={() => setAddPlayerOpen(true)}><Text style={styles.addPlayerText}>+ Player</Text></Pressable>
        </View>
        <FlatList
          horizontal
          data={hand}
          keyExtractor={(card) => String(card.id)}
          renderItem={renderHandCard}
          showsHorizontalScrollIndicator={false}
          style={styles.handListViewport}
          contentContainerStyle={styles.handList}
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={5}
          removeClippedSubviews={false}
          ListEmptyComponent={(
            <Text style={styles.emptyHandText}>
              {activePlayer ? 'Hold a deck on the board to draw cards.' : 'Add a player to start.'}
            </Text>
          )}
        />
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
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>Gameplay</Text>
            <Pressable accessibilityRole="button" style={styles.manageOption} onPress={() => {
              setGameMenuOpen(false);
              setSaveName(currentSaveName || `Save ${new Date().toLocaleString()}`);
              setSaveDialogOpen(true);
            }}>
              <Text style={styles.manageOptionText}>Save Current Game</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.manageOption} onPress={() => void openSavedGames()}>
              <Text style={styles.manageOptionText}>Load Saved Game</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={[styles.manageOption, styles.freshGameOption]} onPress={() => {
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
            <Pressable accessibilityRole="button" style={styles.cancelButton} onPress={() => setGameMenuOpen(false)}><Text>Close</Text></Pressable>
          </View>
        </View>
      </Modal>

      {/* This opaque pass screen covers the board as well as the hand while
          players exchange the device. The old hand was already cleared above. */}
      <Modal visible={pendingPlayer !== null} animationType="fade" onRequestClose={cancelPlayerChange}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>Pass the device</Text>
            <Text style={styles.dialogHint}>
              Make sure {activePlayer?.name ?? 'the current player'}'s cards are hidden before showing {pendingPlayer?.name ?? 'the next player'}'s hand.
            </Text>
            <View style={styles.choiceRow}>
              <Pressable accessibilityRole="button" style={styles.cancelButton} onPress={cancelPlayerChange}>
                <Text>Cancel</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={styles.choiceButton} onPress={confirmPlayerChange}>
                <Text style={styles.choiceText}>Show Hand</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={deckOrderOpen} transparent animationType="fade" onRequestClose={() => setDeckOrderOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <View style={styles.dialogHeader}>
              <Text accessibilityRole="header" style={styles.dialogTitle}>Shuffle or Sort</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close deck order options"
                style={styles.closeDialogButton}
                onPress={() => setDeckOrderOpen(false)}
              >
                <Text style={styles.closeDialogText}>×</Text>
              </Pressable>
            </View>
            {deckOrderLoading ? (
              <Text style={styles.dialogHint}>Loading deck…</Text>
            ) : selectedDeckOrderTarget ? (
              <View style={styles.deckOrderOption}>
                <View style={styles.deckOrderOptionCopy}>
                  <Text numberOfLines={1} style={styles.deckOrderName}>{selectedDeckOrderTarget.name}</Text>
                  <Text style={styles.deckOrderDetail}>
                    {selectedDeckOrderTarget.detail} · {selectedDeckOrderTarget.count} {selectedDeckOrderTarget.kind === 'card' ? 'cards' : 'tiles'}
                  </Text>
                </View>
              </View>
            ) : (
              <Text style={styles.deckOrderEmpty}>This deck could not be found.</Text>
            )}
            <View style={styles.choiceRow}>
              <Pressable
                accessibilityRole="button"
                disabled={!selectedDeckOrderTarget || selectedDeckOrderTarget.count < 2}
                style={[
                  styles.choiceButton,
                  (!selectedDeckOrderTarget || selectedDeckOrderTarget.count < 2) && styles.deckOrderButtonDisabled,
                ]}
                onPress={() => void applyDeckOrder('shuffle')}
              >
                <Text style={styles.choiceText}>Shuffle</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!selectedDeckOrderTarget || selectedDeckOrderTarget.count < 2}
                style={[
                  styles.choiceButton,
                  (!selectedDeckOrderTarget || selectedDeckOrderTarget.count < 2) && styles.deckOrderButtonDisabled,
                ]}
                onPress={() => void applyDeckOrder('sort')}
              >
                <Text style={styles.choiceText}>Sort</Text>
              </Pressable>
            </View>
            <Pressable accessibilityRole="button" style={styles.cancelButton} onPress={() => setDeckOrderOpen(false)}><Text>Close</Text></Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={saveDialogOpen} transparent animationType="fade" onRequestClose={() => setSaveDialogOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>{currentSaveId === null ? 'Save Gameplay State' : 'Update Saved Game'}</Text>
            <TextInput value={saveName} onChangeText={setSaveName} placeholder="Save name" accessibilityLabel="Save name" style={styles.nameInput} returnKeyType="done" onSubmitEditing={() => void saveCurrentGameplay()} />
            <View style={styles.choiceRow}>
              <Pressable accessibilityRole="button" style={styles.cancelButton} onPress={() => setSaveDialogOpen(false)}><Text>Cancel</Text></Pressable>
              <Pressable accessibilityRole="button" style={styles.choiceButton} onPress={() => void saveCurrentGameplay()}><Text style={styles.choiceText}>{currentSaveId === null ? 'Save Game' : 'Update Save'}</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={savedGamesOpen} transparent animationType="fade" onRequestClose={() => setSavedGamesOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>Saved Games</Text>
            <ScrollView style={styles.savedGamesList} contentContainerStyle={styles.savedGamesContent}>
              {savedGames.length === 0 ? (
                <Text style={styles.savedGamesEmpty}>No saved games.</Text>
              ) : savedGames.map((save) => (
                <View key={save.id} style={styles.savedGameRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Load ${save.name}, last saved ${new Date(save.updated_at).toLocaleString()}`}
                    style={styles.savedGameOption}
                    onPress={() => void loadSavedGameplay(save.id)}
                  >
                    <Text style={styles.savedGameName}>{save.name}</Text>
                    <Text style={styles.savedGameDate}>Last saved {new Date(save.updated_at).toLocaleString()}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${save.name}`}
                    style={styles.savedGameDeleteButton}
                    onPress={() => deleteSavedGame(save)}
                  >
                    <Text style={styles.savedGameDeleteText}>Delete</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            <Pressable accessibilityRole="button" style={styles.cancelButton} onPress={() => setSavedGamesOpen(false)}><Text>Close</Text></Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={dropCardId !== null && pendingDropSpotId !== null} transparent animationType="fade" onRequestClose={() => { setDropCardId(null); setPendingDropSpotId(null); }}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>Place card in pile</Text>
            <Text style={styles.dialogHint}>Choose where the card goes.</Text>
            <View style={styles.dropChoices}>
              {(['top', 'middle', 'bottom'] as const).map((position) => (
                <Pressable key={position} accessibilityRole="button" accessibilityLabel={`Place card at the ${position} of the pile`} style={styles.dropChoice} onPress={() => void discardCard(position)}>
                  <Text style={styles.choiceText}>{position[0].toUpperCase() + position.slice(1)}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable accessibilityRole="button" style={styles.cancelButton} onPress={() => { setDropCardId(null); setPendingDropSpotId(null); }}><Text>Cancel</Text></Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={addPlayerOpen} transparent animationType="fade" onRequestClose={() => setAddPlayerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>Add a player</Text>
            <TextInput value={playerName} onChangeText={setPlayerName} placeholder={`Player ${players.length + 1}`} accessibilityLabel="Player name" style={styles.nameInput} returnKeyType="done" onSubmitEditing={() => void addPlayer()} />
            <View style={styles.choiceRow}>
              <Pressable accessibilityRole="button" style={styles.cancelButton} onPress={() => setAddPlayerOpen(false)}><Text>Cancel</Text></Pressable>
              <Pressable accessibilityRole="button" style={styles.choiceButton} onPress={() => void addPlayer()}><Text style={styles.choiceText}>Add Player</Text></Pressable>
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
          // A face-down card's name is hidden information; don't announce it.
          accessibilityLabel={card.face_up === 1 ? `${card.name}, face up` : 'Face-down card'}
          accessibilityHint="Flips the card. Long-press and drag to play it onto a pile."
          onPress={() => onFlipCard(card)}
          style={[styles.cardMiniature, card.face_up === 0 && styles.faceDownMiniature]}
        >
          <CardFaceArtwork card={card} width={56} height={56 * card.height_inches / card.width_inches} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={card.face_up === 1 ? `Flip ${card.name} face down` : 'Flip card face up'} style={styles.flipButton} onPress={() => onFlipCard(card)}>
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
