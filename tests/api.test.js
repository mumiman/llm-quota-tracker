const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
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
