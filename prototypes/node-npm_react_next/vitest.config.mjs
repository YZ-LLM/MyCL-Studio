import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// node:sqlite is a Node 22 builtin newer than Vite's known-externals list, so Vite would
// otherwise try to bundle it and strip the `node:` prefix. Modules load it via createRequire
// (see lib/db/sqlite.js); externalizing here keeps Vite from touching it during transform.
export default defineConfig({
  resolve: {
    alias: [
      // `server-only` / `client-only` are RSC-boundary markers that throw outside
      // Next.js; in the Node test runtime they resolve to a harmless no-op.
      { find: /^server-only$/, replacement: `${root}/tests/stubs/empty-module.js` },
      { find: /^client-only$/, replacement: `${root}/tests/stubs/empty-module.js` },
      { find: /^@\//, replacement: `${root}/` },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs,jsx}'],
    server: { deps: { external: [/node:sqlite/] } },
  },
});
