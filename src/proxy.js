const { loadAccounts } = require('./accounts');
const { loadState, saveState, recordUsage } = require('./store');
const { evaluateRoutes } = require('./router');
const { parseRateLimitHeaders } = require('./connectors');

async function forwardToProvider(providerId, accConfig, payload) {
  if (providerId === 'codex') {
    const url = `${accConfig.baseUrl}/v1/chat/completions`;
    const body = {
      model: payload.model && payload.model !== 'auto' ? payload.model : 'gpt-4.1-mini',
      messages: payload.messages || [{ role: 'user', content: 'Hello' }],
      max_tokens: payload.max_tokens || 512,
      temperature: payload.temperature ?? 0.7
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accConfig.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, headers: res.headers, data };
  }

  if (providerId === 'claude') {
    const url = `${accConfig.baseUrl}/v1/messages`;
    const systemMsg = (payload.messages || []).find(m => m.role === 'system')?.content;
    const nonSystem = (payload.messages || []).filter(m => m.role !== 'system');
    const body = {
      model: payload.model && payload.model.startsWith('claude') ? payload.model : 'claude-3-7-sonnet-latest',
      max_tokens: payload.max_tokens || 512,
      messages: nonSystem.length > 0 ? nonSystem : [{ role: 'user', content: 'Hello' }]
    };
    if (systemMsg) body.system = systemMsg;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': accConfig.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const raw = await res.json().catch(() => ({}));
    // Normalize Anthropic response to OpenAI chat completion shape if successful
    let data = raw;
    if (res.ok && Array.isArray(raw.content)) {
      data = {
        id: raw.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        model: raw.model || body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: raw.content.map(c => c.text || '').join('')
          },
          finish_reason: raw.stop_reason || 'stop'
        }],
        usage: raw.usage || {}
      };
    }
    return { status: res.status, headers: res.headers, data };
  }

  if (providerId === 'antigravity') {
    // Google Gemini OpenAI-compatible endpoint
    const url = `${accConfig.baseUrl}/v1beta/openai/chat/completions`;
    const body = {
      model: payload.model && payload.model.startsWith('gemini') ? payload.model : 'gemini-2.5-flash',
      messages: payload.messages || [{ role: 'user', content: 'Hello' }],
      max_tokens: payload.max_tokens || 512
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accConfig.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, headers: res.headers, data };
  }

  throw new Error(`Unsupported provider: ${providerId}`);
}

async function handleProxyChatCompletion(payload, forcedProvider = null) {
  const accounts = loadAccounts();
  let state = loadState();
  const routing = evaluateRoutes(state, state.taskType || 'deep');

  // Build ordered list of connected providers (those with API keys)
  const connectedRanked = [];
  const seen = new Set();

  if (forcedProvider && accounts.providers[forcedProvider]?.apiKey) {
    connectedRanked.push(forcedProvider);
    seen.add(forcedProvider);
  }

  for (const r of routing.ranked) {
    if (!seen.has(r.providerId) && accounts.providers[r.providerId]?.apiKey) {
      connectedRanked.push(r.providerId);
      seen.add(r.providerId);
    }
  }

  if (connectedRanked.length === 0) {
    return {
      status: 400,
      headers: {},
      body: {
        error: {
          message: 'No connected API keys found. Open "Connect Accounts" in the dashboard to add an Anthropic, OpenAI, or Gemini API key.',
          type: 'quota_tracker_no_accounts'
        }
      }
    };
  }

  let fallbackUsed = false;
  let lastResult = null;

  for (let i = 0; i < connectedRanked.length; i++) {
    const providerId = connectedRanked[i];
    const accConfig = accounts.providers[providerId];

    try {
      const result = await forwardToProvider(providerId, accConfig, payload);
      lastResult = { providerId, ...result };

      // Update live quota state from real HTTP rate-limit headers
      const parsed = parseRateLimitHeaders(result.headers, providerId);
      if (parsed.hasHeaders) {
        if (providerId === 'claude') {
          state.providers.claude.metrics[0].usedPct = parsed.usedPct;
          if (parsed.resetText) state.providers.claude.metrics[0].resetText = parsed.resetText;
        } else if (providerId === 'codex') {
          state.providers.codex.limits[0].usedPct = parsed.usedPct;
          if (parsed.resetText) state.providers.codex.limits[0].resetText = parsed.resetText;
        }
        state = saveState(state);
      } else if (result.status >= 200 && result.status < 300) {
        state = recordUsage(state, { providerId, groupId: 'gemini_models', amount: 2 });
      }

      // If 429 Rate Limit, mark at 100% and auto-fallback to next provider!
      if (result.status === 429) {
        if (providerId === 'claude') state.providers.claude.metrics[0].usedPct = 100;
        if (providerId === 'codex') state.providers.codex.limits[0].usedPct = 100;
        if (providerId === 'antigravity') state.providers.antigravity.groups[0].items[0].usedPct = 100;
        state = saveState(state);
        fallbackUsed = true;
        continue;
      }

      return {
        status: result.status,
        headers: {
          'x-quota-routed-provider': providerId,
          'x-quota-fallback-used': String(fallbackUsed)
        },
        body: result.data
      };
    } catch (err) {
      lastResult = { providerId, status: 502, data: { error: { message: err.message } } };
      fallbackUsed = true;
    }
  }

  return {
    status: lastResult?.status || 502,
    headers: { 'x-quota-fallback-used': String(fallbackUsed) },
    body: lastResult?.data || { error: { message: 'All connected providers failed or hit rate limits' } }
  };
}

module.exports = { handleProxyChatCompletion };
