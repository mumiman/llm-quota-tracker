/**
 * Zero-Click Real-Time Content Script for LLM Quota Tracker (v3.0)
 * - Bridges `localhost:3456` "Sync Now" button to the Extension Background Worker
 * - Observes DOM mutations (such as opening the Antigravity Usage Popover) and triggers immediate isolated extraction
 */
(function () {
  const host = window.location.hostname || '';
  const port = window.location.port || '';
  let debounceTimer = null;

  // 1. If running on the LLM Quota Tracker Dashboard (localhost:3456)
  if ((host === 'localhost' || host === '127.0.0.1') && port === '3456') {
    document.documentElement.setAttribute('data-quota-ext', '3.0.0');

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data && event.data.type === 'QUOTA_TRACKER_SYNC_NOW') {
        document.documentElement.setAttribute('data-quota-sync-request', String(Date.now()));
        try {
          chrome.runtime.sendMessage({ type: 'POLL_ALL_TABS_NOW' }, () => {
            void chrome.runtime.lastError;
            window.postMessage({ type: 'QUOTA_TRACKER_SYNC_DONE' }, '*');
          });
        } catch {
          // If extension context was invalidated, background.js 3s executeScript loop will pick up data-quota-sync-request
        }
      }
    });
    return;
  }

  // 2. On provider tabs (Antigravity, Claude, ChatGPT/Codex, Kimi):
  // Trigger background worker scan whenever DOM mutates (e.g. when Usage Popover opens!)
  function notifyBackgroundScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: 'POLL_ALL_TABS_NOW' }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        // Ignore if extension was reloaded; background.js executeScript handles it
      }
    }, 600);
  }

  const observer = new MutationObserver(() => {
    notifyBackgroundScan();
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // Also trigger immediately on click (e.g., clicking the "Usage" button in Antigravity toolbar)
  window.addEventListener('click', () => {
    setTimeout(notifyBackgroundScan, 350);
    setTimeout(notifyBackgroundScan, 1000);
  }, true);
})();
