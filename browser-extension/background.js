/**
 * Background Service Worker for LLM Quota Tracker Real-Time Auto-Sync (v3.4)
 *
 * Root-Cause Fixes in v3.4:
 * 1. Scans `allFrames: true` in `scanAllOpenTabs` and `reinjectContentScriptsIntoOpenTabs` so Antigravity
 *    Web workspaces rendered inside iframes or shadow DOMs are always scanned and synced.
 * 2. Automatically clicks the `Usage` button inside open Antigravity tabs when `Sync Now` or
 *    `Open Antigravity Usage` is triggered, and ignores the deprecated `idx.google.com` landing page.
 * 3. Supports Claude's modal hash URL (`https://claude.ai/new#settings/usage` and `[role="dialog"]`)
 *    and ChatGPT's redirected overview URL (`https://chatgpt.com/settings/usage?tab=overview`).
 */

const TRACKER_BASE = 'http://localhost:3456';
let lastPushedSignatures = {};
let isScanning = false;

/**
 * Fast, synchronous DOM extractor injected into open browser tabs via chrome.scripting.executeScript.
 */
async function extractIsolatedUsageFromTab(tryOpenAntigravityPopover = false) {
  try {
    const host = window.location.hostname || '';
    const port = window.location.port || '';
    const path = window.location.pathname || '';
    const hash = window.location.hash || '';

    // 1. If this tab is the LLM Quota Tracker Dashboard (localhost:3456)
    if ((host === 'localhost' || host === '127.0.0.1') && port === '3456') {
      document.documentElement.setAttribute('data-quota-ext', '3.4.0');
      const syncReq = document.documentElement.getAttribute('data-quota-sync-request');
      const openReq = document.documentElement.getAttribute('data-quota-open-provider');
      if (syncReq) document.documentElement.removeAttribute('data-quota-sync-request');
      if (openReq) document.documentElement.removeAttribute('data-quota-open-provider');
      return {
        isDashboard: true,
        syncRequested: Boolean(syncReq),
        openProviderRequested: openReq || null
      };
    }

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

    // 2. Claude (claude.ai — supports both /settings/usage and /new#settings/usage modal)
    if (host.includes('claude.ai')) {
      const dialogEl = document.querySelector('[role="dialog"], [data-state="open"]');
      const modalText = (dialogEl?.innerText || '').trim();
      const bodyText = (document.body?.innerText || '').trim();
      let bestText = '';

      if (/\d{1,3}%\s*used/i.test(modalText) && /Current session/i.test(modalText)) {
        bestText = modalText;
      } else if (
        (path.includes('/settings') || hash.includes('settings') || hash.includes('usage') || /Your usage/i.test(bodyText)) &&
        /\d{1,3}%\s*used/i.test(bodyText)
      ) {
        bestText = bodyText;
      } else {
        const allEls = collectAllElements(document);
        let bestLen = Infinity;
        for (const el of allEls) {
          if (isInsideCodeOrChatBubble(el)) continue;
          const t = (el.innerText || '').trim();
          if (t.length < 40 || t.length > 3500) continue;
          if (/Current session/i.test(t) && /This week/i.test(t) && /\d{1,3}%\s*used/i.test(t)) {
            if (t.length < bestLen) {
              bestLen = t.length;
              bestText = t;
            }
          }
        }
      }

      if (bestText) {
        return {
          providerId: 'claude',
          rawText: bestText,
          internalApi: { accountLabel: 'Claude.ai Web Session' },
          pageUrl: window.location.href
        };
      }
      return null;
    }

    // 3. Codex / ChatGPT (chatgpt.com / openai.com — supports /settings/usage?tab=overview & /codex/settings/usage)
    if (host.includes('chatgpt.com') || host.includes('openai.com')) {
      const bodyText = (document.body?.innerText || '').trim();
      let bestText = '';

      if (
        (path.includes('/usage') || path.includes('/settings') || /Plan limits/i.test(bodyText) || /5-hour limit/i.test(bodyText)) &&
        /\d{1,3}%\s*left/i.test(bodyText)
      ) {
        bestText = bodyText;
      } else {
        const allEls = collectAllElements(document);
        let bestLen = Infinity;
        for (const el of allEls) {
          if (isInsideCodeOrChatBubble(el)) continue;
          const t = (el.innerText || '').trim();
          if (t.length < 30 || t.length > 3500) continue;
          if (/5-hour limit/i.test(t) && /Weekly limit/i.test(t) && /\d{1,3}%\s*left/i.test(t)) {
            if (t.length < bestLen) {
              bestLen = t.length;
              bestText = t;
            }
          }
        }
      }

      if (bestText) {
        return {
          providerId: 'codex',
          rawText: bestText,
          internalApi: { accountLabel: 'ChatGPT / Codex Session' },
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
        if (t.length < 20 || t.length > 2500) continue;
        if (/\d{1,3}%\s*(?:left|used)/i.test(t)) {
          if (t.length < bestLen) {
            bestLen = t.length;
            bestText = t;
          }
        }
      }
      return {
        providerId: 'kimi',
        rawText: bestText,
        internalApi: { accountLabel: 'Kimi.ai Web Session' },
        pageUrl: window.location.href
      };
    }

    // 5. Antigravity Workspace Detection & Usage Popover Extraction
    function findAntigravityPopoverText() {
      const allEls = collectAllElements(document);
      let bestPopoverText = '';
      let bestPopoverLen = Infinity;

      for (const el of allEls) {
        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'PRE' || tag === 'CODE' || tag === 'TEXTAREA' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HTML') {
          continue;
        }
        if (isInsideCodeOrChatBubble(el)) continue;

        const t = (el.innerText || '').trim();
        if (t.length < 55 || t.length > 1100) continue;

        if (
          t.includes('Gemini Models') &&
          t.includes('Claude and GPT models') &&
          t.includes('Gemini 4 Argon') &&
          /\d{1,3}%\s*left/i.test(t) &&
          !/\d{1,3}%\s*used/i.test(t) &&
          !t.includes('|') &&
          !t.includes('Resets in <1m')
        ) {
          if (t.length <= bestPopoverLen) {
            bestPopoverLen = t.length;
            bestPopoverText = t;
          }
        }
      }
      return bestPopoverText;
    }

    function findAntigravityUsageButton() {
      const allEls = collectAllElements(document);
      for (let i = allEls.length - 1; i >= 0; i--) {
        const el = allEls[i];
        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'PRE' || tag === 'CODE') continue;
        const txt = (el.innerText || el.textContent || '').trim();
        const aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
        if ((/^Usage$/i.test(txt) || /^Usage$/i.test(aria.trim())) && el.children.length <= 4) {
          return el;
        }
      }
      return null;
    }

    function triggerFullClick(el) {
      if (!el) return;
      const targets = [el, el.closest && el.closest('button, [role="button"], [aria-haspopup], a')].filter(Boolean);
      for (const t of targets) {
        try {
          t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
          t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          t.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
          t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          t.click();
        } catch {
          // ignore
        }
      }
    }

    let bestPopoverText = findAntigravityPopoverText();
    const bodyTextSample = (document.body?.innerText || '').slice(0, 4000);
    const isDeprecatedIdxLanding =
      host === 'idx.google.com' &&
      (bodyTextSample.includes('Firebase Studio is evolving') || bodyTextSample.includes('Download Antigravity'));

    const titleOrUrlIsAgy =
      !isDeprecatedIdxLanding &&
      /antigravity|jetski|workstations/i.test(`${document.title} ${window.location.href}`);

    const domLooksLikeAgy =
      !isDeprecatedIdxLanding &&
      Boolean(
        bestPopoverText ||
          titleOrUrlIsAgy ||
          Boolean(findAntigravityUsageButton()) ||
          (bodyTextSample.includes('Antigravity') && bodyTextSample.includes('Gemini'))
      );

    if (!bestPopoverText && domLooksLikeAgy && tryOpenAntigravityPopover) {
      const usageBtn = findAntigravityUsageButton();
      if (usageBtn) {
        triggerFullClick(usageBtn);
        await new Promise((r) => setTimeout(r, 380));
        bestPopoverText = findAntigravityPopoverText();
      }
    }

    if (bestPopoverText) {
      return {
        providerId: 'antigravity',
        rawText: bestPopoverText,
        internalApi: { accountLabel: 'Antigravity Usage Popover' },
        pageUrl: window.location.href,
        isAntigravityTab: true
      };
    }

    if (domLooksLikeAgy) {
      return {
        providerId: null,
        isAntigravityTab: true,
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
 * Re-injects content-script.js into all already-open http/https tabs (and all frames) when the extension loads/reloads
 * so already-open tabs (including localhost:3456, claude.ai, chatgpt.com, and Antigravity iframes) immediately have a live bridge.
 */
async function reinjectContentScriptsIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab.id || !tab.url) return;
        if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) return;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content-script.js']
          });
        } catch {
          // ignore restricted tabs
        }
      })
    );
  } catch {
    // ignore
  }
}

