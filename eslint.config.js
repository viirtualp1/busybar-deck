import { barEslintConfig } from 'busybar-kit/eslint';

/** The page runs in a browser, not in Node, and is plain ESM with no build. */
const browser = {
  files: ['ui/**/*.js'],
  languageOptions: {
    globals: Object.fromEntries(
      [
        'document',
        'window',
        'fetch',
        'Image',
        'confirm',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Event',
      ].map((name) => [name, 'readonly']),
    ),
    parserOptions: { project: null },
  },
  rules: {
    // Type-aware rules need a tsconfig that does not cover the browser files.
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
  },
};

export default barEslintConfig(import.meta.dirname, browser);
