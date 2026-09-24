import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/contracts.js';
import { Event, initialState, transition } from '../src/model.js';

const legacyConfig = {
  schema_version: 3, app_version: '0.1.0', revision: 1,
  last_updated: '2026-09-25T00:00:00Z',
  groups: [{ id: 'g1', parent_id: null, name: '会議', order: 1 }],
  materials: [{ id: 'm1', group_id: 'g1', name: '資料', role: 'main', target_type: 'folder', path: 'C:\\Docs', window_match_pattern: null, order: 1 }],
};

function ready(config = legacyConfig) {
  return transition(initialState(), { type: Event.SettingsLoaded, config }).state;
}

test('schema 3 Explorer settings default without invalidating legacy documents', () => {
  const config = validate('AppConfig', legacyConfig);
  assert.equal(config.explorer_open_mode, 'new_window');
  assert.equal(config.groups[0].explorer_open_mode, 'inherit');
});

test('group Explorer override wins and batch/individual/reveal carry the resolved mode', () => {
  const config = validate('AppConfig', legacyConfig);
  config.explorer_open_mode = 'new_window';
  config.groups[0].explorer_open_mode = 'existing_tab';
  const state = ready(config);
  assert.equal(transition(state, { type: Event.ActivateRequested, material_id: 'm1' }).effects[0].request.explorer_open_mode, 'existing_tab');
  assert.equal(transition(state, { type: Event.OpenContainingFolderRequested, material_id: 'm1' }).effects[0].request.explorer_open_mode, 'existing_tab');
  assert.equal(transition(state, { type: Event.BatchLaunchRequested, group_id: 'g1' }).effects[0].request.explorer_open_mode, 'existing_tab');
});

test('inherit uses the persisted global Explorer mode', () => {
  const config = validate('AppConfig', legacyConfig);
  config.explorer_open_mode = 'existing_tab';
  const effect = transition(ready(config), { type: Event.ActivateRequested, material_id: 'm1' }).effects[0];
  assert.equal(effect.request.explorer_open_mode, 'existing_tab');
});
