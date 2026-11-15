/**
 * Zero-Click Real-Time Content Script for LLM Quota Tracker (v3.4)
 * - Immediately sets `data-quota-ext="3.5.0"` on `localhost:3456` and wakes the MV3 Service Worker
 * - Bridges `Sync Now` (`QUOTA_TRACKER_SYNC_NOW`) and `Open & Auto-Sync` (`QUOTA_TRACKER_OPEN_PROVIDER`)
 * - Directly extracts live usage text on `claude.ai` (including `/new#settings/usage` modals),
 *   `chatgpt.com/settings/usage`, `kimi.com`, and Antigravity Usage popovers across all frames & shadow DOMs
 */
(function () {
  const host = window.location.hostname || '';
  const port = window.location.port || '';
  let debounceTimer = null;

  // 1. If running on the LLM Quota Tracker Dashboard (localhost:3456)
  if ((host === 'localhost' || host === '127.0.0.1') && port === '3456') {
    document.documentElement.setAttribute('data-quota-ext', '3.5.0');
    window.postMessage({ type: 'QUOTA_TRACKER_EXT_READY', version: '3.5.0' }, '*');

    // Wake up the MV3 Service Worker immediately when the Dashboard loads or extension reloads
    try {
      chrome.runtime.sendMessage({ type: 'POLL_ALL_TABS_NOW' }, (resp) => {
        void chrome.runtime.lastError;
        if (resp?.ok) {
          window.postMessage({ type: 'QUOTA_TRACKER_SYNC_DONE', syncedCount: resp.syncedCount || 0 }, '*');
        }
      });
    } catch {
      // Ignore if context is reloading
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;

      if (event.data.type === 'QUOTA_TRACKER_SYNC_NOW') {
        document.documentElement.setAttribute('data-quota-sync-request', String(Date.now()));
        try {
          chrome.runtime.sendMessage({ type: 'POLL_ALL_TABS_NOW' }, (resp) => {
            if (!chrome.runtime.lastError) {
              document.documentElement.setAttribute('data-quota-ext', '3.5.0');
              window.postMessage({ type: 'QUOTA_TRACKER_SYNC_DONE', syncedCount: resp?.syncedCount || 0 }, '*');
            }
          });
        } catch {
          // If extension was reloaded, background.js re-injects content-script.js
        }
      }

      if (event.data.type === 'QUOTA_TRACKER_OPEN_PROVIDER') {
        const providerId = event.data.providerId || 'all';
        document.documentElement.setAttribute('data-quota-open-provider', providerId);
        try {
          chrome.runtime.sendMessage({ type: 'OPEN_AND_SYNC_PROVIDER', providerId }, (resp) => {
            if (!chrome.runtime.lastError && resp?.ok) {
              document.documentElement.removeAttribute('data-quota-open-provider');
              window.postMessage({
                type: 'QUOTA_TRACKER_OPEN_PROVIDER_ACK',
                providerId,
                foundAntigravityTab: Boolean(resp.foundAntigravityTab),
                syncedAntigravity: Boolean(resp.syncedAntigravity)
              }, '*');
            }
          });
        } catch {
          // Handled by background.js
        }
      }
    });
    return;
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

  // 2. On provider tabs (Claude, ChatGPT/Codex, Kimi, Antigravity in any frame):
  function extractDirectUsageFromCurrentPage() {
    const path = window.location.pathname || '';
    const hash = window.location.hash || '';

    if (host.includes('claude.ai')) {
      const dialogEl = document.querySelector('[role="dialog"], [data-state="open"]');
      const modalText = (dialogEl?.innerText || '').trim();
      const bodyText = (document.body?.innerText || '').trim();
      const candidate = (/\d{1,3}%\s*used/i.test(modalText) ? modalText : bodyText);
      if (
        (path.includes('/settings') || hash.includes('settings') || hash.includes('usage') || /Current session/i.test(candidate)) &&
        /\d{1,3}%\s*used/i.test(candidate)
      ) {
        return { providerId: 'claude', rawText: candidate, accountLabel: 'Claude.ai Web Session' };
      }
      return null;
    }

    if (host.includes('chatgpt.com') || host.includes('openai.com')) {
      const bodyText = (document.body?.innerText || '').trim();
      if (/\d{1,3}%\s*left/i.test(bodyText) && (/5-hour limit/i.test(bodyText) || /Weekly limit/i.test(bodyText))) {
        return { providerId: 'codex', rawText: bodyText, accountLabel: 'ChatGPT / Codex Session' };
      }
      return null;
    }

    if (host.includes('kimi.com') || host.includes('kimi.ai') || host.includes('moonshot.cn')) {
      const bodyText = (document.body?.innerText || '').trim();
      if (/\d{1,3}%\s*(?:left|used)/i.test(bodyText)) {
        return { providerId: 'kimi', rawText: bodyText, accountLabel: 'Kimi.ai Web Session' };
      }
      return null;
    }

    // Antigravity Web (antigravity.google.com/remote?settingsOpen=true&settingsScreen=General / Models) & Popover
    const allEls = collectAllElements(document);

    if (host.includes('antigravity.google.com')) {
      const bodyText = (document.body?.innerText || '').trim();
      if (
        bodyText.includes('Gemini Models') &&
        bodyText.includes('Claude and GPT models') &&
        bodyText.includes('Gemini 4 Argon') &&
        /\d{1,3}\s*%/i.test(bodyText)
      ) {
        return {
          providerId: 'antigravity',
          rawText: bodyText,
          accountLabel: 'Antigravity Web (Models & Usage)'
        };
      }

      // If Settings modal opened on "General" (e.g. ?settingsOpen=true&settingsScreen=General), auto-click "Models" tab!
      if (window.location.search.includes('settingsOpen=true') || bodyText.includes('Appearance')) {
        const now = Date.now();
        if (!window.__quotaLastModelsClick || now - window.__quotaLastModelsClick > 3500) {
          for (const el of allEls) {
            const tag = (el.tagName || '').toUpperCase();
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'PRE' || tag === 'CODE') continue;
            if (isInsideCodeOrChatBubble(el)) continue;
            const txt = (el.innerText || el.textContent || '').trim();
            if (/^Models$/i.test(txt) && el.children.length <= 3) {
              window.__quotaLastModelsClick = now;
              try { el.click(); } catch {}
              setTimeout(() => notifyBackgroundScan(true), 450);
              break;
            }
          }
        }
      }
    }

    let bestPopoverText = '';
    let bestPopoverLen = Infinity;
    for (const el of allEls) {
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'PRE' || tag === 'CODE' || tag === 'TEXTAREA' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HTML') {
        continue;
      }
      if (isInsideCodeOrChatBubble(el)) continue;
      const t = (el.innerText || '').trim();
      if (t.length < 55 || t.length > 2200) continue;
      if (
        t.includes('Gemini Models') &&
        t.includes('Claude and GPT models') &&
        t.includes('Gemini 4 Argon') &&
        /\d{1,3}\s*%/i.test(t) &&
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

    if (bestPopoverText) {
      return {
        providerId: 'antigravity',
        rawText: bestPopoverText,
        accountLabel: host.includes('antigravity.google.com')
          ? 'Antigravity Web (Models & Usage)'
          : 'Antigravity Usage Popover'
      };
    }

    return null;
  }

  function notifyBackgroundScan(force = false) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const direct = extractDirectUsageFromCurrentPage();
        if (direct && direct.rawText) {
          chrome.runtime.sendMessage({
            type: 'AUTO_SYNC_USAGE',
            providerId: direct.providerId,
            rawText: direct.rawText,
            internalApi: { accountLabel: direct.accountLabel },
            pageUrl: window.location.href,
            force
          }, () => { void chrome.runtime.lastError; });
        } else {
          chrome.runtime.sendMessage({ type: 'POLL_ALL_TABS_NOW' }, () => {
            void chrome.runtime.lastError;
          });
        }
      } catch {
        // Ignore if extension context was reloaded
      }
    }, 350);
  }

  // Initial scan on page load
  setTimeout(() => notifyBackgroundScan(true), 600);
  setTimeout(() => notifyBackgroundScan(true), 2000);

  const observer = new MutationObserver(() => {
    notifyBackgroundScan(false);
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  window.addEventListener('click', () => {
    setTimeout(() => notifyBackgroundScan(true), 350);
    setTimeout(() => notifyBackgroundScan(true), 1100);
  }, true);

  window.addEventListener('hashchange', () => {
    setTimeout(() => notifyBackgroundScan(true), 400);
    setTimeout(() => notifyBackgroundScan(true), 1200);
  });
})();
