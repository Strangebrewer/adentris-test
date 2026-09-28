import { MongoClient } from 'mongodb';
import { testConfig } from './test-db';

/**
 * Runs once before the integration tests. Without it, a missing Mongo shows up as
 * every test failing with a hook timeout, which doesn't say what's actually wrong.
 */
export default async function requireMongo(): Promise<void> {
  const { uri } = testConfig().mongo;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Mongo isn't reachable at ${uri}. Start it with \`docker compose up -d\`.`, {
      cause: err,
    });
  } finally {
    await client.close();
  }
}
