const statusEl = document.getElementById('status');

function showStatus(msg, isError = false) {
  statusEl.style.display = 'block';
  statusEl.style.color = isError ? '#ef4444' : '#10b981';
  statusEl.textContent = msg;
}

document.getElementById('openClaudeBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://claude.ai/settings/usage' });
});

document.getElementById('openCodexBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chatgpt.com/codex/settings/usage' });
});

document.getElementById('syncTabBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return showStatus('No active tab found', true);

  let providerId = null;
  if (tab.url.includes('claude.ai')) providerId = 'claude';
  else if (tab.url.includes('chatgpt.com') || tab.url.includes('openai.com')) providerId = 'codex';
  else return showStatus('Open claude.ai/settings/usage or chatgpt.com/codex/settings/usage first.', true);

  try {
    const [{ result: rawText }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body ? document.body.innerText : ''
    });

    chrome.runtime.sendMessage({ type: 'SYNC_USAGE', providerId, rawText }, (resp) => {
      if (!resp || !resp.ok) {
        return showStatus(resp?.error || resp?.data?.error || 'Sync failed. Is "node server.js" running on port 3456?', true);
      }
      showStatus(`✓ Synced ${providerId.toUpperCase()}! Refresh localhost:3456 to view.`);
    });
  } catch (err) {
    showStatus(`Script error: ${err.message}`, true);
  }
});
