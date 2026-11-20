import { Platform } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';

// SQLite's exclusive transaction uses a separate connection on native Expo,
// which avoids unrelated queries joining the same transaction. Expo SQLite
// does not support that API on web, so web keeps the regular transaction path.
type SQLiteTransactionConnection = Pick<SQLiteDatabase, 'getAllAsync' | 'getFirstAsync' | 'runAsync'>;

export function withSafeWriteTransaction(
  db: SQLiteDatabase,
  action: (transaction: SQLiteTransactionConnection) => Promise<void>
) {
  if (Platform.OS === 'web') {
    return db.withTransactionAsync(() => action(db));
  }

  return db.withExclusiveTransactionAsync((transaction) => action(transaction));
}
