import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, THEMES, currentTheme, applyTheme, storedTheme } from './theme.js';

test('system follows the OS while light and dark are fixed', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.deepEqual(THEMES, ['system', 'light', 'dark']);
});

test('the module works without a browser', () => {
  assert.equal(currentTheme(), 'light');
  applyTheme('nonsense');
  assert.equal(storedTheme(), 'system');
});
