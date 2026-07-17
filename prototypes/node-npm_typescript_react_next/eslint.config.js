import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Flat config (yeni standart). TS/TSX'i typescript-eslint parser ile çözer.
export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      ".next/",
      "dist/",
      "coverage/",
      "next-env.d.ts",
      "tests/integration/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // TS zaten tanımsız referansları yakalar — no-undef'i kapat (tseslint önerisi).
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
