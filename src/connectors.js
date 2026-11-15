const { execFile } = require('child_process');
const { loadAccounts, saveAccounts } = require('./accounts');
const { loadState, saveState, appendHistorySnapshot } = require('./store');
const { scanLocalEnvironments } = require('./scanner');

/**
 * Pure helper to normalize HTTP rate-limit headers from Anthropic / OpenAI / Gemini
 * into { usedPct, resetText, details }
 */
function parseRateLimitHeaders(headers, provider) {
  const get = (name) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) return headers[k];
    }
    return null;
  };

  if (provider === 'claude') {
    const reqLimit = Number(get('anthropic-ratelimit-requests-limit'));
    const reqRem = Number(get('anthropic-ratelimit-requests-remaining'));
    const tokLimit = Number(get('anthropic-ratelimit-tokens-limit'));
    const tokRem = Number(get('anthropic-ratelimit-tokens-remaining'));
    const resetIso = get('anthropic-ratelimit-requests-reset') || get('anthropic-ratelimit-tokens-reset');

    let usedPct = null;
    if (reqLimit > 0 && !Number.isNaN(reqRem)) {
      usedPct = Math.round(((reqLimit - reqRem) / reqLimit) * 100);
    }
    if (tokLimit > 0 && !Number.isNaN(tokRem)) {
      const tokUsedPct = Math.round(((tokLimit - tokRem) / tokLimit) * 100);
      usedPct = usedPct === null ? tokUsedPct : Math.max(usedPct, tokUsedPct);
    }

    let resetText = null;
    if (resetIso) {
      const dt = new Date(resetIso);
      if (!Number.isNaN(dt.getTime())) {
        resetText = `Resets at ${dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      }
    }

    return {
      hasHeaders: usedPct !== null,
      usedPct: usedPct !== null ? Math.min(100, Math.max(0, usedPct)) : null,
      resetText,
      raw: { reqLimit, reqRem, tokLimit, tokRem }
    };
  }

  if (provider === 'codex' || provider === 'kimi') {
    const reqLimit = Number(get('x-ratelimit-limit-requests'));
    const reqRem = Number(get('x-ratelimit-remaining-requests'));
    const tokLimit = Number(get('x-ratelimit-limit-tokens'));
    const tokRem = Number(get('x-ratelimit-remaining-tokens'));
    const resetReq = get('x-ratelimit-reset-requests') || get('x-ratelimit-reset-tokens');

    let usedPct = null;
    if (reqLimit > 0 && !Number.isNaN(reqRem)) {
      usedPct = Math.round(((reqLimit - reqRem) / reqLimit) * 100);
    }
    if (tokLimit > 0 && !Number.isNaN(tokRem)) {
      const tokUsedPct = Math.round(((tokLimit - tokRem) / tokLimit) * 100);
      usedPct = usedPct === null ? tokUsedPct : Math.max(usedPct, tokUsedPct);
    }

    return {
      hasHeaders: usedPct !== null,
      usedPct: usedPct !== null ? Math.min(100, Math.max(0, usedPct)) : null,
      resetText: resetReq ? `Resets in ${resetReq}` : null,
      raw: { reqLimit, reqRem, tokLimit, tokRem }
    };
  }

  return { hasHeaders: false, usedPct: null, resetText: null, raw: {} };
}

async function syncClaudeAccount(accConfig) {
  if (!accConfig.apiKey) {
    return { ok: false, connected: false, status: 'No API key configured (using local ~/.claude watcher)' };
  }
  const url = `${accConfig.baseUrl}/v1/models`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': accConfig.apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: AbortSignal.timeout(8000)
    });
    const parsed = parseRateLimitHeaders(res.headers, 'claude');
    if (res.status === 401 || res.status === 403) {
      return { ok: false, connected: false, status: `Invalid API key (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, connected: false, status: `API returned HTTP ${res.status}`, rateLimit: parsed };
    }
    const body = await res.json().catch(() => ({}));
    const modelCount = Array.isArray(body.data) ? body.data.length : 0;
    return {
      ok: true,
      connected: true,
      status: `Connected (${modelCount} models accessible)`,
      rateLimit: parsed
    };
  } catch (err) {
    return { ok: false, connected: false, status: `Connection failed: ${err.message}` };
  }
}

