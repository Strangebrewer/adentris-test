import { Db } from 'mongodb';
import { AppConfig, loadConfig } from '../../src/config/app-config';

/**
 * Config for integration tests. Each Jest worker gets its own database,
 * so test files running in parallel don't share data.
 * It ignores your local `.env`, so tests always run with the same settings.
 * Only `MONGO_URI` is passed through.
 */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    MONGO_URI: process.env.MONGO_URI,
    MONGO_DB_NAME: `adentris_test_${process.env.JEST_WORKER_ID ?? '0'}`,
    ...overrides,
  });
}

/**
 * Empties every collection but keeps the indexes. Use it in `beforeEach`.
 * Also drop the whole database once in `beforeAll`,
 * so indexes left over from an older run are removed.
 */
export async function clearCollections(db: Db): Promise<void> {
  const collections = await db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}
