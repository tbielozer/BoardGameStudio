import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
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
import { cardEditorStyles as styles } from './cardEditorStyles';

const DEFAULT_WIDTH_INCHES = 2.5;
const DEFAULT_HEIGHT_INCHES = 3.5;

type AvailableSymbol = {
  id: number;
  name: string;
};

type SavedCard = {
  id: number;
  project_id: string;
  surface_id: string;
  back_surface_id: string | null;
  name: string;
  width_inches: number;
  height_inches: number;
  preview_scale: number;
  created_at: number;
  updated_at: number;
};

type SavedDeck = {
  id: number;
  project_id: string;
  name: string;
  created_at: number;
  updated_at: number;
};

type SavedCardBack = {
  id: number;
  name: string;
  artwork_json: string;
  created_at: number;
  updated_at: number;
};

type CardBackSnapshot = {
  backgroundColor: string | null;
  backgroundImage: { base64Data: string; mimeType: string } | null;
  strokes: Array<{
    points_json: string;
    width: number;
    color: string;
    is_eraser: number;
    order_index: number;
    group_id: string | null;
  }>;
  images: Array<{
    base64_data: string;
    mime_type: string;
    center_x: number;
    center_y: number;
    width: number;
    height: number;
    order_index: number;
  }>;
};

type CardEditorProps = {
  topInset: number;
  bottomInset: number;
  projectId?: string;
  symbols: AvailableSymbol[];
  onClose: () => void;
};

