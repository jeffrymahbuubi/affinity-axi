import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // Spies on process streams are restored before every test.
    restoreMocks: true,
    // The dashboard is its own package with node:test suites (npm --prefix dashboard test).
    exclude: [...configDefaults.exclude, "dashboard/**"],
    // Only `npm run coverage` (vitest run --coverage) measures and enforces thresholds.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The entry point is exercised as a subprocess by cli.test.ts, so it is never instrumented.
      exclude: ["src/index.ts"],
      reportOnFailure: true,
      reporter: ["text", "json-summary"],
      thresholds: { lines: 95, branches: 85 },
    },
  },
});
