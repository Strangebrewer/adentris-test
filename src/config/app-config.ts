export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  mongo: {
    uri: string;
    dbName: string;
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
  };

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
