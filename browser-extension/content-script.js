/**
 * Zero-Click Real-Time Content Script for LLM Quota Tracker
 * Automatically observes DOM and internal web APIs on Claude.ai, ChatGPT/Codex, Kimi.ai, and Antigravity
 * and streams updates to the background service worker -> http://localhost:3456.
 */
(function () {
  const host = window.location.hostname || '';
  let lastSentHash = '';
  let debounceTimer = null;

  function detectProviderFromPage(text) {
    if (host.includes('claude.ai')) return 'claude';
    if (host.includes('chatgpt.com') || host.includes('openai.com')) return 'codex';
    if (host.includes('kimi.com') || host.includes('kimi.ai') || host.includes('moonshot.cn')) return 'kimi';
    // Antigravity can run on various Google / cloud / local workspace hosts — detect by signature text
    if (
      text.includes('Gemini Models') &&
      text.includes('Claude and GPT models') &&
      (text.includes('% left') || text.includes('Gemini 4 Argon'))
    ) {
      return 'antigravity';
    }
    return null;
  }

  function hasRelevantUsageMarkers(providerId, text) {
    if (!text) return false;
    if (providerId === 'claude') {
      return /%\s*used/i.test(text) && (/Current session/i.test(text) || /This week/i.test(text));
    }
    if (providerId === 'codex') {
      return /%\s*left/i.test(text) && (/5-hour limit/i.test(text) || /Weekly limit/i.test(text) || /Plan limits/i.test(text));
    }
    if (providerId === 'antigravity') {
      return /%\s*left/i.test(text) && /Gemini Models/i.test(text);
    }
    if (providerId === 'kimi') {
      return (/%\s*used/i.test(text) || /%\s*left/i.test(text));
    }
    return false;
  }

  async function probeInternalWebApis(providerId) {
    try {
      if (providerId === 'claude' && host.includes('claude.ai')) {
        const res = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
        if (!res.ok) return null;
        const orgs = await res.json();
        if (!Array.isArray(orgs) || orgs.length === 0) return null;
        const org = orgs[0];
        const orgId = org.uuid || org.id;

        // Probe possible usage/settings endpoints within the same authenticated origin
        let usagePayload = null;
        for (const suffix of ['/usage', '/rate_limits', '/settings/usage']) {
          try {
            const uRes = await fetch(`https://claude.ai/api/organizations/${orgId}${suffix}`, { credentials: 'include' });
            if (uRes.ok) {
              usagePayload = await uRes.json();
              break;
            }
          } catch {
            // ignore 404/network on optional internal paths
          }
        }
        return {
          accountLabel: org.name || 'Claude.ai Authenticated Session',
          organizationId: orgId,
          usagePayload
        };
      }

      if (providerId === 'codex' && host.includes('chatgpt.com')) {
        const res = await fetch('https://chatgpt.com/backend-api/me', { credentials: 'include' });
        if (!res.ok) return null;
        const me = await res.json();
        return {
          accountLabel: me.email || me.name || 'ChatGPT Authenticated Session',
          userId: me.id
        };
      }
    } catch {
      // Ignore internal API probe errors
    }
    return null;
  }

  async function scanAndSync(force = false) {
    if (!document.body) return;
    const text = document.body.innerText || '';
    const providerId = detectProviderFromPage(text);
    if (!providerId) return;

    const hasUsage = hasRelevantUsageMarkers(providerId, text);
    if (!hasUsage && !force) return;

    // Extract a compact hash of the usage numbers so we only push when numbers change or every 30s
    const numbersSignature = [
      providerId,
      ...(text.match(/\d{1,3}%\s*(?:used|left)/gi) || []),
      ...(text.match(/Resets\s+(?:in|at|Friday|Monday|Tuesday|Wednesday|Thursday|Saturday|Sunday)[^\n]{0,25}/gi) || [])
    ].join('|');

    if (!force && numbersSignature === lastSentHash) return;
    lastSentHash = numbersSignature;

    const internalApi = await probeInternalWebApis(providerId);

    chrome.runtime.sendMessage({
      type: 'AUTO_SYNC_USAGE',
      providerId,
      rawText: hasUsage ? text : '',
      internalApi,
      pageUrl: window.location.href,
      timestamp: Date.now()
    });
  }

  function scheduleScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => scanAndSync(false), 1000);
  }

  // 1. Initial scan once page settles
  setTimeout(() => scanAndSync(true), 1200);

  // 2. Live DOM MutationObserver (fires immediately when usage modal/popover opens or numbers update)
  const observer = new MutationObserver(() => {
    scheduleScan();
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // 3. Periodic 15-second heartbeat while tab is open
  setInterval(() => scanAndSync(false), 15000);

  // 4. Listen for background worker requests to poll immediately
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TRIGGER_TAB_SCAN') {
      scanAndSync(true).then(() => sendResponse({ ok: true }));
      return true;
    }
  });
})();
