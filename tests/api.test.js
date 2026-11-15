const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-tracker-test-'));
process.env.QUOTA_DATA_DIR = tempDataDir;

const { createServer } = require('../server');
const { parseRateLimitHeaders } = require('../src/connectors');

let server;
let baseUrl;
let mockUpstream;
let mockUrl;

test.before(async () => {
  // Start mock upstream server simulating Anthropic & OpenAI APIs + rate-limit headers
  mockUpstream = http.createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers['x-api-key'] === 'sk-ant-test-key-123456') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'anthropic-ratelimit-requests-limit': '100',
        'anthropic-ratelimit-requests-remaining': '20',
        'anthropic-ratelimit-requests-reset': '2026-11-14T20:30:00Z'
      });
      return res.end(JSON.stringify({ data: [{ id: 'claude-3-7-sonnet-latest' }] }));
    }

    if (req.url === '/v1/models' && req.headers['authorization'] === 'Bearer sk-openai-test-key-123456') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '60',
        'x-ratelimit-reset-requests': '4h12m'
      });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }));
    }

    // Simulate 429 on Anthropic /v1/messages to test automatic failover
    if (req.url === '/v1/messages') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
    }

    // Simulate 200 on OpenAI /v1/chat/completions as failover target
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '55',
        'x-ratelimit-reset-requests': '4h10m'
      });
      return res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        choices: [{ message: { role: 'assistant', content: 'Failover succeeded!' } }]
      }));
    }

    res.writeHead(404);
    res.end('{}');
  });

  await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => mockUpstream.close(resolve));
  try {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
});

test('GET /api/health returns ok', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('POST /api/demo/reset and GET /api/state return normalized % used structure', async () => {
  await fetch(`${baseUrl}/api/demo/reset`, { method: 'POST' });
  const res = await fetch(`${baseUrl}/api/state?taskType=deep`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.state.providers.codex.resetsAvailable.length, 3);
  assert.ok(data.routing.recommended.usedPct < 75);
});

test('parseRateLimitHeaders accurately parses Anthropic and OpenAI headers', () => {
  const claudeParsed = parseRateLimitHeaders({
    'anthropic-ratelimit-requests-limit': '100',
    'anthropic-ratelimit-requests-remaining': '25',
    'anthropic-ratelimit-requests-reset': '2026-11-14T20:30:00Z'
  }, 'claude');
  assert.equal(claudeParsed.hasHeaders, true);
  assert.equal(claudeParsed.usedPct, 75);

  const codexParsed = parseRateLimitHeaders({
    'x-ratelimit-limit-requests': '200',
    'x-ratelimit-remaining-requests': '100',
    'x-ratelimit-reset-requests': '2h30m'
  }, 'codex');
  assert.equal(codexParsed.hasHeaders, true);
  assert.equal(codexParsed.usedPct, 50);
  assert.equal(codexParsed.resetText, 'Resets in 2h30m');
});

test('POST /api/accounts masks keys and POST /api/sync reads real upstream headers', async () => {
  await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'claude',
      apiKey: 'sk-ant-test-key-123456',
      baseUrl: mockUrl
    })
  });
  await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'codex',
      apiKey: 'sk-openai-test-key-123456',
      baseUrl: mockUrl
    })
  });

  const accRes = await fetch(`${baseUrl}/api/accounts`);
  const accData = await accRes.json();
  assert.equal(accData.accounts.providers.claude.hasApiKey, true);
  assert.match(accData.accounts.providers.claude.apiKeyMasked, /^sk-ant••••••3456$/);

  const syncRes = await fetch(`${baseUrl}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ applyLocalEstimates: false })
  });
  assert.equal(syncRes.status, 200);
  const syncData = await syncRes.json();
  assert.equal(syncData.results.claude.ok, true);
  assert.equal(syncData.results.codex.ok, true);
  // 80% used from mock Anthropic header (100 limit - 20 remaining)
  assert.equal(syncData.state.providers.claude.metrics[0].usedPct, 80);
  // 40% used from mock OpenAI header (100 limit - 60 remaining)
  assert.equal(syncData.state.providers.codex.limits[0].usedPct, 40);
});

test('POST /proxy/v1/chat/completions auto-fails over on 429 from Claude to Codex and updates quota', async () => {
  const res = await fetch(`${baseUrl}/proxy/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-quota-provider': 'claude'
    },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Test failover' }]
    })
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-quota-routed-provider'), 'codex');
  assert.equal(res.headers.get('x-quota-fallback-used'), 'true');
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'Failover succeeded!');
});

