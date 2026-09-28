export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  mongo: {
    uri: string;
    dbName: string;
  };
  ingest: {
    maxFutureSkewMs: number;
  };
  queue: {
    concurrency: number;
    leaseMs: number;
    idlePollMs: number;
    blockedRetryDelayMs: number;
  };
  processing: {
    simulatedCallMs: number;
    callTimeoutMs: number;
  };
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Builds the config from environment variables (listed in `.env.example`).
 * All invalid values are reported together in one error at startup.
 * It takes `env` as an argument so tests can pass their own values.
 */
export function loadConfig(env: Env): AppConfig {
  const errors: string[] = [];

  const str = (name: string, fallback: string): string => env[name]?.trim() || fallback;

  const int = (name: string, fallback: number, min: number, max?: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < min || (max !== undefined && value > max)) {
      const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
      errors.push(`${name} must be an integer ${range}, got "${raw}"`);
      return fallback;
    }
    return value;
  };

  const config: AppConfig = {
    port: int('PORT', 3000, 1, 65535),
    mongo: {
      uri: str('MONGO_URI', 'mongodb://localhost:27017'),
      dbName: str('MONGO_DB_NAME', 'adentris'),
    },
    ingest: {
      maxFutureSkewMs: int('INGEST_MAX_FUTURE_SKEW_MS', 300_000, 0),
    },
    queue: {
      concurrency: int('QUEUE_CONCURRENCY', 25, 1),
      leaseMs: int('QUEUE_LEASE_MS', 15_000, 1),
      idlePollMs: int('QUEUE_IDLE_POLL_MS', 500, 1),
      blockedRetryDelayMs: int('QUEUE_BLOCKED_RETRY_DELAY_MS', 250, 1),
    },
    processing: {
      simulatedCallMs: int('PROCESSING_SIMULATED_CALL_MS', 5_000, 0),
      callTimeoutMs: int('PROCESSING_CALL_TIMEOUT_MS', 10_000, 1),
    },
  };

  // The call has to time out while the worker still holds the claim.
  // Otherwise another worker takes the event over before the timeout can fire.
  if (config.processing.callTimeoutMs >= config.queue.leaseMs) {
    errors.push('PROCESSING_CALL_TIMEOUT_MS must be less than QUEUE_LEASE_MS');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
