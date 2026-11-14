/**
 * Background Service Worker for LLM Quota Tracker Real-Time Auto-Sync (v3.0)
 *
 * Root-Cause Fixes in v3.0:
 * 1. Uses `chrome.scripting.executeScript` across all open tabs so already-open tabs
 *    (Antigravity, Claude, Codex, Kimi, and localhost:3456) sync IMMEDIATELY without requiring tab refresh.
 * 2. Isolates the exact Usage Popover DOM element (including Shadow DOMs) and rejects chat transcripts
 *    containing "% used" or markdown tables, preventing chat history from polluting quota state.
 * 3. Bridges `localhost:3456` "Sync Now" clicks directly to an immediate cross-tab scan.
 */

const TRACKER_BASE = 'http://localhost:3456';
let lastPushedSignatures = {};
let isScanning = false;

/**
 * Injected directly into open browser tabs via chrome.scripting.executeScript.
 * Must be 100% self-contained (no external closures).
 */
async function extractIsolatedUsageFromTab() {
  try {
    const host = window.location.hostname || '';
    const port = window.location.port || '';

    // 1. If this tab is the LLM Quota Tracker Dashboard (localhost:3456)
    if ((host === 'localhost' || host === '127.0.0.1') && port === '3456') {
      document.documentElement.setAttribute('data-quota-ext', '3.0.0');
      const syncReq = document.documentElement.getAttribute('data-quota-sync-request');
      if (syncReq) {
        document.documentElement.removeAttribute('data-quota-sync-request');
        return { isDashboard: true, syncRequested: true };
      }
      return { isDashboard: true, syncRequested: false };
    }

    // Helper: collect all elements across standard DOM + open Shadow Roots
    function collectAllElements(root, out = []) {
      if (!root) return out;
      const children = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (let i = 0; i < children.length; i++) {
        const el = children[i];
        out.push(el);
        if (el.shadowRoot) {
          collectAllElements(el.shadowRoot, out);
        }
      }
      return out;
    }

    function isInsideCodeOrChatBubble(el) {
      if (!el || !el.closest) return false;
      return Boolean(
        el.closest('pre, code, textarea, script, style, [data-message-author-role], .markdown-body, .prose')
      );
    }

    // 2. Claude (claude.ai)
    if (host.includes('claude.ai')) {
      let internalApi = null;
      try {
        const res = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
        if (res.ok) {
          const orgs = await res.json();
          if (Array.isArray(orgs) && orgs.length > 0) {
            internalApi = {
              accountLabel: orgs[0].name || 'Claude.ai Session',
              organizationId: orgs[0].uuid || orgs[0].id
            };
          }
        }
      } catch {
        // ignore fetch error
      }

      const allEls = collectAllElements(document);
      let bestText = '';
      let bestLen = Infinity;
      for (const el of allEls) {
        if (isInsideCodeOrChatBubble(el)) continue;
        const t = (el.innerText || '').trim();
        if (t.length < 40 || t.length > 1600) continue;
        if (/Current session/i.test(t) && /This week/i.test(t) && /\d{1,3}%\s*used/i.test(t)) {
          if (t.length < bestLen) {
            bestLen = t.length;
            bestText = t;
          }
        }
      }

      if (bestText || internalApi) {
        return {
          providerId: 'claude',
          rawText: bestText,
          internalApi,
          pageUrl: window.location.href
        };
      }
      return null;
    }

    // 3. Codex / ChatGPT (chatgpt.com / openai.com)
    if (host.includes('chatgpt.com') || host.includes('openai.com')) {
      let internalApi = null;
      if (host.includes('chatgpt.com')) {
        try {
          const res = await fetch('https://chatgpt.com/backend-api/me', { credentials: 'include' });
          if (res.ok) {
            const me = await res.json();
            internalApi = {
              accountLabel: me.email || me.name || 'ChatGPT Session',
              userId: me.id
            };
          }
        } catch {
          // ignore
        }
      }

      const allEls = collectAllElements(document);
      let bestText = '';
      let bestLen = Infinity;
      for (const el of allEls) {
        if (isInsideCodeOrChatBubble(el)) continue;
        const t = (el.innerText || '').trim();
        if (t.length < 30 || t.length > 1600) continue;
        if (/5-hour limit/i.test(t) && /Weekly limit/i.test(t) && /\d{1,3}%\s*left/i.test(t)) {
          if (t.length < bestLen) {
            bestLen = t.length;
            bestText = t;
          }
        }
      }

      if (bestText || internalApi) {
        return {
          providerId: 'codex',
          rawText: bestText,
          internalApi,
          pageUrl: window.location.href
        };
      }
      return null;
    }

    // 4. Kimi (kimi.com / kimi.ai / moonshot.cn)
    if (host.includes('kimi.com') || host.includes('kimi.ai') || host.includes('moonshot.cn')) {
      const allEls = collectAllElements(document);
      let bestText = '';
      let bestLen = Infinity;
      for (const el of allEls) {
        if (isInsideCodeOrChatBubble(el)) continue;
        const t = (el.innerText || '').trim();
        if (t.length < 20 || t.length > 1200) continue;
        if (/\d{1,3}%\s*(?:left|used)/i.test(t)) {
          if (t.length < bestLen) {
            bestLen = t.length;
            bestText = t;
          }
        }
      }
      if (bestText) {
        return {
          providerId: 'kimi',
          rawText: bestText,
          internalApi: { accountLabel: 'Kimi.ai Web Session' },
          pageUrl: window.location.href
        };
      }
      return null;
    }

    // 5. Antigravity Usage Popover (Strict Popover Isolation — NEVER matches chat transcript!)
    const allEls = collectAllElements(document);
    let bestPopoverText = '';
    let bestPopoverLen = Infinity;

    for (const el of allEls) {
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'PRE' || tag === 'CODE' || tag === 'TEXTAREA' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'BODY' || tag === 'HTML') {
        continue;
      }
      if (isInsideCodeOrChatBubble(el)) continue;

      const t = (el.innerText || '').trim();
      // The real Antigravity Usage Popover is ~180-360 chars total.
      if (t.length < 60 || t.length > 480) continue;

      // Native Antigravity Usage Popover contains the 3 model groups and "% left",
      // and NEVER contains "% used" or markdown table pipes "|".
      if (
        t.includes('Gemini Models') &&
        t.includes('Claude and GPT models') &&
        t.includes('Gemini 4 Argon') &&
        /\d{1,3}%\s*left/i.test(t) &&
        !/\d{1,3}%\s*used/i.test(t) &&
        !t.includes('|')
      ) {
        if (t.length <= bestPopoverLen) {
          bestPopoverLen = t.length;
          bestPopoverText = t;
        }
      }
    }

    if (bestPopoverText) {
      return {
        providerId: 'antigravity',
        rawText: bestPopoverText,
        internalApi: { accountLabel: 'Antigravity Usage Popover' },
        pageUrl: window.location.href
      };
    }

    return null;
  } catch {
    return null;
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

async function pushUsageToLocalServer({ providerId, rawText, internalApi, pageUrl, force = false }) {
  if (!providerId) return { ok: false };

  const sig = `${providerId}|${(rawText || '').replace(/\s+/g, ' ').trim()}|${internalApi?.accountLabel || ''}`;
  if (!force && rawText && lastPushedSignatures[providerId] === sig) {
    return { ok: true, cached: true };
  }

  try {
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
        lastPushedSignatures[providerId] = sig;
        let hostLabel = 'browser tab';
        try { hostLabel = new URL(pageUrl).hostname; } catch {}
        await recordSyncStatus(providerId, true, `Live synced from ${hostLabel}`);
        return { ok: true, status: res.status, data };
      }
    }

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

    return { ok: false, error: 'No isolated usage popover found on tab' };
  } catch (err) {
    await recordSyncStatus(providerId, false, `Server unreachable (${err.message})`);
    return { ok: false, error: err.message };
  }
}

