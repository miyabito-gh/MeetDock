import test from 'node:test';
import assert from 'node:assert/strict';
import { getTheme, setTheme, applyTheme, isTheme, THEME_KEY } from '../src/theme.js';

const memory = (init = {}) => { const d = { ...init }; return { getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = v; }, d }; };
const fakeRoot = () => { const a = {}; return { a, setAttribute: (k, v) => { a[k] = v; }, removeAttribute: k => { delete a[k]; } }; };

test('theme values are validated', () => {
  assert.ok(isTheme('system') && isTheme('light') && isTheme('dark'));
  assert.ok(!isTheme('blue') && !isTheme(undefined));
  assert.equal(getTheme(memory({ [THEME_KEY]: 'dark' })), 'dark');
  assert.equal(getTheme(memory({ [THEME_KEY]: 'bogus' })), 'system');
  assert.equal(getTheme(memory()), 'system');
});

test('storage failures fall back to system without throwing', () => {
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.equal(getTheme(broken), 'system');
  const root = fakeRoot();
  assert.equal(setTheme('dark', broken, root), 'dark');
  assert.equal(root.a['data-theme'], 'dark');
});

test('apply sets or removes data-theme and set persists', () => {
  const root = fakeRoot(), store = memory();
  applyTheme('light', root);
  assert.equal(root.a['data-theme'], 'light');
  applyTheme('system', root);
  assert.ok(!('data-theme' in root.a));
  applyTheme('nope', root);
  assert.ok(!('data-theme' in root.a));
  setTheme('dark', store, root);
  assert.equal(store.d[THEME_KEY], 'dark');
  assert.equal(root.a['data-theme'], 'dark');
});
