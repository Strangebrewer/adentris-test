// Two projects: `unit` tests need nothing running,
// `integration` tests need the docker-compose Mongo, and check for it before running.
// Each Jest worker gets its own test database (see test/support/test-db.ts).
const shared = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    // ts-jest warns (TS151002) that `nodenext` modules need `isolatedModules`.
    // The tests compile and run correctly without it, and turning it on would force
    // `import type` for every interface used in an injected constructor.
    '^.+\\.ts$': ['ts-jest', { diagnostics: { ignoreCodes: [151002] } }],
  },
  testEnvironment: 'node',
  rootDir: '.',
};

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      ...shared,
      displayName: 'unit',
      roots: ['<rootDir>/src'],
      testMatch: ['**/*.spec.ts'],
    },
    {
      ...shared,
      displayName: 'integration',
      roots: ['<rootDir>/test'],
      testMatch: ['**/*.integration.spec.ts'],
      globalSetup: '<rootDir>/test/support/require-mongo.ts',
    },
  ],
};