async function syncCodexAccount(accConfig) {
  if (!accConfig.apiKey) {
    return { ok: false, connected: false, status: 'No API key configured (using local ~/.codex watcher)' };
  }
  const url = `${accConfig.baseUrl}/v1/models`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accConfig.apiKey}`
      },
      signal: AbortSignal.timeout(8000)
    });
    const parsed = parseRateLimitHeaders(res.headers, 'codex');
    if (res.status === 401 || res.status === 403) {
      return { ok: false, connected: false, status: `Invalid API key (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, connected: false, status: `API returned HTTP ${res.status}`, rateLimit: parsed };
    }
    const body = await res.json().catch(() => ({}));
    const modelCount = Array.isArray(body.data) ? body.data.length : 0;
    return {
      ok: true,
      connected: true,
      status: `Connected (${modelCount} OpenAI/Codex models accessible)`,
      rateLimit: parsed
    };
  } catch (err) {
    return { ok: false, connected: false, status: `Connection failed: ${err.message}` };
  }
}

async function syncAntigravityAccount(accConfig) {
  if (!accConfig.apiKey) {
    return { ok: false, connected: false, status: 'No Gemini API key configured (using local ~/.gemini watcher)' };
  }
  const url = `${accConfig.baseUrl}/v1beta/models?key=${encodeURIComponent(accConfig.apiKey)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(8000)
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, connected: false, status: `Invalid Gemini API key (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, connected: false, status: `API returned HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    const modelCount = Array.isArray(body.models) ? body.models.length : 0;
    return {
      ok: true,
      connected: true,
      status: `Connected (${modelCount} Gemini models accessible)`,
      rateLimit: { hasHeaders: false }
    };
  } catch (err) {
    return { ok: false, connected: false, status: `Connection failed: ${err.message}` };
  }
}

async function syncKimiAccount(accConfig) {
  if (!accConfig || !accConfig.apiKey) {
    return { ok: false, connected: false, status: 'No API key configured (using local ~/.kimi watcher)' };
  }
  const url = `${accConfig.baseUrl}/v1/models`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accConfig.apiKey}`
      },
      signal: AbortSignal.timeout(8000)
    });
    const parsed = parseRateLimitHeaders(res.headers, 'kimi');
    if (res.status === 401 || res.status === 403) {
      return { ok: false, connected: false, status: `Invalid Kimi API key (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, connected: false, status: `API returned HTTP ${res.status}`, rateLimit: parsed };
    }
    const body = await res.json().catch(() => ({}));
    const modelCount = Array.isArray(body.data) ? body.data.length : 0;
    return {
      ok: true,
      connected: true,
      status: `Connected (${modelCount} Kimi/Moonshot models accessible)`,
      rateLimit: parsed
    };
  } catch (err) {
    return { ok: false, connected: false, status: `Connection failed: ${err.message}` };
  }
}

/**
 * Applies parsed usage metrics to `state` and `accounts`.
 */
function applyParsedUsageToState(providerId, parsed, meta, state, acc) {
  if (acc && acc.providers && acc.providers[providerId]) {
    acc.providers[providerId].connected = true;
    acc.providers[providerId].mode = 'web_auto_sync';
    acc.providers[providerId].lastSyncAt = new Date().toISOString();
    if (meta?.accountLabel) {
      acc.providers[providerId].accountLabel = meta.accountLabel;
    }
    if (meta?.pageUrl) {
      acc.providers[providerId].webUrl = meta.pageUrl;
    }
    const timeLabel = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    acc.providers[providerId].lastStatus = `Live Auto-Sync (${meta?.accountLabel || 'Browser Extension'} @ ${timeLabel})`;
  }

  if (providerId === 'claude') {
    if (parsed.summary) state.providers.claude.summary = parsed.summary;
    if (typeof parsed.sessionUsedPct === 'number') state.providers.claude.metrics[0].usedPct = parsed.sessionUsedPct;
    if (parsed.sessionResetText) state.providers.claude.metrics[0].resetText = parsed.sessionResetText;
    if (typeof parsed.weeklyUsedPct === 'number') state.providers.claude.metrics[1].usedPct = parsed.weeklyUsedPct;
    if (parsed.weeklyResetText) state.providers.claude.metrics[1].resetText = parsed.weeklyResetText;
    if (typeof parsed.fableUsedPct === 'number') {
      const fableIdx = state.providers.claude.metrics.findIndex(m => m.id === 'fable');
      const fableMetric = {
        id: 'fable',
        label: 'Fable',
        subtitle: 'Up to 50% of your weekly limit',
        usedPct: parsed.fableUsedPct,
        resetText: parsed.weeklyResetText || 'Resets Friday 11:00 PM',
        countdown: '5d 21h'
      };
      if (fableIdx >= 0) state.providers.claude.metrics[fableIdx] = fableMetric;
      else state.providers.claude.metrics.push(fableMetric);
    }
  } else if (providerId === 'codex') {
    if (typeof parsed.sessionUsedPct === 'number') state.providers.codex.limits[0].usedPct = parsed.sessionUsedPct;
    if (parsed.sessionResetText) state.providers.codex.limits[0].resetText = parsed.sessionResetText;
    if (typeof parsed.weeklyUsedPct === 'number') state.providers.codex.limits[1].usedPct = parsed.weeklyUsedPct;
    if (parsed.weeklyResetText) state.providers.codex.limits[1].resetText = parsed.weeklyResetText;
    if (Array.isArray(parsed.resetsAvailable)) state.providers.codex.resetsAvailable = parsed.resetsAvailable;
  } else if (providerId === 'antigravity') {
    if (typeof parsed.geminiWeeklyUsedPct === 'number') state.providers.antigravity.groups[0].items[1].usedPct = parsed.geminiWeeklyUsedPct;
    if (parsed.geminiWeeklyResetText) state.providers.antigravity.groups[0].items[1].resetText = parsed.geminiWeeklyResetText;
    if (typeof parsed.gemini5hUsedPct === 'number') state.providers.antigravity.groups[0].items[0].usedPct = parsed.gemini5hUsedPct;
    if (parsed.gemini5hResetText) state.providers.antigravity.groups[0].items[0].resetText = parsed.gemini5hResetText;
    if (typeof parsed.claudeGptWeeklyUsedPct === 'number') state.providers.antigravity.groups[1].items[1].usedPct = parsed.claudeGptWeeklyUsedPct;
    if (parsed.claudeGptWeeklyResetText) state.providers.antigravity.groups[1].items[1].resetText = parsed.claudeGptWeeklyResetText;
    if (typeof parsed.claudeGpt5hUsedPct === 'number') state.providers.antigravity.groups[1].items[0].usedPct = parsed.claudeGpt5hUsedPct;
    if (parsed.claudeGpt5hResetText) state.providers.antigravity.groups[1].items[0].resetText = parsed.claudeGpt5hResetText;
    if (typeof parsed.argonWeeklyUsedPct === 'number') state.providers.antigravity.groups[2].items[0].usedPct = parsed.argonWeeklyUsedPct;
    if (parsed.argonWeeklyResetText) state.providers.antigravity.groups[2].items[0].resetText = parsed.argonWeeklyResetText;

    const gW = state.providers.antigravity.groups[0].items[1].usedPct;
    const cgW = state.providers.antigravity.groups[1].items[1].usedPct;
    const argW = state.providers.antigravity.groups[2].items[0].usedPct;
    state.providers.antigravity.summary = `Gemini ${gW}%w • Claude & GPT ${cgW}%w • Argon ${argW}%w`;
  } else if (providerId === 'kimi' && state.providers.kimi) {
    if (typeof parsed.sessionUsedPct === 'number') state.providers.kimi.limits[0].usedPct = parsed.sessionUsedPct;
    if (parsed.sessionResetText) state.providers.kimi.limits[0].resetText = parsed.sessionResetText;
    if (typeof parsed.weeklyUsedPct === 'number') state.providers.kimi.limits[1].usedPct = parsed.weeklyUsedPct;
    if (parsed.weeklyResetText) state.providers.kimi.limits[1].resetText = parsed.weeklyResetText;
  }
}

/**
 * On macOS, directly inspects open tabs in Brave Browser / Google Chrome via AppleScript
 * when the user clicks "Sync Now" so it can sync open Usage pages even if the Extension wasn't reloaded.
 */
async function syncOpenMacBrowserTabs(state, accounts) {
  if (process.platform !== 'darwin') {
    return { syncedProviders: [], foundTabs: [], appleEventsDisabled: false };
  }

  const script = `
set outList to ""
repeat with appName in {"Brave Browser", "Google Chrome"}
  if application appName is running then
    try
      tell application appName
        repeat with w in windows
          repeat with t in tabs of w
            set u to URL of t
            if u contains "claude.ai" or u contains "chatgpt.com" or u contains "kimi.com" or u contains "kimi.ai" or u contains "idx.google.com" then
              try
                set bodyTxt to execute t javascript "(document.querySelector('[role=\\"dialog\\"]') ? document.querySelector('[role=\\"dialog\\"]').innerText + '\\\\n' : '') + (document.body ? document.body.innerText : '')"
                set outList to outList & "<<<TAB_START>>>" & u & "<<<URL_END>>>" & bodyTxt & "<<<TAB_END>>>"
              on error errMsg
                set outList to outList & "<<<TAB_START>>>" & u & "<<<URL_END>>>APPLE_EVENTS_ERR:" & errMsg & "<<<TAB_END>>>"
              end try
            end if
          end repeat
        end repeat
      end tell
    end try
  end if
end repeat
return outList
`;

  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 3500, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        return resolve({ syncedProviders: [], foundTabs: [], appleEventsDisabled: false });
      }
      const syncedProviders = [];
      const foundTabs = [];
      let appleEventsDisabled = false;

      const blocks = String(stdout).split('<<<TAB_START>>>').slice(1);
      for (const blk of blocks) {
        const endIdx = blk.indexOf('<<<TAB_END>>>');
        const content = endIdx >= 0 ? blk.slice(0, endIdx) : blk;
        const sepIdx = content.indexOf('<<<URL_END>>>');
        if (sepIdx === -1) continue;
        const tabUrl = content.slice(0, sepIdx).trim();
        const bodyText = content.slice(sepIdx + '<<<URL_END>>>'.length).trim();

        let providerId = null;
        if (tabUrl.includes('claude.ai')) providerId = 'claude';
        else if (tabUrl.includes('chatgpt.com') || tabUrl.includes('openai.com')) providerId = 'codex';
        else if (tabUrl.includes('kimi.com') || tabUrl.includes('kimi.ai')) providerId = 'kimi';
        else if (tabUrl.includes('idx.google.com') || /Gemini Models/i.test(bodyText)) providerId = 'antigravity';

        if (!providerId) continue;
        if (!foundTabs.includes(providerId)) foundTabs.push(providerId);

        if (bodyText.startsWith('APPLE_EVENTS_ERR:')) {
          appleEventsDisabled = true;
          continue;
        }

        const parsed = parseUsagePageText(providerId, bodyText);
        if (parsed && parsed.ok) {
          applyParsedUsageToState(
            providerId,
            parsed,
            { accountLabel: 'macOS Browser Tab Sync', pageUrl: tabUrl },
            state,
            accounts
          );
          if (!syncedProviders.includes(providerId)) {
            syncedProviders.push(providerId);
          }
        }
      }

      resolve({ syncedProviders, foundTabs, appleEventsDisabled });
    });
  });
}

/**
 * Syncs all configured accounts (API keys + macOS open browser tabs + local ~/.gemini, ~/.claude, ~/.codex, ~/.kimi logs)
 * and updates quota-state.json when real metrics are returned.
 */
async function syncAllAccounts({ applyLocalEstimates = true } = {}) {
  const accounts = loadAccounts();
  const state = loadState();
  const localScan = scanLocalEnvironments();

  const [agyRes, claudeRes, codexRes, kimiRes, macTabSync] = await Promise.all([
    syncAntigravityAccount(accounts.providers.antigravity),
    syncClaudeAccount(accounts.providers.claude),
    syncCodexAccount(accounts.providers.codex),
    syncKimiAccount(accounts.providers.kimi),
    syncOpenMacBrowserTabs(state, accounts)
  ]);

  const nowIso = new Date().toISOString();

  function updateProviderSyncMeta(provId, apiRes, scanSource) {
    const p = accounts.providers[provId];
    if (!p) return;
    if (macTabSync.syncedProviders.includes(provId)) {
      return; // Already updated with fresh macOS Browser Tab Sync status
    }
    const isWebSynced = (p.mode === 'web_auto_sync' || p.mode === 'browser_oauth') && p.connected;
    if (apiRes.ok) {
      p.connected = true;
      p.lastSyncAt = nowIso;
      p.lastStatus = apiRes.status;
    } else if (isWebSynced) {
      // Preserve live Browser Extension / Web OAuth sync status instead of overwriting with local CLI message
      p.connected = true;
    } else {
      // Only mark connected = true when real API or Browser Extension sync is active
      p.connected = false;
      p.lastSyncAt = nowIso;
      p.lastStatus = scanSource?.detected
        ? `Local CLI detected (${scanSource.recent5hEvents} events/5h) — waiting for Browser Extension Auto-Sync`
        : apiRes.status;
    }
  }

  updateProviderSyncMeta('antigravity', agyRes, localScan.sources.antigravity);
  updateProviderSyncMeta('claude', claudeRes, localScan.sources.claude);
  updateProviderSyncMeta('codex', codexRes, localScan.sources.codex);
  updateProviderSyncMeta('kimi', kimiRes, localScan.sources.kimi);

  saveAccounts(accounts);

  // Apply real rate-limit headers if returned by upstream APIs
  if (claudeRes.ok && claudeRes.rateLimit?.hasHeaders) {
    state.providers.claude.metrics[0].usedPct = claudeRes.rateLimit.usedPct;
    if (claudeRes.rateLimit.resetText) {
      state.providers.claude.metrics[0].resetText = claudeRes.rateLimit.resetText;
    }
  }

  if (codexRes.ok && codexRes.rateLimit?.hasHeaders) {
    state.providers.codex.limits[0].usedPct = codexRes.rateLimit.usedPct;
    if (codexRes.rateLimit.resetText) {
      state.providers.codex.limits[0].resetText = codexRes.rateLimit.resetText;
    }
  }

  if (kimiRes.ok && kimiRes.rateLimit?.hasHeaders && state.providers.kimi) {
    state.providers.kimi.limits[0].usedPct = kimiRes.rateLimit.usedPct;
    if (kimiRes.rateLimit.resetText) {
      state.providers.kimi.limits[0].resetText = kimiRes.rateLimit.resetText;
    }
  }

  if (macTabSync.syncedProviders.length > 0) {
    appendHistorySnapshot(state);
  }
  saveState(state);

  return {
    syncedAt: nowIso,
    results: {
      antigravity: agyRes,
      claude: claudeRes,
      codex: codexRes,
      kimi: kimiRes
    },
    macTabSync,
    localScan,
    state
  };
}

function extractAntigravityPopoverBlock(text) {
  let searchEnd = text.length;
  let fallbackBlock = null;

  while (searchEnd > 0) {
    const idx = text.lastIndexOf('Gemini Models', searchEnd);
    if (idx === -1) break;
    const candidate = text.slice(idx, idx + 750);
    const hasClaudeGpt = /Claude and GPT models/i.test(candidate);
    const hasArgon = /Gemini 4 Argon/i.test(candidate);
    if (hasClaudeGpt && hasArgon) {
      const argonMatch = candidate.match(/Gemini 4 Argon/i);
      const endOffset = argonMatch ? argonMatch.index + 140 : candidate.length;
      const block = candidate.slice(0, endOffset);
      if (!fallbackBlock) fallbackBlock = block;
      // Native Antigravity Usage popover only uses "% left", never "% used" or markdown tables
      if (!/\d{1,3}%\s*used/i.test(block) && !block.includes('|')) {
        return block;
      }
    }
    searchEnd = idx - 1;
  }

  return fallbackBlock || text;
}

function parseTwoTierAntigravitySection(sec) {
  if (!sec) {
    return {
      weeklyUsedPct: null,
      fiveHourUsedPct: null,
      weeklyResetText: null,
      fiveHourResetText: null
    };
  }
  const leftMatches = [...sec.matchAll(/(\d{1,3})%\s*left/gi)];
  const weeklyLeft = leftMatches[0] ? Number(leftMatches[0][1]) : null;
  const fiveHourLeft = leftMatches[1] ? Number(leftMatches[1][1]) : null;

  const weeklyUsedPct = weeklyLeft !== null ? Math.min(100, Math.max(0, 100 - weeklyLeft)) : null;
  const fiveHourUsedPct = fiveHourLeft !== null ? Math.min(100, Math.max(0, 100 - fiveHourLeft)) : null;

  const weeklyPart = leftMatches[1] ? sec.slice(0, leftMatches[1].index) : sec;
  const fiveHourPart = leftMatches[1] ? sec.slice(leftMatches[1].index) : '';

  const weeklyResetMatch = weeklyPart.match(/resets?\s+in\s+([^\n,|]+)/i);
  const fiveHourResetMatch = fiveHourPart.match(/resets?\s+in\s+([^\n,|]+)/i);

  const weeklyResetText = weeklyResetMatch
    ? `Resets in ${weeklyResetMatch[1].trim()}`
    : (weeklyUsedPct === 0 ? '100% left (Weekly limit)' : null);

  const fiveHourResetText = fiveHourResetMatch
    ? `Resets in ${fiveHourResetMatch[1].trim()}`
    : (fiveHourUsedPct === 0 ? '100% left (5h limit)' : null);

  return {
    weeklyUsedPct,
    fiveHourUsedPct,
    weeklyResetText,
    fiveHourResetText
  };
}

function cleanResetLine(str) {
  if (!str) return null;
  return str
    .replace(/\s*\d{1,3}%\s*(?:used|left).*$/i, '')
    .replace(/\s*Use reset.*$/i, '')
    .replace(/\s*Reset for free.*$/i, '')
    .trim();
}

/**
 * Parses copied text or DOM innerText from Claude / Codex / Antigravity / Kimi usage pages
 * into normalized % used and reset text, isolating actual usage blocks from chat history.
 */
function parseUsagePageText(providerId, rawText) {
  const text = String(rawText || '');

  if (providerId === 'claude') {
    const yourUsageIdx = text.lastIndexOf('Your usage');
    const planIdx = text.lastIndexOf('Plan usage limits');
    const sessIdx = text.lastIndexOf('Current session');
    const startIdx = yourUsageIdx >= 0
      ? yourUsageIdx
      : (planIdx >= 0 ? planIdx : (sessIdx >= 0 ? Math.max(0, sessIdx - 80) : 0));
    const creditsIdx = text.indexOf('Usage credits', startIdx);
    const endIdx = creditsIdx > startIdx ? creditsIdx : startIdx + 1500;
    const scope = startIdx > 0 ? text.slice(startIdx, endIdx) : text;

    const usedMatches = [...scope.matchAll(/(\d{1,3})%\s*used/gi)].map(m => Number(m[1]));
    const summaryMatch = scope.match(/(On track\.[^\n]+|Fresh week\.[^\n]+)/i) || text.match(/(On track\.[^\n]+|Fresh week\.[^\n]+)/i);
    const sessionResetMatch = scope.match(/(Starts with your first message|Resets (?:in|at) [^\n]+)/i);
    const weekResetMatch = scope.match(/(Resets (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\n]+)/i);

    return {
      ok: usedMatches.length > 0,
      summary: summaryMatch ? summaryMatch[1].trim() : null,
      sessionUsedPct: usedMatches[0] ?? null,
      weeklyUsedPct: usedMatches[1] ?? null,
      fableUsedPct: usedMatches[2] ?? null,
      sessionResetText: sessionResetMatch ? cleanResetLine(sessionResetMatch[1]) : null,
      weeklyResetText: weekResetMatch ? cleanResetLine(weekResetMatch[1]) : null
    };
  }

  if (providerId === 'codex') {
    const lastHeaderIdx = text.lastIndexOf('5-hour limit');
    const scope = lastHeaderIdx >= 0 ? text.slice(Math.max(0, lastHeaderIdx - 40), lastHeaderIdx + 1200) : text;
    const weeklyIdx = scope.search(/Weekly limit/i);

    // Extract any Full reset (Weekly + 5 hr) tickets if present on the page
    const ticketMatches = [...text.matchAll(/(Full reset[^\n]*)\s*\n+\s*(Expires [^\n]+)/gi)];
    const resetsAvailable = ticketMatches.length > 0
      ? ticketMatches.map((m, idx) => ({
          id: `r${idx + 1}`,
          title: cleanResetLine(m[1]),
          expires: cleanResetLine(m[2])
        }))
      : null;

    if (weeklyIdx >= 0 && lastHeaderIdx >= 0) {
      const fiveHSec = scope.slice(0, weeklyIdx);
      const weekSec = scope.slice(weeklyIdx);
      const sLeft = fiveHSec.match(/(\d{1,3})%\s*left/i);
      const wLeft = weekSec.match(/(\d{1,3})%\s*left/i);
      const sReset = fiveHSec.match(/(Resets in [^\n]+)/i);
      const wReset = weekSec.match(/(Resets in [^\n]+)/i);
      const sessionUsedPct = sLeft ? Math.max(0, 100 - Number(sLeft[1])) : null;
      const weeklyUsedPct = wLeft ? Math.max(0, 100 - Number(wLeft[1])) : null;
      return {
        ok: sessionUsedPct !== null || weeklyUsedPct !== null,
        sessionUsedPct,
        weeklyUsedPct,
        sessionResetText: sReset ? cleanResetLine(sReset[1]) : (sessionUsedPct === 0 ? '100% left (5h limit)' : null),
        weeklyResetText: wReset ? cleanResetLine(wReset[1]) : null,
        resetsAvailable
      };
    }

    const leftMatches = [...scope.matchAll(/(\d{1,3})%\s*left/gi)].map(m => Number(m[1]));
    const resetMatches = [...scope.matchAll(/(Resets in [^\n]+)/gi)].map(m => cleanResetLine(m[1]));
    return {
      ok: leftMatches.length > 0,
      sessionUsedPct: leftMatches[0] !== undefined ? Math.max(0, 100 - leftMatches[0]) : null,
      weeklyUsedPct: leftMatches[1] !== undefined ? Math.max(0, 100 - leftMatches[1]) : null,
      sessionResetText: resetMatches[0] ?? null,
      weeklyResetText: resetMatches[1] ?? null,
      resetsAvailable
    };
  }

  if (providerId === 'antigravity') {
    const block = extractAntigravityPopoverBlock(text);
    const cgIdx = block.search(/Claude and GPT models/i);
    const argonIdx = block.search(/Gemini 4 Argon/i);

    if (cgIdx >= 0 && argonIdx > cgIdx) {
      const geminiSec = block.slice(0, cgIdx);
      const claudeGptSec = block.slice(cgIdx, argonIdx);
      const argonSec = block.slice(argonIdx, argonIdx + 140);

      const gemini = parseTwoTierAntigravitySection(geminiSec);
      const claudeGpt = parseTwoTierAntigravitySection(claudeGptSec);

      const argonLeftMatch = argonSec.match(/(\d{1,3})%\s*left/i);
      const argonWeeklyUsedPct = argonLeftMatch ? Math.min(100, Math.max(0, 100 - Number(argonLeftMatch[1]))) : null;
      const argonResetMatch = argonSec.match(/resets?\s+in\s+([^\n,|]+)/i);
      const argonWeeklyResetText = argonResetMatch
        ? `Resets in ${argonResetMatch[1].trim()}`
        : (argonWeeklyUsedPct === 0 ? '100% left (Weekly limit)' : null);

      return {
        ok: gemini.weeklyUsedPct !== null || claudeGpt.weeklyUsedPct !== null || argonWeeklyUsedPct !== null,
        geminiWeeklyUsedPct: gemini.weeklyUsedPct,
        gemini5hUsedPct: gemini.fiveHourUsedPct,
        claudeGptWeeklyUsedPct: claudeGpt.weeklyUsedPct,
        claudeGpt5hUsedPct: claudeGpt.fiveHourUsedPct,
        argonWeeklyUsedPct,
        geminiWeeklyResetText: gemini.weeklyResetText,
        gemini5hResetText: gemini.fiveHourResetText,
        claudeGptWeeklyResetText: claudeGpt.weeklyResetText,
        claudeGpt5hResetText: claudeGpt.fiveHourResetText,
        argonWeeklyResetText
      };
    }

    // Fallback for partial Antigravity snippet paste
    const leftMatches = [...block.matchAll(/(\d{1,3})%\s*left/gi)].map(m => Number(m[1]));
    const resetMatches = [...block.matchAll(/resets?\s+in\s+([^\n,|]+)/gi)].map(m => `Resets in ${m[1].trim()}`);
    return {
      ok: leftMatches.length > 0,
      geminiWeeklyUsedPct: leftMatches[0] !== undefined ? Math.max(0, 100 - leftMatches[0]) : null,
      gemini5hUsedPct: leftMatches[1] !== undefined ? Math.max(0, 100 - leftMatches[1]) : null,
      claudeGptWeeklyUsedPct: leftMatches[2] !== undefined ? Math.max(0, 100 - leftMatches[2]) : null,
      claudeGpt5hUsedPct: leftMatches[3] !== undefined ? Math.max(0, 100 - leftMatches[3]) : null,
      argonWeeklyUsedPct: leftMatches[4] !== undefined ? Math.max(0, 100 - leftMatches[4]) : null,
      geminiWeeklyResetText: resetMatches[0] ?? null,
      gemini5hResetText: resetMatches[1] ?? null,
      claudeGptWeeklyResetText: resetMatches[2] ?? null,
      claudeGpt5hResetText: leftMatches[3] === 100 ? '100% left (5h limit)' : null,
      argonWeeklyResetText: resetMatches[3] ?? null
    };
  }

  if (providerId === 'kimi') {
    const usedMatches = [...text.matchAll(/(\d{1,3})%\s*used/gi)].map(m => Number(m[1]));
    const leftMatches = [...text.matchAll(/(\d{1,3})%\s*left/gi)].map(m => Number(m[1]));
    const resetMatches = [...text.matchAll(/(Resets (?:in|at) [^\n]+)/gi)].map(m => cleanResetLine(m[1]));
    const sessionUsed = usedMatches[0] ?? (leftMatches[0] !== undefined ? Math.max(0, 100 - leftMatches[0]) : null);
    const weeklyUsed = usedMatches[1] ?? (leftMatches[1] !== undefined ? Math.max(0, 100 - leftMatches[1]) : null);
    return {
      ok: sessionUsed !== null || weeklyUsed !== null,
      sessionUsedPct: sessionUsed,
      weeklyUsedPct: weeklyUsed,
      sessionResetText: resetMatches[0] ?? null,
      weeklyResetText: resetMatches[1] ?? null
    };
  }

  return { ok: false };
}

module.exports = {
  parseRateLimitHeaders,
  parseUsagePageText,
  applyParsedUsageToState,
  syncClaudeAccount,
  syncCodexAccount,
  syncAntigravityAccount,
  syncKimiAccount,
  syncAllAccounts
};
