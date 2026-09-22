import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['src/test-setup.ts'],
    // Local adaptation: this install runs on a 4-core Raspberry Pi. The
    // default 5s timeout is fine per-file, but under the full suite's thread
    // pool contention, subprocess-spawning tests (scripts/q.test.ts,
    // setup/channels/mattermost-config.test.ts) occasionally miss it despite
    // completing in well under a second when run in isolation. Not a
    // correctness issue — just slow hardware under concurrent load.
    testTimeout: 20000,
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
  },
});