test('POST /api/reset consumes Codex Full Reset ticket and restores limits to 0% used', async () => {
  const res = await fetch(`${baseUrl}/api/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'codex', ticketId: 'r1' })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.appliedTicket.id, 'r1');
  assert.equal(data.state.providers.codex.limits[0].usedPct, 0);
});

test('POST /api/handoff generates structured Context Handoff markdown', async () => {
  const res = await fetch(`${baseUrl}/api/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromProvider: 'Claude',
      toProvider: 'Antigravity (Gemini 4 Argon)',
      taskSummary: 'Build quota tracker API',
      currentFiles: 'server.js, src/router.js'
    })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.prompt, /Claude → Antigravity/);
});

test('POST /api/accounts/auto-detect detects local CLI sessions', async () => {
  const res = await fetch(`${baseUrl}/api/accounts/auto-detect`, { method: 'POST' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.detected.antigravity);
  assert.ok(data.detected.claude);
  assert.ok(data.detected.codex);
});

test('POST /api/accounts/session-sync updates usage from browser login session', async () => {
  const res = await fetch(`${baseUrl}/api/accounts/session-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'claude',
      sessionUsedPct: 44,
      weeklyUsedPct: 12,
      sessionResetText: 'Resets at 9:00 PM',
      accountLabel: 'Claude.ai Web Session'
    })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.state.providers.claude.metrics[0].usedPct, 44);
  assert.equal(data.state.providers.claude.metrics[1].usedPct, 12);
  assert.equal(data.accounts.providers.claude.connected, true);
});

test('POST /api/accounts/parse-usage parses exact Claude Pro usage page text accurately', async () => {
  const sampleClaudePage = `Your usage Pro
On track. You should reach the Nov 20 reset with room to spare.
Current session
Starts with your first message
0% used
This week
Resets Friday 11:00 PM
11% used
Fable
Up to 50% of your weekly limit
Resets Friday 11:00 PM
14% used`;

  const res = await fetch(`${baseUrl}/api/accounts/parse-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'claude', rawText: sampleClaudePage })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.state.providers.claude.metrics[0].usedPct, 0);
  assert.equal(data.state.providers.claude.metrics[0].resetText, 'Starts with your first message');
  assert.equal(data.state.providers.claude.metrics[1].usedPct, 11);
  assert.equal(data.state.providers.claude.metrics[1].resetText, 'Resets Friday 11:00 PM');
  const fable = data.state.providers.claude.metrics.find(m => m.id === 'fable');
  assert.ok(fable);
  assert.equal(fable.usedPct, 14);
});

test('POST /api/reset resets Claude Fable quota individually without clearing This week', async () => {
  const res = await fetch(`${baseUrl}/api/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'claude', groupId: 'fable' })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const fable = data.state.providers.claude.metrics.find(m => m.id === 'fable');
  const week = data.state.providers.claude.metrics.find(m => m.id === 'week');
  assert.equal(fable.usedPct, 0);
  assert.equal(week.usedPct, 11);
});

test('Kimi (kimi.ai) supports usage tracking, reset, and parse-usage', async () => {
  const usageRes = await fetch(`${baseUrl}/api/usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'kimi', amount: 30 })
  });
  assert.equal(usageRes.status, 200);
  const usageData = await usageRes.json();
  assert.equal(usageData.state.providers.kimi.limits[0].usedPct, 42);

  const resetRes = await fetch(`${baseUrl}/api/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'kimi', groupId: '5h' })
  });
  assert.equal(resetRes.status, 200);
  const resetData = await resetRes.json();
  assert.equal(resetData.state.providers.kimi.limits[0].usedPct, 0);

  const parseRes = await fetch(`${baseUrl}/api/accounts/parse-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'kimi',
      rawText: 'Kimi Thinking 28% used\nResets in 3h 10m\nWeekly 15% used\nResets in 4d 5h'
    })
  });
  assert.equal(parseRes.status, 200);
  const parseData = await parseRes.json();
  assert.equal(parseData.state.providers.kimi.limits[0].usedPct, 28);
  assert.equal(parseData.state.providers.kimi.limits[1].usedPct, 15);
});