/**
 * Opens or focuses the target provider's usage page in the browser and triggers an immediate scan.
 */
async function openAndSyncProviderTabs(providerId) {
  const allTabs = await chrome.tabs.query({});
  let foundAgyTab = null;
  let syncedAntigravity = false;

  if (providerId === 'antigravity' || providerId === 'all') {
    for (const tab of allTabs) {
      if (!tab.id || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) continue;
      if (tab.url.includes('localhost:3456') || tab.url.includes('127.0.0.1:3456')) continue;
      if (tab.url.includes('claude.ai') || tab.url.includes('chatgpt.com') || tab.url.includes('kimi.com')) continue;

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: extractIsolatedUsageFromTab,
          args: [true]
        });
        for (const frameRes of (results || [])) {
          const r = frameRes?.result;
          if (r?.isAntigravityTab) {
            foundAgyTab = tab;
            if (r.providerId === 'antigravity' && r.rawText) {
              const pushRes = await pushUsageToLocalServer({
                providerId: 'antigravity',
                rawText: r.rawText,
                internalApi: r.internalApi,
                pageUrl: r.pageUrl,
                force: true
              });
              if (pushRes?.ok) syncedAntigravity = true;
            }
          }
        }
      } catch {
        // ignore restricted tab
      }
    }

    if (foundAgyTab && foundAgyTab.id && providerId === 'antigravity') {
      await chrome.tabs.update(foundAgyTab.id, { active: true }).catch(() => {});
      if (foundAgyTab.windowId) {
        await chrome.windows.update(foundAgyTab.windowId, { focused: true }).catch(() => {});
      }
    }
  }

  setTimeout(() => scanAllOpenTabs(true), 900);
  setTimeout(() => scanAllOpenTabs(true), 2500);
  setTimeout(() => scanAllOpenTabs(true), 4500);

  return {
    foundAntigravityTab: Boolean(foundAgyTab),
    syncedAntigravity
  };
}

