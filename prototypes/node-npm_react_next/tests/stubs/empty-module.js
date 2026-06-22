// Test stub for `server-only` / `client-only` marker packages. Under Next.js these
// guard against importing a module from the wrong environment; in the vitest Node
// runtime there is no RSC boundary, so they resolve to this no-op.
export {};
