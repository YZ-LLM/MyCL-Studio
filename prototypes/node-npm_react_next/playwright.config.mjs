import { defineConfig } from '@playwright/test';

// Faz 16 (E2E) bu config'i kullanır. Test dosyaları tests/e2e altına yazılır.
export default defineConfig({
  testDir: 'tests/e2e',
  use: {
    baseURL: 'http://localhost:3000',
  },
});
