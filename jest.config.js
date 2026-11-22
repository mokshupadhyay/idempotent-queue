module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Helpers under __tests__/support are not test files.
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  modulePathIgnorePatterns: ['<rootDir>/lib/', '<rootDir>/.run/', '<rootDir>/example/'],
  // Source imports use `.js` specifiers so the ESM build runs in Node; Jest reads the `.ts` files.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // Property tests run many simulated scenarios; no test waits on real time.
  testTimeout: 120000,
};
