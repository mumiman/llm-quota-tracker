/**
 * Background Service Worker for LLM Quota Tracker Real-Time Auto-Sync (v2.0)
 * - Receives zero-click updates from content-script.js
 * - Runs a periodic chrome.alarms heartbeat every 1 minute to poll any open Claude, ChatGPT, Kimi, or Antigravity tabs
 * - Pushes parsed usage + internal web API metadata directly to http://localhost:3456
 */

const TRACKER_BASE = 'http://localhost:3456';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('quota_auto_sync', { periodInMinutes: 0.5 });
  chrome.storage.local.set({ autoSyncEnabled: true, lastSyncMap: {} });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'quota_auto_sync') return;
  const { autoSyncEnabled } = await chrome.storage.local.get(['autoSyncEnabled']);
  if (autoSyncEnabled === false) return;
  await pollAllMatchingTabs();
});

async function pushUsageToLocalServer({ providerId, rawText, internalApi, pageUrl }) {
  try {
    // 1. If page has visible usage percentages, send to /api/accounts/parse-usage
    if (rawText && rawText.trim().length > 0) {
      const res = await fetch(`${TRACKER_BASE}/api/accounts/parse-usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId,
          rawText,
          accountLabel: internalApi?.accountLabel || undefined,
          pageUrl
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await recordSyncStatus(providerId, true, `Auto-synced from ${new URL(pageUrl || 'https://local').hostname}`);
        return { ok: true, status: res.status, data };
      }
    }

    // 2. Even if the user is on a chat page (not the settings/usage subpage),
    // if internalApi confirmed an authenticated session, mark the account as Connected!
    if (internalApi?.accountLabel) {
      const res = await fetch(`${TRACKER_BASE}/api/accounts/session-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId,
          accountLabel: internalApi.accountLabel
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await recordSyncStatus(providerId, true, `Session active (${internalApi.accountLabel})`);
        return { ok: true, status: res.status, data };
      }
    }

    return { ok: false, error: 'No usage markers found on page yet' };
  } catch (err) {
    await recordSyncStatus(providerId, false, `Server unreachable (${err.message})`);
    return { ok: false, error: err.message };
  }
}

async function recordSyncStatus(providerId, ok, message) {
  const store = await chrome.storage.local.get(['lastSyncMap']);
  const map = store.lastSyncMap || {};
  map[providerId] = {
    ok,
    message,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ lastSyncMap: map });
}

async function pollAllMatchingTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('brave://')) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_TAB_SCAN' }, () => {
        // Ignore errors for tabs where content script isn't ready
        void chrome.runtime.lastError;
      });
    }
  } catch {
    // ignore tab query errors
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'AUTO_SYNC_USAGE' || msg.type === 'SYNC_USAGE') {
    pushUsageToLocalServer({
      providerId: msg.providerId,
      rawText: msg.rawText,
      internalApi: msg.internalApi,
      pageUrl: msg.pageUrl
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'POLL_ALL_TABS_NOW') {
    pollAllMatchingTabs().then(() => sendResponse({ ok: true }));
    return true;
  }
});