// This editor provides a blank drawing surface with the same drawing tools as
// the board, plus card-specific dimensions and preview scale.
export function CardEditor({
  topInset,
  bottomInset,
  projectId,
  symbols,
  onClose,
}: CardEditorProps) {
  const db = useSQLiteContext();
  const cardCanvasRef = useRef<DrawingCanvasHandle | null>(null);
  // Quantity buttons can be tapped quickly. Queue their database writes so each
  // quantity update finishes before the next one begins.
  const deckQuantityWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [activeCardId, setActiveCardId] = useState<number | null>(null);
  const [activeFace, setActiveFace] = useState<'front' | 'back'>('front');
  const [widthText, setWidthText] = useState(String(DEFAULT_WIDTH_INCHES));
  const [heightText, setHeightText] = useState(String(DEFAULT_HEIGHT_INCHES));
  const [scale, setScale] = useState(1);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [cardsReady, setCardsReady] = useState(projectId === undefined);
  const [cardsOpen, setCardsOpen] = useState(false);
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  const [activeDeckId, setActiveDeckId] = useState<number | null>(null);
  const [deckQuantities, setDeckQuantities] = useState<Record<number, number>>({});
  const [decksOpen, setDecksOpen] = useState(false);
  const [renameDeckId, setRenameDeckId] = useState<number | null>(null);
  const [renameDeckName, setRenameDeckName] = useState('');
  const [dimensionsOpen, setDimensionsOpen] = useState(false);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [placementSymbol, setPlacementSymbol] = useState<AvailableSymbol | null>(null);
  const [isEditingSymbols, setIsEditingSymbols] = useState(false);
  const [renameCardId, setRenameCardId] = useState<number | null>(null);
  const [renameCardName, setRenameCardName] = useState('');
  const [cardBackTemplates, setCardBackTemplates] = useState<SavedCardBack[]>([]);
  const [cardBackLibraryOpen, setCardBackLibraryOpen] = useState(false);
  const [saveBackOpen, setSaveBackOpen] = useState(false);
  const [saveBackName, setSaveBackName] = useState('');
  const [renameBackId, setRenameBackId] = useState<number | null>(null);
  const [renameBackName, setRenameBackName] = useState('');
  const [canvasRevision, setCanvasRevision] = useState(0);
  const activeCard = cards.find((card) => card.id === activeCardId);
  const activeDeck = decks.find((deck) => deck.id === activeDeckId);

  const persistCardSettings = useCallback(async (
    cardId: number | null,
    widthValue: string,
    heightValue: string,
    scaleValue: number
  ) => {
    if (!projectId || cardId === null) return;

    const width = parseDimension(widthValue, DEFAULT_WIDTH_INCHES);
    const height = parseDimension(heightValue, DEFAULT_HEIGHT_INCHES);
    const updatedAt = Date.now();
    try {
      await db.runAsync(
        `UPDATE cards
        SET width_inches = ?, height_inches = ?, preview_scale = ?, updated_at = ?
        WHERE id = ?`,
        width,
        height,
        scaleValue,
        updatedAt,
        cardId
      );
      setCards((current) => current.map((card) =>
        card.id === cardId
          ? { ...card, width_inches: width, height_inches: height, preview_scale: scaleValue, updated_at: updatedAt }
          : card
      ));
    } catch (error) {
      console.error('Could not save card dimensions:', error);
    }
  }, [db, projectId]);

  useEffect(() => {
    if (!projectId) {
      setDecks([]);
      setActiveDeckId(null);
      return;
    }

    let cancelled = false;
    const loadProjectDecks = async () => {
      try {
        const savedDecks = await db.getAllAsync<SavedDeck>(
          `SELECT id, project_id, name, created_at, updated_at
          FROM card_decks
          WHERE project_id = ?
          ORDER BY updated_at DESC`,
          projectId
        );
        if (!cancelled) {
          setDecks(savedDecks);
          setActiveDeckId(savedDecks[0]?.id ?? null);
        }
      } catch (error) {
        console.error('Could not load card decks:', error);
      }
    };

    void loadProjectDecks();
    return () => {
      cancelled = true;
    };
  }, [db, projectId]);

  // Each deck stores only cards with a positive quantity. Missing rows mean
  // that the card is not included in that deck.
  useEffect(() => {
    if (!decksOpen || activeDeckId === null) {
      setDeckQuantities({});
      return;
    }

    let cancelled = false;
    const loadDeckItems = async () => {
      try {
        const rows = await db.getAllAsync<{ card_id: number; quantity: number }>(
          'SELECT card_id, quantity FROM card_deck_items WHERE deck_id = ?',
          activeDeckId
        );
        if (!cancelled) {
          setDeckQuantities(Object.fromEntries(
            rows.map((row) => [row.card_id, row.quantity])
          ));
        }
      } catch (error) {
        console.error('Could not load cards in deck:', error);
      }
    };

    void loadDeckItems();
    return () => {
      cancelled = true;
    };
  }, [activeDeckId, db, decksOpen]);

  // The back library is global, so the same saved design can be reused by any
  // card in any project.
  useEffect(() => {
    if (!cardBackLibraryOpen) return;
    let cancelled = false;
    const loadCardBackTemplates = async () => {
      try {
        const savedBacks = await db.getAllAsync<SavedCardBack>(
          `SELECT id, name, artwork_json, created_at, updated_at
          FROM saved_card_backs
          ORDER BY updated_at DESC`
        );
        if (!cancelled) setCardBackTemplates(savedBacks);
      } catch (error) {
        console.error('Could not load saved card backs:', error);
      }
    };
    void loadCardBackTemplates();
    return () => {
      cancelled = true;
    };
  }, [cardBackLibraryOpen, db]);

  // Load saved cards when entering a project. If this is an older project from
  // before cards existed, adopt its prototype card surface so no artwork is lost.
  useEffect(() => {
    if (!projectId) {
      setCards([]);
      setActiveCardId(null);
      setCardsReady(true);
      return;
    }

    let cancelled = false;
    setCardsReady(false);
    setCards([]);
    setActiveCardId(null);

    const loadProjectCards = async () => {
      try {
        let savedCards = await db.getAllAsync<SavedCard>(
          `SELECT id, project_id, surface_id, back_surface_id, name, width_inches,
            height_inches, preview_scale, created_at, updated_at
          FROM cards
          WHERE project_id = ?
          ORDER BY updated_at DESC`,
          projectId
        );

        if (savedCards.length === 0) {
          const oldSurface = await db.getFirstAsync<{ id: string }>(
            'SELECT id FROM drawing_surfaces WHERE id = ?',
            `${projectId}-card-editor`
          );
          const surfaceId = oldSurface?.id ??
            `${projectId}-card-${Date.now()}`;
          const now = Date.now();

          await db.withTransactionAsync(async () => {
            if (!oldSurface) {
              await db.runAsync(
                `INSERT INTO drawing_surfaces
                  (id, project_id, kind, name, background_color)
                VALUES (?, ?, ?, ?, ?)`,
                surfaceId,
                projectId,
                'card',
                'Card 1',
                '#FFFFFF'
              );
            }

            const backSurfaceId = `${surfaceId}-back`;
            await db.runAsync(
              `INSERT OR IGNORE INTO drawing_surfaces
                (id, project_id, kind, name, background_color)
              VALUES (?, ?, ?, ?, ?)`,
              backSurfaceId,
              projectId,
              'card',
              'Card 1 Back',
              '#FFFFFF'
            );

            await db.runAsync(
              `INSERT INTO cards
                (project_id, surface_id, back_surface_id, name, width_inches, height_inches,
                  preview_scale, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              projectId,
              surfaceId,
              backSurfaceId,
              'Card 1',
              DEFAULT_WIDTH_INCHES,
              DEFAULT_HEIGHT_INCHES,
              1,
              now,
              now
            );
          });

          savedCards = await db.getAllAsync<SavedCard>(
            `SELECT id, project_id, surface_id, back_surface_id, name, width_inches,
              height_inches, preview_scale, created_at, updated_at
            FROM cards
            WHERE project_id = ?
            ORDER BY updated_at DESC`,
            projectId
          );
        }

        if (!cancelled) {
          setCards(savedCards);
          const firstCard = savedCards[0];
          if (firstCard) {
            setActiveCardId(firstCard.id);
            setActiveFace('front');
            setWidthText(String(firstCard.width_inches));
            setHeightText(String(firstCard.height_inches));
            setScale(firstCard.preview_scale);
          }
          setCardsReady(true);
        }
      } catch (error) {
        console.error('Could not load saved cards:', error);
      }
    };

    void loadProjectCards();
    return () => {
      cancelled = true;
    };
  }, [db, projectId]);

  // Save size settings after the user pauses typing or moving the scale control.
  // Drawing and background changes save through the drawing surface.
  useEffect(() => {
    if (!projectId || activeCardId === null) return;

    const saveTimer = setTimeout(() => {
      void persistCardSettings(activeCardId, widthText, heightText, scale);
    }, 300);

    return () => clearTimeout(saveTimer);
  }, [activeCardId, heightText, persistCardSettings, projectId, scale, widthText]);

  // Keep the typed value flexible while editing, but use a safe positive number
  // for the preview so clearing a field never makes the card disappear.
  const cardWidth = parseDimension(widthText, DEFAULT_WIDTH_INCHES);
  const cardHeight = parseDimension(heightText, DEFAULT_HEIGHT_INCHES);
  const previewSize = useMemo(() => {
    // Use the measured canvas area so its full-width fit changes cleanly between
    // phone portrait, landscape, and tablet layouts.
    const maxWidth = Math.max(120, stageSize.width - 16);
    const maxHeight = Math.max(120, stageSize.height - 16);
    const previewUnitsPerInch = Math.min(
      maxWidth / cardWidth,
      maxHeight / cardHeight
    );

    return {
      width: cardWidth * previewUnitsPerInch * scale,
      height: cardHeight * previewUnitsPerInch * scale,
    };
  }, [cardHeight, cardWidth, scale, stageSize]);
  // Store card artwork in inch-like units instead of screen pixels. That way
  // changing preview scale enlarges the drawing and symbols together with the card.
  const previewCoordinateScale = previewSize.width / cardWidth;

  const createCard = useCallback(async () => {
    if (!projectId) return;

    await persistCardSettings(activeCardId, widthText, heightText, scale);
    const now = Date.now();
    const name = `Card ${cards.length + 1}`;
    const surfaceId = `${projectId}-card-${now}-${Math.random().toString(36).slice(2, 7)}`;

    try {
      let newCardId = 0;
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT INTO drawing_surfaces
            (id, project_id, kind, name, background_color)
          VALUES (?, ?, ?, ?, ?)`,
          surfaceId,
          projectId,
          'card',
          name,
          '#FFFFFF'
        );

        const backSurfaceId = `${surfaceId}-back`;
        await db.runAsync(
          `INSERT INTO drawing_surfaces
            (id, project_id, kind, name, background_color)
          VALUES (?, ?, ?, ?, ?)`,
          backSurfaceId,
          projectId,
          'card',
          `${name} Back`,
          '#FFFFFF'
        );

        const result = await db.runAsync(
          `INSERT INTO cards
            (project_id, surface_id, back_surface_id, name, width_inches, height_inches,
              preview_scale, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          projectId,
          surfaceId,
          backSurfaceId,
          name,
          DEFAULT_WIDTH_INCHES,
          DEFAULT_HEIGHT_INCHES,
          1,
          now,
          now
        );
        newCardId = result.lastInsertRowId;
      });

      const newCard: SavedCard = {
        id: newCardId,
        project_id: projectId,
        surface_id: surfaceId,
        back_surface_id: `${surfaceId}-back`,
        name,
        width_inches: DEFAULT_WIDTH_INCHES,
        height_inches: DEFAULT_HEIGHT_INCHES,
        preview_scale: 1,
        created_at: now,
        updated_at: now,
      };
      setCards((current) => [newCard, ...current]);
      setActiveCardId(newCard.id);
      setActiveFace('front');
      setWidthText(String(DEFAULT_WIDTH_INCHES));
      setHeightText(String(DEFAULT_HEIGHT_INCHES));
      setScale(1);
      setPlacementSymbol(null);
      setIsEditingSymbols(false);
      setCardsOpen(false);
    } catch (error) {
      console.error('Could not create card:', error);
    }
  }, [activeCardId, cards.length, db, heightText, persistCardSettings, projectId, scale, widthText]);

  const openSavedCard = async (card: SavedCard) => {
    await persistCardSettings(activeCardId, widthText, heightText, scale);
    setActiveCardId(card.id);
    setActiveFace('front');
    setWidthText(String(card.width_inches));
    setHeightText(String(card.height_inches));
    setScale(card.preview_scale);
    setPlacementSymbol(null);
    setIsEditingSymbols(false);
    setCardsOpen(false);
  };

  const saveCardName = async () => {
    const name = renameCardName.trim();
    if (!name || renameCardId === null) return;

    const updatedAt = Date.now();
    try {
      await db.runAsync(
        'UPDATE cards SET name = ?, updated_at = ? WHERE id = ?',
        name,
        updatedAt,
        renameCardId
      );
      setCards((current) => current.map((card) =>
        card.id === renameCardId
          ? { ...card, name, updated_at: updatedAt }
          : card
      ));
      setRenameCardId(null);
      setCardsOpen(true);
    } catch (error) {
      console.error('Could not rename card:', error);
    }
  };

  const createDeck = async () => {
    if (!projectId) return;

    const now = Date.now();
    const name = `Deck ${decks.length + 1}`;
    try {
      const result = await db.runAsync(
        `INSERT INTO card_decks (project_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)`,
        projectId,
        name,
        now,
        now
      );
      const newDeck: SavedDeck = {
        id: result.lastInsertRowId,
        project_id: projectId,
        name,
        created_at: now,
        updated_at: now,
      };
      setDecks((current) => [newDeck, ...current]);
      setActiveDeckId(newDeck.id);
      setDeckQuantities({});
    } catch (error) {
      console.error('Could not create card deck:', error);
    }
  };

  const updateDeckQuantity = async (cardId: number, quantity: number) => {
    if (activeDeckId === null) return;
    const deckId = activeDeckId;
    const nextQuantity = Math.max(0, Math.floor(quantity));
    const updatedAt = Date.now();

    setDeckQuantities((current) => ({
      ...current,
      [cardId]: nextQuantity,
    }));

    try {
      const write = deckQuantityWriteQueueRef.current.then(async () => {
        if (nextQuantity === 0) {
          await db.runAsync(
            'DELETE FROM card_deck_items WHERE deck_id = ? AND card_id = ?',
            deckId,
            cardId
          );
        } else {
          await db.runAsync(
            `INSERT INTO card_deck_items (deck_id, card_id, quantity)
            VALUES (?, ?, ?)
            ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
            deckId,
            cardId,
            nextQuantity
          );
        }
        await db.runAsync(
          'UPDATE card_decks SET updated_at = ? WHERE id = ?',
          updatedAt,
          deckId
        );
      });
      // Keep the queue usable if one write fails; this call still reports its error.
      deckQuantityWriteQueueRef.current = write.catch(() => undefined);
      await write;
      setDecks((current) => current.map((deck) =>
        deck.id === deckId ? { ...deck, updated_at: updatedAt } : deck
      ));
    } catch (error) {
      console.error('Could not update deck card quantity:', error);
    }
  };

  const saveDeckName = async () => {
    const name = renameDeckName.trim();
    if (!name || renameDeckId === null) return;

    const updatedAt = Date.now();
    try {
      await db.runAsync(
        'UPDATE card_decks SET name = ?, updated_at = ? WHERE id = ?',
        name,
        updatedAt,
        renameDeckId
      );
      setDecks((current) => current.map((deck) =>
        deck.id === renameDeckId
          ? { ...deck, name, updated_at: updatedAt }
          : deck
      ));
      setRenameDeckId(null);
      setDecksOpen(true);
    } catch (error) {
      console.error('Could not rename card deck:', error);
    }
  };

  const saveCurrentBackTemplate = async () => {
    const backSurfaceId = activeCard?.back_surface_id;
    const name = saveBackName.trim();
    if (!backSurfaceId || !name) return;

    try {
      const surface = await db.getFirstAsync<{
        background_color: string | null;
        background_image_data: string | null;
        background_image_mime_type: string | null;
      }>(
        `SELECT background_color, background_image_data, background_image_mime_type
        FROM drawing_surfaces WHERE id = ?`,
        backSurfaceId
      );
      const strokes = await db.getAllAsync<CardBackSnapshot['strokes'][number]>(
        `SELECT points_json, width, color, is_eraser, order_index, group_id
        FROM strokes WHERE surface_id = ? ORDER BY order_index ASC`,
        backSurfaceId
      );
      const images = await db.getAllAsync<CardBackSnapshot['images'][number]>(
        `SELECT base64_data, mime_type, center_x, center_y, width, height, order_index
        FROM surface_images WHERE surface_id = ? ORDER BY order_index ASC`,
        backSurfaceId
      );
      const snapshot: CardBackSnapshot = {
        backgroundColor: surface?.background_color ?? '#FFFFFF',
        backgroundImage: surface?.background_image_data && surface.background_image_mime_type
          ? {
              base64Data: surface.background_image_data,
              mimeType: surface.background_image_mime_type,
            }
          : null,
        strokes,
        images,
      };
      const now = Date.now();
      const result = await db.runAsync(
        `INSERT INTO saved_card_backs (name, artwork_json, created_at, updated_at)
        VALUES (?, ?, ?, ?)`,
        name,
        JSON.stringify(snapshot),
        now,
        now
      );
      setCardBackTemplates((current) => [{
        id: result.lastInsertRowId,
        name,
        artwork_json: JSON.stringify(snapshot),
        created_at: now,
        updated_at: now,
      }, ...current]);
      setSaveBackOpen(false);
      setSaveBackName('');
    } catch (error) {
      console.error('Could not save reusable card back:', error);
      Alert.alert('Could not save card back', 'Please try again.');
    }
  };

  const saveRenamedCardBack = async () => {
    const name = renameBackName.trim();
    if (!name || renameBackId === null) return;
    const updatedAt = Date.now();
    try {
      await db.runAsync(
        'UPDATE saved_card_backs SET name = ?, updated_at = ? WHERE id = ?',
        name,
        updatedAt,
        renameBackId
      );
      setCardBackTemplates((current) => current.map((template) =>
        template.id === renameBackId
          ? { ...template, name, updated_at: updatedAt }
          : template
      ));
      setRenameBackId(null);
      setCardBackLibraryOpen(true);
    } catch (error) {
      console.error('Could not rename saved card back:', error);
      Alert.alert('Could not rename saved back', 'Please try again.');
    }
  };

  const applySavedCardBack = async (template: SavedCardBack) => {
    const backSurfaceId = activeCard?.back_surface_id;
    if (!backSurfaceId) return;

    try {
      const snapshot = JSON.parse(template.artwork_json) as CardBackSnapshot;
      // Replace the contents on only this card's back. The front is untouched.
      await db.runAsync('DELETE FROM strokes WHERE surface_id = ?', backSurfaceId);
      await db.runAsync('DELETE FROM surface_images WHERE surface_id = ?', backSurfaceId);
      await db.runAsync(
        `UPDATE drawing_surfaces
        SET background_color = ?, background_image_data = ?, background_image_mime_type = ?
        WHERE id = ?`,
        snapshot.backgroundColor,
        snapshot.backgroundImage?.base64Data ?? null,
        snapshot.backgroundImage?.mimeType ?? null,
        backSurfaceId
      );

      for (const stroke of snapshot.strokes) {
        await db.runAsync(
          `INSERT INTO strokes
            (surface_id, points_json, width, color, is_eraser, order_index, group_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          backSurfaceId,
          stroke.points_json,
          stroke.width,
          stroke.color,
          stroke.is_eraser,
          stroke.order_index,
          stroke.group_id
        );
      }
      for (const image of snapshot.images) {
        await db.runAsync(
          `INSERT INTO surface_images
            (surface_id, base64_data, mime_type, center_x, center_y, width, height, order_index)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          backSurfaceId,
          image.base64_data,
          image.mime_type,
          image.center_x,
          image.center_y,
          image.width,
          image.height,
          image.order_index
        );
      }

      setCanvasRevision((revision) => revision + 1);
      setCardBackLibraryOpen(false);
    } catch (error) {
      console.error('Could not apply saved card back:', error);
      Alert.alert('Could not apply card back', 'Please try again.');
    }
  };

  const deleteSavedCardBack = (template: SavedCardBack) => {
    Alert.alert(
      'Delete saved back?',
      `Delete “${template.name}” from the reusable card back library?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void db.runAsync('DELETE FROM saved_card_backs WHERE id = ?', template.id)
              .then(() => setCardBackTemplates((current) =>
                current.filter((item) => item.id !== template.id)
              ))
              .catch((error) => {
                console.error('Could not delete saved card back:', error);
                Alert.alert('Could not delete saved back', 'Please try again.');
              });
          },
        },
      ]
    );
  };

  const deleteSavedCard = (card: SavedCard) => {
    Alert.alert(
      'Delete card?',
      `“${card.name}” and all artwork on its front and back will be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await db.withTransactionAsync(async () => {
                  await db.runAsync('DELETE FROM cards WHERE id = ?', card.id);
                  await db.runAsync(
                    'DELETE FROM drawing_surfaces WHERE id IN (?, ?)',
                    card.surface_id,
                    card.back_surface_id ?? `${card.surface_id}-back`
                  );
                });

                const remainingCards = cards.filter((item) => item.id !== card.id);
                setCards(remainingCards);
                setDeckQuantities((current) => {
                  const next = { ...current };
                  delete next[card.id];
                  return next;
                });
                if (activeCardId === card.id) {
                  const nextCard = remainingCards[0];
                  setActiveCardId(nextCard?.id ?? null);
                  setActiveFace('front');
                  if (nextCard) {
                    setWidthText(String(nextCard.width_inches));
                    setHeightText(String(nextCard.height_inches));
                    setScale(nextCard.preview_scale);
                  }
                }
              } catch (error) {
                console.error('Could not delete card:', error);
                Alert.alert('Could not delete card', 'Please try again.');
              }
            })();
          },
        },
      ]
    );
  };

  const deleteSavedDeck = (deck: SavedDeck) => {
    Alert.alert(
      'Delete deck?',
      `“${deck.name}” and its card quantities will be deleted. The saved cards will remain.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await db.runAsync('DELETE FROM card_decks WHERE id = ?', deck.id);
                const remainingDecks = decks.filter((item) => item.id !== deck.id);
                setDecks(remainingDecks);
                if (activeDeckId === deck.id) {
                  setActiveDeckId(remainingDecks[0]?.id ?? null);
                  setDeckQuantities({});
                }
              } catch (error) {
                console.error('Could not delete deck:', error);
                Alert.alert('Could not delete deck', 'Please try again.');
              }
            })();
          },
        },
      ]
    );
  };

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: topInset + 12, paddingBottom: bottomInset + 12 },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Card Editor</Text>
          <Text style={styles.subtitle}>
            {activeCard?.name
              ? `${activeCard.name} · ${activeFace === 'front' ? 'Front' : 'Back'}`
              : projectId ? 'Loading saved cards…' : 'Unsaved card'}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open card decks"
            style={styles.headerActionButton}
            onPress={() => setDecksOpen(true)}
          >
            <Text style={styles.headerActionText}>Decks</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open saved cards"
            style={styles.headerActionButton}
            onPress={() => setCardsOpen(true)}
          >
            <Text style={styles.headerActionText}>Cards</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close card editor"
            style={styles.closeButton}
            onPress={() => {
              void persistCardSettings(activeCardId, widthText, heightText, scale);
              onClose();
            }}
          >
            <Text style={styles.closeButtonText}>Done</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.editorActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a saved symbol to this card"
          style={styles.actionButton}
          onPress={() => setSymbolPickerOpen(true)}
        >
          <Text style={styles.actionButtonText}>Symbol</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={activeFace === 'back' ? 'Import an image to the card back' : 'Import an image to the card front'}
          style={styles.actionButton}
          onPress={() => cardCanvasRef.current?.importImage()}
        >
          <Text style={styles.actionButtonText}>{activeFace === 'back' ? 'Back Image' : 'Image'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Move placed symbols and images"
          style={[styles.actionButton, isEditingSymbols && styles.selectedActionButton]}
          onPress={() => {
            setPlacementSymbol(null);
            setIsEditingSymbols((editing) => !editing);
          }}
        >
          <Text style={styles.actionButtonText}>
            {isEditingSymbols ? 'Moving' : 'Move'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit card dimensions and scale"
          style={styles.actionButton}
          onPress={() => setDimensionsOpen(true)}
        >
          <Text style={styles.actionButtonText}>Size</Text>
        </Pressable>
      </View>

      <View style={styles.cardFaceTabs} accessibilityLabel="Card side">
        {(['front', 'back'] as const).map((face) => (
          <Pressable
            key={face}
            accessibilityRole="button"
            accessibilityState={{ selected: activeFace === face }}
            accessibilityLabel={`Edit card ${face}`}
            style={[styles.cardFaceTab, activeFace === face && styles.selectedCardFaceTab]}
            onPress={() => {
              setActiveFace(face);
              setPlacementSymbol(null);
              setIsEditingSymbols(false);
            }}
          >
            <Text style={[styles.cardFaceTabText, activeFace === face && styles.selectedCardFaceTabText]}>
              {face === 'front' ? 'Edit Front' : 'Edit Back'}
            </Text>
          </Pressable>
        ))}
      </View>

      {activeFace === 'back' && activeCard && (
        <View style={styles.backTemplateActions}>
          <Pressable
            accessibilityRole="button"
            style={styles.backTemplateButton}
            onPress={() => {
              setSaveBackName(`Card Back ${cardBackTemplates.length + 1}`);
              setSaveBackOpen(true);
            }}
          >
            <Text style={styles.backTemplateButtonText}>Save This Back</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.backTemplateButton}
            onPress={() => setCardBackLibraryOpen(true)}
          >
            <Text style={styles.backTemplateButtonText}>Saved Backs</Text>
          </Pressable>
        </View>
      )}

      <View
        style={styles.previewStage}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setStageSize((current) =>
            current.width === width && current.height === height
              ? current
              : { width, height }
          );
        }}
      >
        {(!projectId || (cardsReady && activeCard)) && stageSize.width > 0 && stageSize.height > 0 ? (
          <View
            key={`${activeFace === 'front'
              ? activeCard?.surface_id ?? 'unsaved-card-front'
              : activeCard?.back_surface_id ?? 'unsaved-card-back'}-${activeFace === 'back' ? canvasRevision : 0}`}
            accessibilityLabel={`Blank card preview, ${cardWidth} by ${cardHeight} inches`}
            style={[styles.card, previewSize]}
          >
            <DrawingCanvas
              ref={cardCanvasRef}
              bottomInset={0}
              surfaceId={activeFace === 'front' ? activeCard?.surface_id : activeCard?.back_surface_id ?? undefined}
              allowImageAsBackground
              defaultBackgroundColor="#FFFFFF"
              compactToolbar
              coordinateScale={previewCoordinateScale}
              placementSymbolId={placementSymbol?.id}
              placementSymbolName={placementSymbol?.name}
              placementSymbolScale={0.2 / previewCoordinateScale}
              onSymbolPlaced={() => setPlacementSymbol(null)}
              isEditingSymbols={isEditingSymbols}
              onStopEditingSymbols={() => setIsEditingSymbols(false)}
            />
          </View>
        ) : (
          <View style={styles.loadingCard}>
            {(!cardsReady || activeCard) && <ActivityIndicator color="#315EFB" />}
            <Text style={styles.loadingText}>
              {cardsReady && !activeCard
                ? 'No saved cards yet. Open Cards to create one.'
                : 'Loading saved card…'}
            </Text>
          </View>
        )}
      </View>

      <Modal
        visible={decksOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDecksOpen(false)}
      >
        <View style={styles.cardsBackdrop}>
          <View style={styles.decksDialog}>
            <View style={styles.cardsHeader}>
              <View>
                <Text style={styles.sectionTitle}>Card Decks</Text>
                <Text style={styles.helperText}>Choose a deck, then set each card count.</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close card decks"
                style={styles.closePickerButton}
                onPress={() => setDecksOpen(false)}
              >
                <Text style={styles.closePickerText}>×</Text>
              </Pressable>
            </View>

            {projectId && (
              <Pressable
                accessibilityRole="button"
                style={styles.newCardButton}
                onPress={() => void createDeck()}
              >
                <Text style={styles.newCardButtonText}>+ New Deck</Text>
              </Pressable>
            )}

            {decks.length > 0 ? (
              <ScrollView style={styles.deckList} keyboardShouldPersistTaps="handled">
                {decks.map((deck) => (
                  <View key={deck.id} style={styles.deckRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: deck.id === activeDeckId }}
                      style={[
                        styles.deckSelectButton,
                        deck.id === activeDeckId && styles.selectedDeckButton,
                      ]}
                      onPress={() => setActiveDeckId(deck.id)}
                    >
                      <Text style={styles.deckName}>{deck.name}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Rename ${deck.name}`}
                      style={styles.renameCardButton}
                      onPress={() => {
                        setDecksOpen(false);
                        setRenameDeckId(deck.id);
                        setRenameDeckName(deck.name);
                      }}
                    >
                      <Text style={styles.renameCardButtonText}>Rename</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${deck.name}`}
                      style={styles.deleteItemButton}
                      onPress={() => deleteSavedDeck(deck)}
                    >
                      <Text style={styles.deleteItemButtonText}>Delete</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.helperText}>
                Create a deck to choose which saved cards it contains.
              </Text>
            )}

            {activeDeck && (
              <>
                <View style={styles.deckContentsHeader}>
                  <Text style={styles.sectionTitle}>{activeDeck.name}</Text>
                  <Text style={styles.deckTotal}>
                    {Object.values(deckQuantities).reduce((sum, quantity) => sum + quantity, 0)} cards
                  </Text>
                </View>
                {cards.length === 0 ? (
                  <Text style={styles.helperText}>Create cards before adding them to a deck.</Text>
                ) : (
                  <ScrollView
                    style={styles.deckContents}
                    keyboardShouldPersistTaps="handled"
                  >
                    {cards.map((card) => {
                      const quantity = deckQuantities[card.id] ?? 0;
                      return (
                        <View key={card.id} style={styles.deckCardRow}>
                          <View style={styles.deckCardInfo}>
                            <Text style={styles.savedCardName}>{card.name}</Text>
                            <Text style={styles.savedCardDimensions}>
                              {formatDimension(card.width_inches)} × {formatDimension(card.height_inches)} in
                            </Text>
                          </View>
                          <View style={styles.quantityControls}>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Remove one ${card.name}`}
                              accessibilityState={{ disabled: quantity === 0 }}
                              disabled={quantity === 0}
                              style={[
                                styles.quantityButton,
                                quantity === 0 && styles.quantityButtonDisabled,
                              ]}
                              onPress={() => void updateDeckQuantity(card.id, quantity - 1)}
                            >
                              <Text style={styles.quantityButtonText}>−</Text>
                            </Pressable>
                            <Text style={styles.quantityValue}>{quantity}</Text>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Add one ${card.name}`}
                              style={styles.quantityButton}
                              onPress={() => void updateDeckQuantity(card.id, quantity + 1)}
                            >
                              <Text style={styles.quantityButtonText}>+</Text>
                            </Pressable>
                          </View>
                        </View>
                      );
                    })}
                  </ScrollView>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>

      <Modal
        visible={cardsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCardsOpen(false)}
      >
        <View style={styles.cardsBackdrop}>
          <View style={styles.cardsDialog}>
            <View style={styles.cardsHeader}>
              <View>
                <Text style={styles.sectionTitle}>Saved Cards</Text>
                <Text style={styles.helperText}>Your drawing changes save automatically.</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close saved cards"
                style={styles.closePickerButton}
                onPress={() => setCardsOpen(false)}
              >
                <Text style={styles.closePickerText}>×</Text>
              </Pressable>
            </View>

            {projectId && (
              <Pressable
                accessibilityRole="button"
                style={styles.newCardButton}
                onPress={() => void createCard()}
              >
                <Text style={styles.newCardButtonText}>+ New Card</Text>
              </Pressable>
            )}

            {cards.length === 0 ? (
              <Text style={styles.helperText}>
                Saved cards belong to a game project. Open Card Editor from a project to save cards.
              </Text>
            ) : (
              <ScrollView keyboardShouldPersistTaps="handled">
                {cards.map((card) => (
                  <View key={card.id} style={styles.savedCardRow}>
                    <Pressable
                      accessibilityRole="button"
                      style={styles.savedCardSelect}
                      onPress={() => void openSavedCard(card)}
                    >
                      <Text style={styles.savedCardName}>{card.name}</Text>
                      <Text style={styles.savedCardDimensions}>
                        {formatDimension(card.width_inches)} × {formatDimension(card.height_inches)} in
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Rename ${card.name}`}
                      style={styles.renameCardButton}
                      onPress={() => {
                        setCardsOpen(false);
                        setRenameCardId(card.id);
                        setRenameCardName(card.name);
                      }}
                    >
                      <Text style={styles.renameCardButtonText}>Rename</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${card.name}`}
                      style={styles.deleteItemButton}
                      onPress={() => deleteSavedCard(card)}
                    >
                      <Text style={styles.deleteItemButtonText}>Delete</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      <Modal
        visible={renameCardId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameCardId(null)}
      >
        <View style={styles.renameBackdrop}>
          <View style={styles.renameDialog}>
            <Text style={styles.sectionTitle}>Rename Card</Text>
            <TextInput
              accessibilityLabel="Card name"
              style={styles.dimensionInput}
              value={renameCardName}
              onChangeText={setRenameCardName}
              autoFocus
              selectTextOnFocus
              maxLength={60}
              placeholder="Card name"
              returnKeyType="done"
              onSubmitEditing={() => void saveCardName()}
            />
            <View style={styles.renameActions}>
              <Pressable
                style={styles.renameActionButton}
                onPress={() => {
                  setRenameCardId(null);
                  setCardsOpen(true);
                }}
              >
                <Text style={styles.renameActionText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.renameActionButton, styles.saveRenameButton]}
                onPress={() => void saveCardName()}
              >
                <Text style={styles.saveRenameText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={renameDeckId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameDeckId(null)}
      >
        <View style={styles.renameBackdrop}>
          <View style={styles.renameDialog}>
            <Text style={styles.sectionTitle}>Rename Deck</Text>
            <TextInput
              accessibilityLabel="Deck name"
              style={styles.dimensionInput}
              value={renameDeckName}
              onChangeText={setRenameDeckName}
              autoFocus
              selectTextOnFocus
              maxLength={60}
              placeholder="Deck name"
              returnKeyType="done"
              onSubmitEditing={() => void saveDeckName()}
            />
            <View style={styles.renameActions}>
              <Pressable
                style={styles.renameActionButton}
                onPress={() => {
                  setRenameDeckId(null);
                  setDecksOpen(true);
                }}
              >
                <Text style={styles.renameActionText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.renameActionButton, styles.saveRenameButton]}
                onPress={() => void saveDeckName()}
              >
                <Text style={styles.saveRenameText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={dimensionsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDimensionsOpen(false)}
      >
        <View style={styles.dimensionsBackdrop}>
          <View style={styles.dimensionsDialog}>
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>Card Dimensions</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close card dimensions"
                style={styles.closePickerButton}
                onPress={() => setDimensionsOpen(false)}
              >
                <Text style={styles.closePickerText}>×</Text>
              </Pressable>
            </View>

            <Text style={styles.dimensionSummary}>
              {formatDimension(cardWidth)} × {formatDimension(cardHeight)} in
            </Text>
            <View style={styles.dimensionRow}>
              <DimensionInput
                label="Width (in)"
                value={widthText}
                onChangeText={setWidthText}
              />
              <DimensionInput
                label="Height (in)"
                value={heightText}
                onChangeText={setHeightText}
              />
            </View>

            <View style={styles.scaleHeader}>
              <Text style={styles.sectionTitle}>Preview scale</Text>
              <Text style={styles.scaleValue}>{Math.round(scale * 100)}%</Text>
            </View>
            <Slider
              accessibilityLabel="Card preview scale"
              style={styles.scaleSlider}
              minimumValue={0.5}
              maximumValue={1}
              step={0.05}
              value={scale}
              onValueChange={setScale}
              minimumTrackTintColor="#315EFB"
              maximumTrackTintColor="#CBD5E1"
              thumbTintColor="#1F2937"
            />
            <Text style={styles.helperText}>
              100% fills the available workspace. Lower the scale to see more
              space around the card.
            </Text>
          </View>
        </View>
      </Modal>

      <Modal
        visible={saveBackOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSaveBackOpen(false)}
      >
        <View style={styles.renameBackdrop}>
          <View style={styles.renameDialog}>
            <Text style={styles.sectionTitle}>Save Reusable Card Back</Text>
            <Text style={styles.helperText}>
              This saves the current background, drawings, and images for other cards.
            </Text>
            <TextInput
              accessibilityLabel="Saved card back name"
              style={styles.dimensionInput}
              value={saveBackName}
              onChangeText={setSaveBackName}
              autoFocus
              selectTextOnFocus
              maxLength={60}
              placeholder="Card back name"
              returnKeyType="done"
              onSubmitEditing={() => void saveCurrentBackTemplate()}
            />
            <View style={styles.renameActions}>
              <Pressable
                style={styles.renameActionButton}
                onPress={() => setSaveBackOpen(false)}
              >
                <Text style={styles.renameActionText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.renameActionButton, styles.saveRenameButton]}
                onPress={() => void saveCurrentBackTemplate()}
              >
                <Text style={styles.saveRenameText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={renameBackId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setRenameBackId(null);
          setCardBackLibraryOpen(true);
        }}
      >
        <View style={styles.renameBackdrop}>
          <View style={styles.renameDialog}>
            <Text style={styles.sectionTitle}>Rename Saved Back</Text>
            <TextInput
              accessibilityLabel="Saved back name"
              style={styles.dimensionInput}
              value={renameBackName}
              onChangeText={setRenameBackName}
              autoFocus
              selectTextOnFocus
              maxLength={60}
              placeholder="Card back name"
              returnKeyType="done"
              onSubmitEditing={() => void saveRenamedCardBack()}
            />
            <View style={styles.renameActions}>
              <Pressable
                style={styles.renameActionButton}
                onPress={() => {
                  setRenameBackId(null);
                  setCardBackLibraryOpen(true);
                }}
              >
                <Text style={styles.renameActionText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.renameActionButton, styles.saveRenameButton]}
                onPress={() => void saveRenamedCardBack()}
              >
                <Text style={styles.saveRenameText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={cardBackLibraryOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCardBackLibraryOpen(false)}
      >
        <View style={styles.cardsBackdrop}>
          <View style={styles.cardsDialog}>
            <View style={styles.cardsHeader}>
              <View>
                <Text style={styles.sectionTitle}>Saved Card Backs</Text>
                <Text style={styles.helperText}>Choose a saved design for this card.</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close saved card backs"
                style={styles.closePickerButton}
                onPress={() => setCardBackLibraryOpen(false)}
              >
                <Text style={styles.closePickerText}>×</Text>
              </Pressable>
            </View>
            {cardBackTemplates.length === 0 ? (
              <Text style={styles.helperText}>
                No saved backs yet. Edit a card back, then choose Save This Back.
              </Text>
            ) : (
              <ScrollView keyboardShouldPersistTaps="handled">
                {cardBackTemplates.map((template) => (
                  <View key={template.id} style={styles.savedCardRow}>
                    <View style={styles.savedCardSelect}>
                      <Text style={styles.savedCardName}>{template.name}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${template.name} on this card`}
                      style={styles.renameCardButton}
                      onPress={() => void applySavedCardBack(template)}
                    >
                      <Text style={styles.renameCardButtonText}>Use</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Rename saved back ${template.name}`}
                      style={styles.renameCardButton}
                      onPress={() => {
                        setCardBackLibraryOpen(false);
                        setRenameBackName(template.name);
                        setRenameBackId(template.id);
                      }}
                    >
                      <Text style={styles.renameCardButtonText}>Rename</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Delete saved back ${template.name}`}
                      style={styles.deleteItemButton}
                      onPress={() => deleteSavedCardBack(template)}
                    >
                      <Text style={styles.deleteItemButtonText}>Delete</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      <Modal
        visible={symbolPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSymbolPickerOpen(false)}
      >
        <View style={styles.symbolPickerBackdrop}>
          <View style={styles.symbolPickerDialog}>
            <View style={styles.symbolPickerHeader}>
              <Text style={styles.sectionTitle}>Add a Symbol</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close symbol picker"
                style={styles.closePickerButton}
                onPress={() => setSymbolPickerOpen(false)}
              >
                <Text style={styles.closePickerText}>×</Text>
              </Pressable>
            </View>
            {symbols.length === 0 ? (
              <Text style={styles.helperText}>
                You don’t have any saved symbols yet. Create one in the Symbol Editor first.
              </Text>
            ) : (
              <ScrollView keyboardShouldPersistTaps="handled">
                {symbols.map((symbol) => (
                  <Pressable
                    key={symbol.id}
                    style={styles.symbolOption}
                    onPress={() => {
                      setPlacementSymbol(symbol);
                      setIsEditingSymbols(false);
                      setSymbolPickerOpen(false);
                    }}
                  >
                    <Text style={styles.symbolOptionText}>{symbol.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DimensionInput({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.dimensionField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={styles.dimensionInput}
        value={value}
        onChangeText={(nextValue) => {
          // Accept only decimal digits so these fields stay useful on mobile
          // decimal keyboards and do not accidentally accept unit text.
          onChangeText(nextValue.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'));
        }}
        keyboardType="decimal-pad"
        selectTextOnFocus
        placeholder="2.5"
      />
    </View>
  );
}

function parseDimension(value: string, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(0.1, parsed);
}

function formatDimension(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