test('Antigravity parse-usage converts % left to % used and preserves reset countdowns', async () => {
  const sampleAgy = `Usage
Gemini Models
Weekly limit 96% left
Resets in 6d 19h
5h limit 87% left
Resets in <1m
Claude and GPT models
Weekly limit 22% left
Resets in 1d 11h
5h limit 100% left
Gemini 4 Argon 98% left
Weekly limit, resets in 6d 18h`;

  const res = await fetch(`${baseUrl}/api/accounts/parse-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'antigravity', rawText: sampleAgy })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const agy = data.state.providers.antigravity;
  assert.equal(agy.groups[0].items[0].usedPct, 13);
  assert.equal(agy.groups[0].items[0].resetText, 'Resets in <1m');
  assert.equal(agy.groups[0].items[1].usedPct, 4);
  assert.equal(agy.groups[0].items[1].resetText, 'Resets in 6d 19h');
  assert.equal(agy.groups[1].items[1].usedPct, 78);
  assert.equal(agy.groups[1].items[1].resetText, 'Resets in 1d 11h');
  assert.equal(agy.groups[1].items[0].usedPct, 0);
  assert.equal(agy.groups[1].items[0].resetText, '100% left (5h limit)');
  assert.equal(agy.groups[2].items[0].usedPct, 2);
  assert.equal(agy.groups[2].items[0].resetText, 'Resets in 6d 18h');
});

test('Antigravity parse-usage isolates real Usage popover from noisy chat history and updates 100% left reset text', async () => {
  const noisyFullPageWithChatHistory = `
    Chat Conversation History:
    | Gemini Models (Weekly) | 96% left | 4% used | Resets in 6d 19h |
    | Gemini Models (5h limit) | 87% left | 13% used | Resets in <1m |
    | Claude and GPT models | 22% left | 78% used | Resets in 1d 11h |
    | Gemini 4 Argon | 98% left | 2% used | Resets in 6d 18h |

    Usage
    Gemini Models
    96% left
    Weekly limit
    Resets in 6d 18h
    98% left
    5h limit
    Resets in 4h 44m
    Claude and GPT models
    22% left
    Weekly limit
    Resets in 1d 11h
    100% left
    5h limit
    Gemini 4 Argon
    93% left
    Weekly limit, resets in 6d 18h
  `;

  const res = await fetch(`${baseUrl}/api/accounts/parse-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'antigravity', rawText: noisyFullPageWithChatHistory })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const agy = data.state.providers.antigravity;

  // Must match the real Usage popover at the bottom, NOT the chat history table at the top!
  assert.equal(agy.groups[0].items[0].usedPct, 2);
  assert.equal(agy.groups[0].items[0].resetText, 'Resets in 4h 44m');
  assert.equal(agy.groups[0].items[1].usedPct, 4);
  assert.equal(agy.groups[0].items[1].resetText, 'Resets in 6d 18h');
  assert.equal(agy.groups[1].items[0].usedPct, 0);
  assert.equal(agy.groups[1].items[0].resetText, '100% left (5h limit)');
  assert.equal(agy.groups[1].items[1].usedPct, 78);
  assert.equal(agy.groups[1].items[1].resetText, 'Resets in 1d 11h');
  assert.equal(agy.groups[2].items[0].usedPct, 7);
  assert.equal(agy.groups[2].items[0].resetText, 'Resets in 6d 18h');
});

