import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';

export default [
  {
    ignores: [
      '.next/',
      'node_modules/',
      'coverage/',
      'dist/',
      'public/',
      'backend/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs}'],
    plugins: { react },
    settings: { react: { version: '18.3' } },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.builtin, ...globals.browser, ...globals.node },
    },
    rules: {
      // JSX içinde kullanılan import'ları "kullanılmıyor" sanmasın diye:
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
];
