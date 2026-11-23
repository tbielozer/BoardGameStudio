import { Platform } from 'react-native';
import { openDatabaseAsync, type SQLiteBindValue, type SQLiteDatabase } from 'expo-sqlite';

// On native Expo, an exclusive transaction runs on its own connection so
// unrelated queries from the board (piece loads, queued saves) cannot join it
// and be committed or rolled back with it. Expo SQLite does not support a
// second connection on web, so web keeps the regular transaction path.
export type SQLiteTransactionConnection = Pick<SQLiteDatabase, 'getAllAsync' | 'getFirstAsync' | 'runAsync'>;

// Each runAsync call crosses the native bridge. Seeding a 100-card deck one
// row at a time costs 100 round trips; batching rows into one multi-row
// INSERT keeps it to one or two. 100 rows keeps the bound-parameter count far
// below SQLite's limit for any table used here.
const ROWS_PER_INSERT = 100;

export async function insertRows(
  connection: SQLiteTransactionConnection,
  /** Everything before VALUES, e.g. `INSERT INTO t (a, b)`. */
  insertPrefix: string,
  rows: SQLiteBindValue[][]
) {
  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
    const chunk = rows.slice(start, start + ROWS_PER_INSERT);
    const placeholders = chunk.map((row) => `(${row.map(() => '?').join(', ')})`).join(', ');
    await connection.runAsync(`${insertPrefix} VALUES ${placeholders}`, chunk.flat());
  }
}

export async function withSafeWriteTransaction(
  db: SQLiteDatabase,
  action: (transaction: SQLiteTransactionConnection) => Promise<void>
) {
  if (Platform.OS === 'web') {
    return db.withTransactionAsync(() => action(db));
  }

  // Open the connection ourselves rather than using withExclusiveTransactionAsync:
  // PRAGMAs are per-connection and cannot be changed after BEGIN, so the
  // built-in helper's connection never gets foreign keys turned on. Without
  // them, ON DELETE CASCADE and reference checks silently stop working for
  // every write made in this transaction.
  const slash = db.databasePath.lastIndexOf('/');
  const connection = await openDatabaseAsync(
    db.databasePath.slice(slash + 1),
    { ...db.options, useNewConnection: true },
    db.databasePath.slice(0, slash)
  );
  try {
    await connection.execAsync('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    // IMMEDIATE takes the write lock up front, so a competing writer waits
    // (busy_timeout) instead of failing halfway through the transaction.
    await connection.execAsync('BEGIN IMMEDIATE');
    try {
      await action(connection);
      await connection.execAsync('COMMIT');
    } catch (error) {
      try {
        await connection.execAsync('ROLLBACK');
      } catch {
        // SQLite may already have rolled back; keep the original error.
      }
      throw error;
    }
  } finally {
    await connection.closeAsync();
  }
}
