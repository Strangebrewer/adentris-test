// Integration tests need the docker-compose Mongo.
// Each Jest worker gets its own test database (see test/support/test-db.ts).
/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'integration',
      moduleFileExtensions: ['js', 'json', 'ts'],
      transform: { '^.+\\.ts$': 'ts-jest' },
      testEnvironment: 'node',
      rootDir: '.',
      roots: ['<rootDir>/test'],
      testMatch: ['**/*.integration.spec.ts'],
    },
  ],
};