/**
 * Scans all open tabs (and their subframes) in parallel using chrome.scripting.executeScript.
 * Works immediately on already-open tabs in < 50ms!
 */
async function scanAllOpenTabs(force = false) {
  if (isScanning && !force) return 0;
  isScanning = true;
  let dashboardRequestedForce = false;
  let requestedOpenProvider = null;
  let syncedCount = 0;

  try {
    const tabs = await chrome.tabs.query({});
    const validTabs = tabs.filter(
      (tab) => tab.id && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
    );

    const perTabResults = await Promise.all(
      validTabs.map(async (tab) => {
        try {
          return await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: extractIsolatedUsageFromTab,
            args: [Boolean(force)]
          });
        } catch {
          return [];
        }
      })
    );

    const pushPromises = [];
    for (const injectionResults of perTabResults) {
      for (const frameRes of (injectionResults || [])) {
        const r = frameRes?.result;
        if (!r) continue;
        if (r.isDashboard) {
          if (r.syncRequested) dashboardRequestedForce = true;
          if (r.openProviderRequested) requestedOpenProvider = r.openProviderRequested;
          continue;
        }
        if (r.providerId && r.rawText) {
          pushPromises.push(
            pushUsageToLocalServer({
              providerId: r.providerId,
              rawText: r.rawText,
              internalApi: r.internalApi,
              pageUrl: r.pageUrl,
              force: force || dashboardRequestedForce
            }).then((res) => {
              if (res?.ok) syncedCount++;
            })
          );
        }
      }
    }

    await Promise.all(pushPromises);

    if (requestedOpenProvider) {
      await openAndSyncProviderTabs(requestedOpenProvider);
    } else if (dashboardRequestedForce && !force) {
      isScanning = false;
      return await scanAllOpenTabs(true);
    }
  } catch {
    // ignore query error
  } finally {
    isScanning = false;
  }
  return syncedCount;
}

// 1. Run immediately when service worker wakes up or extension is reloaded!
reinjectContentScriptsIntoOpenTabs().then(() => scanAllOpenTabs(true));

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('quota_auto_sync', { periodInMinutes: 0.5 });
  chrome.storage.local.set({ autoSyncEnabled: true });
  reinjectContentScriptsIntoOpenTabs().then(() => scanAllOpenTabs(true));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('quota_auto_sync', { periodInMinutes: 0.5 });
  reinjectContentScriptsIntoOpenTabs().then(() => scanAllOpenTabs(true));
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

// 3. Fast 2-second poll while service worker is active + 30s alarm backup
setInterval(() => {
  scanAllOpenTabs(false);
}, 2000);

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
    scanAllOpenTabs(true).then((syncedCount) => sendResponse({ ok: true, syncedCount }));
    return true;
  }

  if (msg.type === 'OPEN_AND_SYNC_PROVIDER') {
    openAndSyncProviderTabs(msg.providerId || 'all').then((res) =>
      sendResponse({
        ok: true,
        handled: true,
        foundAntigravityTab: Boolean(res?.foundAntigravityTab),
        syncedAntigravity: Boolean(res?.syncedAntigravity)
      })
    );
    return true;
  }
});
