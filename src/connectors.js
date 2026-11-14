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

  accounts.providers.antigravity.connected = agyRes.connected || localScan.sources.antigravity.detected;
  accounts.providers.antigravity.lastSyncAt = nowIso;
  accounts.providers.antigravity.lastStatus = agyRes.ok
    ? agyRes.status
    : (localScan.sources.antigravity.detected ? `Local Watcher Active (${localScan.sources.antigravity.recent5hEvents} events/5h)` : agyRes.status);

  accounts.providers.claude.connected = claudeRes.connected || localScan.sources.claude.detected;
  accounts.providers.claude.lastSyncAt = nowIso;
  accounts.providers.claude.lastStatus = claudeRes.ok
    ? claudeRes.status
    : (localScan.sources.claude.detected ? `Local Watcher Active (${localScan.sources.claude.recent5hEvents} events/5h)` : claudeRes.status);

  accounts.providers.codex.connected = codexRes.connected || localScan.sources.codex.detected;
  accounts.providers.codex.lastSyncAt = nowIso;
  accounts.providers.codex.lastStatus = codexRes.ok
    ? codexRes.status
    : (localScan.sources.codex.detected ? `Local Watcher Active (${localScan.sources.codex.recent5hEvents} events/5h)` : codexRes.status);

  if (accounts.providers.kimi) {
    accounts.providers.kimi.connected = kimiRes.connected || localScan.sources.kimi?.detected;
    accounts.providers.kimi.lastSyncAt = nowIso;
    accounts.providers.kimi.lastStatus = kimiRes.ok
      ? kimiRes.status
      : (localScan.sources.kimi?.detected ? `Local Watcher Active (${localScan.sources.kimi.recent5hEvents} events/5h)` : kimiRes.status);
  }

  saveAccounts(accounts);

  // Apply real rate-limit headers if returned by upstream APIs
  // (Do NOT overwrite usedPct with rough local JSONL line-count estimates, which caused false 100% spikes)
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

/**
 * Parses copied text or DOM innerText from Claude / Codex / Antigravity usage pages
 * into normalized % used and reset text.
 */
function parseUsagePageText(providerId, rawText) {
  const text = String(rawText || '');

  if (providerId === 'claude') {
    const usedMatches = [...text.matchAll(/(\d{1,3})%\s*used/gi)].map(m => Number(m[1]));
    const summaryMatch = text.match(/(On track\.[^\n]+|Fresh week\.[^\n]+)/i);
    const sessionResetMatch = text.match(/(Starts with your first message|Resets at [^\n]+)/i);
    const weekResetMatch = text.match(/(Resets (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[^\n]+)/i);

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
    const leftMatches = [...text.matchAll(/(\d{1,3})%\s*left/gi)].map(m => Number(m[1]));
    const resetMatches = [...text.matchAll(/(Resets in [^\n]+)/gi)].map(m => m[1].trim());
    return {
      ok: leftMatches.length > 0,
      sessionUsedPct: leftMatches[0] !== undefined ? Math.max(0, 100 - leftMatches[0]) : null,
      weeklyUsedPct: leftMatches[1] !== undefined ? Math.max(0, 100 - leftMatches[1]) : null,
      sessionResetText: resetMatches[0] ?? null,
      weeklyResetText: resetMatches[1] ?? null
    };
  }

  if (providerId === 'antigravity') {
    const leftMatches = [...text.matchAll(/(\d{1,3})%\s*left/gi)].map(m => Number(m[1]));
    return {
      ok: leftMatches.length > 0,
      geminiWeeklyUsedPct: leftMatches[0] !== undefined ? Math.max(0, 100 - leftMatches[0]) : null,
      gemini5hUsedPct: leftMatches[1] !== undefined ? Math.max(0, 100 - leftMatches[1]) : null,
      claudeGptWeeklyUsedPct: leftMatches[2] !== undefined ? Math.max(0, 100 - leftMatches[2]) : null,
      claudeGpt5hUsedPct: leftMatches[3] !== undefined ? Math.max(0, 100 - leftMatches[3]) : null,
      argonWeeklyUsedPct: leftMatches[4] !== undefined ? Math.max(0, 100 - leftMatches[4]) : null
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
