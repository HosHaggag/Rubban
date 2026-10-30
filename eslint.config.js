'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'build/**', 'release/**', 'dist/**', 'data/**', 'ui/vendor.js', 'ui/xterm.js', 'ui/addon-fit.js'] },
  js.configs.recommended,
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }], 'no-control-regex': 'off', 'no-useless-escape': 'off', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }] } },
  { files: ['eslint.config.js'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  { files: ['ui/**/*.js', 'ui/**/*.mjs'], languageOptions: { sourceType: 'module', globals: globals.browser } },
  { files: ['ui/desktop-bridge.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
  { files: ['ui/**/*.test.mjs'], languageOptions: { globals: globals.node } },
];
