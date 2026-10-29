// UI-only personal preference. Not part of config/IPC/Model.
export const THEME_KEY = 'meetdock.theme';
export const THEMES = Object.freeze(['system', 'light', 'dark']);

export const isTheme = value => THEMES.includes(value);

export function getTheme(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(THEME_KEY);
    return isTheme(value) ? value : 'system';
  } catch { return 'system'; }
}

export function applyTheme(theme, root = globalThis.document?.documentElement) {
  const value = isTheme(theme) ? theme : 'system';
  if (!root) return value;
  if (value === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', value);
  return value;
}

export function setTheme(theme, storage = globalThis.localStorage, root = globalThis.document?.documentElement) {
  const value = applyTheme(theme, root);
  try { storage?.setItem(THEME_KEY, value); } catch { /* keep applied value for this session */ }
  return value;
}