/**
 * Directly scans all open tabs using chrome.scripting.executeScript.
 * Works immediately on already-open tabs without requiring tab reloads!
 */
async function scanAllOpenTabs(force = false) {
  if (isScanning && !force) return;
  isScanning = true;
  let dashboardRequestedForce = false;

  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) continue;

      try {
        const injectionResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: extractIsolatedUsageFromTab
        });

        for (const frameRes of (injectionResults || [])) {
          const r = frameRes?.result;
          if (!r) continue;
          if (r.isDashboard) {
            if (r.syncRequested) dashboardRequestedForce = true;
            continue;
          }
          if (r.providerId) {
            await pushUsageToLocalServer({
              providerId: r.providerId,
              rawText: r.rawText,
              internalApi: r.internalApi,
              pageUrl: r.pageUrl,
              force: force || dashboardRequestedForce
            });
          }
        }
      } catch {
        // Ignore restricted tabs (e.g. Chrome Web Store)
      }
    }

    if (dashboardRequestedForce && !force) {
      isScanning = false;
      await scanAllOpenTabs(true);
    }
  } catch {
    // ignore query error
  } finally {
    isScanning = false;
  }
}

// 1. Run immediately when service worker wakes up or extension is reloaded!
scanAllOpenTabs(true);

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('quota_auto_sync', { periodInMinutes: 0.5 });
  chrome.storage.local.set({ autoSyncEnabled: true });
  scanAllOpenTabs(true);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('quota_auto_sync', { periodInMinutes: 0.5 });
  scanAllOpenTabs(true);
});

// 2. Scan whenever any tab updates or becomes active
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    scanAllOpenTabs(false);
  }
});

chrome.tabs.onActivated.addListener(() => {
  scanAllOpenTabs(false);
});

// 3. Fast 3-second poll while service worker is active + 30s alarm backup
setInterval(() => {
  scanAllOpenTabs(false);
}, 3000);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'quota_auto_sync') return;
  await scanAllOpenTabs(false);
});

// 4. Listen for messages from content-script.js or popup.js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'AUTO_SYNC_USAGE' || msg.type === 'SYNC_USAGE') {
    pushUsageToLocalServer({
      providerId: msg.providerId,
      rawText: msg.rawText,
      internalApi: msg.internalApi,
      pageUrl: msg.pageUrl,
      force: Boolean(msg.force)
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'POLL_ALL_TABS_NOW') {
    scanAllOpenTabs(true).then(() => sendResponse({ ok: true }));
    return true;
  }
});
