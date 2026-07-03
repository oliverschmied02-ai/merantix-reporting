import { defineConfig } from 'vitest/config';

// Frontend tests run in jsdom (they touch document/window). Node's built-in
// test runner still owns the pure-logic suites in test/*.test.js.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/frontend/**/*.test.js'],
  },
});