test('Codex parse-usage extracts 5-hour limit, Weekly limit, and Full reset tickets from usage page', async () => {
  const codexPageText = `
    Plan limits
    Shared across Codex, Work, Workspace Agents, and ChatGPT for Excel.
    5-hour limit
    Resets in 5h 1m
    100% left
    Weekly limit
    Resets in 4d 16h
    45% left
    Usage limit resets
    Available 2 History
    Full reset (Weekly + 5 hr)
    Expires Dec 1, 2:22 AM GMT+7
    Full reset (Weekly + 5 hr)
    Expires Dec 2, 4:04 AM GMT+7
  `;

  const res = await fetch(`${baseUrl}/api/accounts/parse-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'codex', rawText: codexPageText })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const codex = data.state.providers.codex;
  assert.equal(codex.limits[0].usedPct, 0);
  assert.equal(codex.limits[0].resetText, 'Resets in 5h 1m');
  assert.equal(codex.limits[1].usedPct, 55);
  assert.equal(codex.limits[1].resetText, 'Resets in 4d 16h');
  assert.equal(codex.resetsAvailable.length, 2);
  assert.equal(codex.resetsAvailable[0].expires, 'Expires Dec 1, 2:22 AM GMT+7');
});

test('POST /api/accounts/open-app returns ok and platform metadata', async () => {
  const res = await fetch(`${baseUrl}/api/accounts/open-app`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'antigravity' })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.providerId, 'antigravity');
});

test('Parses exact claude.ai/new#settings/usage modal and chatgpt.com/settings/usage?tab=overview layouts', async () => {
  const claudeModalText = `
    Settings
    Account
    Billing
    Usage
    Your usage Pro
    On track. You should reach Friday's reset with room to spare.
    Current session 13% used
    Resets at 1:10 PM
    This week 13% used
    Resets Friday 11:00 PM
    Fable 14% used
    Up to 50% of your weekly limit
    Resets Friday 11:00 PM
    Limit resets 2 available
    Full reset
    Expires Dec 11, 5:00 AM GMT+7 Reset for free
    Fable reset
    Expires Nov 17, 2:59 PM GMT+7 Reset for free
    Usage credits $19.83
  `;

  const cRes = await fetch(`${baseUrl}/api/accounts/parse-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'claude', rawText: claudeModalText })
  });
  assert.equal(cRes.status, 200);
  const cData = await cRes.json();
  const claude = cData.state.providers.claude;
  assert.equal(claude.summary, "On track. You should reach Friday's reset with room to spare.");
  assert.equal(claude.metrics[0].usedPct, 13);
  assert.equal(claude.metrics[0].resetText, 'Resets at 1:10 PM');
  assert.equal(claude.metrics[1].usedPct, 13);
  assert.equal(claude.metrics[1].resetText, 'Resets Friday 11:00 PM');
  assert.equal(claude.metrics[2].usedPct, 14);

  const codexOverviewText = `
    Usage
    Track your usage and check your limits
    Overview Analytics
    Your plan
    ChatGPT Plus $20 / month
    Plan limits
    Shared across Codex, Work, Workspace Agents, and ChatGPT for Excel.
    5-hour limit
    Resets in 1h 35m 91% left
    Weekly limit
    Resets in 3d 20h 44% left
    Usage limit resets
    Available 3 History
    Full reset (Weekly + 5 hr)
    Expires Dec 1, 2:22 AM GMT+7 Use reset
    Full reset (Weekly + 5 hr)
    Expires Dec 2, 4:04 AM GMT+7 Use reset
    Full reset (Weekly + 5 hr)
    Expires Dec 13, 3:51 AM GMT+7 Use reset
  `;

  const xRes = await fetch(`${baseUrl}/api/accounts/parse-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'codex', rawText: codexOverviewText })
  });
  assert.equal(xRes.status, 200);
  const xData = await xRes.json();
  const codex = xData.state.providers.codex;
  assert.equal(codex.limits[0].usedPct, 9);
  assert.equal(codex.limits[0].resetText, 'Resets in 1h 35m');
  assert.equal(codex.limits[1].usedPct, 56);
  assert.equal(codex.limits[1].resetText, 'Resets in 3d 20h');
  assert.equal(codex.resetsAvailable.length, 3);
  assert.equal(codex.resetsAvailable[0].expires, 'Expires Dec 1, 2:22 AM GMT+7');
});
