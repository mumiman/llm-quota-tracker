const statusEl = document.getElementById('status');

function showStatus(msg, isError = false) {
  statusEl.style.display = 'block';
  statusEl.style.color = isError ? '#ef4444' : '#10b981';
  statusEl.textContent = msg;
}

async function renderSyncHistory() {
  const { lastSyncMap } = await chrome.storage.local.get(['lastSyncMap']);
  const map = lastSyncMap || {};
  for (const id of ['claude', 'codex', 'antigravity', 'kimi']) {
    const el = document.getElementById(`st_${id}`);
    if (!el || !map[id]) continue;
    const item = map[id];
    const timeStr = new Date(item.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.style.color = item.ok ? '#10b981' : '#f59e0b';
    el.textContent = item.ok ? `✓ ${timeStr}` : `⚠ ${timeStr}`;
    el.title = item.message;
  }
}

document.getElementById('openDashboardBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://localhost:3456' });
});

document.getElementById('openClaudeBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://claude.ai/settings/usage' });
});

document.getElementById('openCodexBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chatgpt.com/codex/settings/usage' });
});

document.getElementById('openKimiBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.kimi.com/' });
});

document.getElementById('syncAllBtn').addEventListener('click', async () => {
  chrome.runtime.sendMessage({ type: 'POLL_ALL_TABS_NOW' }, () => {
    showStatus('✓ Triggered real-time scan across all open tabs!');
    setTimeout(renderSyncHistory, 1000);
  });
});

renderSyncHistory();
setInterval(renderSyncHistory, 2000);
