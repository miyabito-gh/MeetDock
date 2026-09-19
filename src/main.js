import { invoke } from '@tauri-apps/api/core';
// Keep PDF.js and its adapter in the production graph; Phase 7 supplies the passive Canvas view.
import './pdf-runtime.js';

document.querySelector('#app').innerHTML = `
  <h1>MeetDock</h1>
  <p>会議に必要な資料を、まとめて開く。</p>
  <button id="health-check" type="button">バックエンド接続確認</button>
  <output id="health-result" aria-live="polite"></output>
`;

document.querySelector('#health-check').addEventListener('click', async () => {
  const result = document.querySelector('#health-result');
  try {
    result.textContent = await invoke('health_check');
  } catch {
    result.textContent = 'Tauriバックエンド未接続（ブラウザ開発モード）';
  }
});
