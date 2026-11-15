const { loadAccounts, saveAccounts } = require('./accounts');
const { loadState, saveState } = require('./store');
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
 * Syncs all configured accounts (API keys + local ~/.gemini, ~/.claude, ~/.codex, ~/.kimi logs)
 * and updates quota-state.json when real metrics are returned.
 */
async function syncAllAccounts({ applyLocalEstimates = true } = {}) {
  const accounts = loadAccounts();
  const state = loadState();
  const localScan = scanLocalEnvironments();

  const [agyRes, claudeRes, codexRes, kimiRes] = await Promise.all([
    syncAntigravityAccount(accounts.providers.antigravity),
    syncClaudeAccount(accounts.providers.claude),
    syncCodexAccount(accounts.providers.codex),
    syncKimiAccount(accounts.providers.kimi)
  ]);

  const nowIso = new Date().toISOString();

  function updateProviderSyncMeta(provId, apiRes, scanSource) {
    const p = accounts.providers[provId];
    if (!p) return;
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

  saveState(state);

  return {
    syncedAt: nowIso,
    results: {
      antigravity: agyRes,
      claude: claudeRes,
      codex: codexRes,
      kimi: kimiRes
    },
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

/**
 * Parses copied text or DOM innerText from Claude / Codex / Antigravity / Kimi usage pages
 * into normalized % used and reset text, isolating actual usage blocks from chat history.
 */
function parseUsagePageText(providerId, rawText) {
  const text = String(rawText || '');

  if (providerId === 'claude') {
    const planIdx = text.lastIndexOf('Plan usage limits');
    const sessIdx = text.lastIndexOf('Current session');
    const startIdx = planIdx >= 0 ? planIdx : (sessIdx >= 0 ? Math.max(0, sessIdx - 30) : 0);
    const scope = startIdx > 0 ? text.slice(startIdx, startIdx + 1400) : text;
    const usedMatches = [...scope.matchAll(/(\d{1,3})%\s*used/gi)].map(m => Number(m[1]));
    const summaryMatch = text.match(/(On track\.[^\n]+|Fresh week\.[^\n]+)/i);
    const sessionResetMatch = scope.match(/(Starts with your first message|Resets (?:in|at) [^\n]+)/i);
    const weekResetMatch = scope.match(/(Resets (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\n]+)/i);

    return {
      ok: usedMatches.length > 0,
      summary: summaryMatch ? summaryMatch[1].trim() : null,
      sessionUsedPct: usedMatches[0] ?? null,
      weeklyUsedPct: usedMatches[1] ?? null,
      fableUsedPct: usedMatches[2] ?? null,
      sessionResetText: sessionResetMatch ? sessionResetMatch[1].trim() : null,
      weeklyResetText: weekResetMatch ? weekResetMatch[1].trim() : null
    };
  }

  if (providerId === 'codex') {
    const lastHeaderIdx = text.lastIndexOf('5-hour limit');
    const scope = lastHeaderIdx >= 0 ? text.slice(Math.max(0, lastHeaderIdx - 40), lastHeaderIdx + 1200) : text;
    const weeklyIdx = scope.search(/Weekly limit/i);

    // Extract any Full reset (Weekly + 5 hr) tickets if present on the page
    const ticketMatches = [...text.matchAll(/(Full reset[^\n]*)\s*\n\s*(Expires [^\n]+)/gi)];
    const resetsAvailable = ticketMatches.length > 0
      ? ticketMatches.map((m, idx) => ({
          id: `r${idx + 1}`,
          title: m[1].trim(),
          expires: m[2].trim()
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
        sessionResetText: sReset ? sReset[1].trim() : (sessionUsedPct === 0 ? '100% left (5h limit)' : null),
        weeklyResetText: wReset ? wReset[1].trim() : null,
        resetsAvailable
      };
    }

    const leftMatches = [...scope.matchAll(/(\d{1,3})%\s*left/gi)].map(m => Number(m[1]));
    const resetMatches = [...scope.matchAll(/(Resets in [^\n]+)/gi)].map(m => m[1].trim());
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
    const resetMatches = [...text.matchAll(/(Resets (?:in|at) [^\n]+)/gi)].map(m => m[1].trim());
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
  syncClaudeAccount,
  syncCodexAccount,
  syncAntigravityAccount,
  syncKimiAccount,
  syncAllAccounts
};
