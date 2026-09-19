import { invoke } from '@tauri-apps/api/core';

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
