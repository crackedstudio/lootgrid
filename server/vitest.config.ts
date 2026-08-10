import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Set before any module loads, because env.ts validates at import time.
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      DATABASE_PATH: ':memory:',
      LOG_LEVEL: 'silent',
      METRICS_ENABLED: 'false',
    },
    include: ['src/**/*.test.ts'],
    // The store, referee timers and prepared-statement caches are module-level
    // singletons; parallel files in one process would share them.
    fileParallelism: false,
    restoreMocks: true,
  },
});
