const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadState, saveState, resetDemoState, appendHistorySnapshot, recordUsage, applyReset } = require('./src/store');
const { evaluateRoutes, generateHandoffPrompt } = require('./src/router');
const { scanLocalEnvironments } = require('./src/scanner');
const { getMaskedAccounts, updateAccountConfig, updateGlobalSettings, autoDetectLocalLogins, loadAccounts, saveAccounts } = require('./src/accounts');
const { syncAllAccounts, parseUsagePageText, applyParsedUsageToState } = require('./src/connectors');
const { handleProxyChatCompletion } = require('./src/proxy');

const PUBLIC_DIR = path.join(__dirname, 'public');

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-quota-provider'
      });
      return res.end();
    }

    try {
      // Health check
      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, service: 'llm-quota-tracker', timestamp: new Date().toISOString() });
      }

      // Full state + smart routing evaluation + masked accounts
      if (req.method === 'GET' && pathname === '/api/state') {
        const state = loadState();
        const taskType = url.searchParams.get('taskType') || state.taskType || 'deep';
        const routing = evaluateRoutes(state, taskType);
        const accounts = getMaskedAccounts();
        return sendJson(res, 200, { state, routing, accounts });
      }

      // Get masked accounts
      if (req.method === 'GET' && pathname === '/api/accounts') {
        return sendJson(res, 200, { accounts: getMaskedAccounts() });
      }

      // Update account API key / baseUrl / global settings
      if (req.method === 'POST' && pathname === '/api/accounts') {
        const body = await readBody(req);
        if (body.providerId) {
          updateAccountConfig(body.providerId, body);
        }
        if (body.autoSyncSeconds || body.autoFallbackThreshold) {
          updateGlobalSettings(body);
        }
        return sendJson(res, 200, { ok: true, accounts: getMaskedAccounts() });
      }

      // 1-Click Auto-Detect CLI logins (~/.claude, ~/.codex, ~/.gemini, env vars)
      if (req.method === 'POST' && pathname === '/api/accounts/auto-detect') {
        const { detected, accounts } = autoDetectLocalLogins();
        const syncResult = await syncAllAccounts({ applyLocalEstimates: true });
        const routing = evaluateRoutes(syncResult.state, syncResult.state.taskType || 'deep');
        return sendJson(res, 200, {
          ok: true,
          detected,
          accounts: getMaskedAccounts(),
          state: syncResult.state,
          routing,
          localScan: syncResult.localScan
        });
      }

      // Sync usage directly from Electron BrowserWindow OAuth login or Bookmarklet
      if (req.method === 'POST' && pathname === '/api/accounts/session-sync') {
        const body = await readBody(req);
        const { providerId, sessionUsedPct, weeklyUsedPct, sessionResetText, weeklyResetText, accountLabel } = body;
        if (!providerId) {
          return sendJson(res, 400, { error: 'providerId is required' });
        }

        const acc = loadAccounts();
        if (acc.providers[providerId]) {
          acc.providers[providerId].connected = true;
          acc.providers[providerId].mode = 'browser_oauth';
          acc.providers[providerId].lastSyncAt = new Date().toISOString();
          acc.providers[providerId].lastStatus = `Signed in via Web Session (${accountLabel || 'Browser OAuth'})`;
          saveAccounts(acc);
        }

        const state = loadState();
        if (providerId === 'claude') {
          if (typeof sessionUsedPct === 'number') state.providers.claude.metrics[0].usedPct = Math.min(100, Math.max(0, sessionUsedPct));
          if (typeof weeklyUsedPct === 'number') {
            state.providers.claude.metrics[1].usedPct = Math.min(100, Math.max(0, weeklyUsedPct));
            state.providers.claude.summary = `Fresh week. ${state.providers.claude.metrics[1].usedPct}% of your weekly limit used.`;
          }
          if (sessionResetText) state.providers.claude.metrics[0].resetText = sessionResetText;
          if (weeklyResetText) state.providers.claude.metrics[1].resetText = weeklyResetText;
        } else if (providerId === 'codex') {
          if (typeof sessionUsedPct === 'number') state.providers.codex.limits[0].usedPct = Math.min(100, Math.max(0, sessionUsedPct));
          if (typeof weeklyUsedPct === 'number') state.providers.codex.limits[1].usedPct = Math.min(100, Math.max(0, weeklyUsedPct));
          if (sessionResetText) state.providers.codex.limits[0].resetText = sessionResetText;
          if (weeklyResetText) state.providers.codex.limits[1].resetText = weeklyResetText;
        } else if (providerId === 'antigravity') {
          if (typeof sessionUsedPct === 'number') state.providers.antigravity.groups[0].items[0].usedPct = Math.min(100, Math.max(0, sessionUsedPct));
          if (typeof weeklyUsedPct === 'number') state.providers.antigravity.groups[1].items[1].usedPct = Math.min(100, Math.max(0, weeklyUsedPct));
        } else if (providerId === 'kimi' && state.providers.kimi) {
          if (typeof sessionUsedPct === 'number') state.providers.kimi.limits[0].usedPct = Math.min(100, Math.max(0, sessionUsedPct));
          if (typeof weeklyUsedPct === 'number') state.providers.kimi.limits[1].usedPct = Math.min(100, Math.max(0, weeklyUsedPct));
          if (sessionResetText) state.providers.kimi.limits[0].resetText = sessionResetText;
          if (weeklyResetText) state.providers.kimi.limits[1].resetText = weeklyResetText;
        }

        appendHistorySnapshot(state);
        saveState(state);
        const routing = evaluateRoutes(state, state.taskType || 'deep');
        return sendJson(res, 200, { ok: true, state, routing, accounts: getMaskedAccounts() });
      }

      // Focus or launch native Desktop App (e.g. Antigravity.app on macOS)
      if (req.method === 'POST' && pathname === '/api/accounts/open-app') {
        const body = await readBody(req);
        const { providerId } = body;
        const acc = loadAccounts();
        const webUrl = acc.providers?.[providerId]?.webUrl || null;
        if (process.platform === 'darwin' && providerId === 'antigravity') {
          const { execFile } = require('child_process');
          execFile('open', ['-a', 'Antigravity'], () => {});
        }
        return sendJson(res, 200, { ok: true, providerId, platform: process.platform, webUrl });
      }

      // Parse copied usage page text (e.g. Ctrl+A, Ctrl+C from claude.ai/settings/usage or chatgpt.com)
      if (req.method === 'POST' && pathname === '/api/accounts/parse-usage') {
        const body = await readBody(req);
        const { providerId, rawText } = body;
        if (!providerId || !rawText) {
          return sendJson(res, 400, { error: 'providerId and rawText are required' });
        }
        const parsed = parseUsagePageText(providerId, rawText);
        if (!parsed.ok) {
          return sendJson(res, 422, { error: 'Could not find usage percentages (% used / % left) in pasted text' });
        }

        const acc = loadAccounts();
        const state = loadState();
        applyParsedUsageToState(providerId, parsed, body, state, acc);
        saveAccounts(acc);
        appendHistorySnapshot(state);
        saveState(state);
        const routing = evaluateRoutes(state, state.taskType || 'deep');
        return sendJson(res, 200, { ok: true, parsed, state, routing, accounts: getMaskedAccounts() });
      }

      // Sync real accounts & local watchers now
      if (req.method === 'POST' && pathname === '/api/sync') {
        const body = await readBody(req);
        const syncResult = await syncAllAccounts({
          applyLocalEstimates: body.applyLocalEstimates !== false
        });
        const routing = evaluateRoutes(syncResult.state, syncResult.state.taskType || 'deep');
        return sendJson(res, 200, {
          ...syncResult,
          routing,
          accounts: getMaskedAccounts()
        });
      }

      // Unified OpenAI-compatible Local LLM Proxy with Auto-Fallback
      if (req.method === 'POST' && pathname === '/proxy/v1/chat/completions') {
        const body = await readBody(req);
        const forcedProvider = req.headers['x-quota-provider'] || null;
        const result = await handleProxyChatCompletion(body, forcedProvider);
        return sendJson(res, result.status, result.body, result.headers);
      }

      // Record simulated or real usage
      if (req.method === 'POST' && pathname === '/api/usage') {
        const body = await readBody(req);
        const state = loadState();
        const updated = recordUsage(state, {
          providerId: body.providerId,
          groupId: body.groupId,
          amount: typeof body.amount === 'number' ? body.amount : 10
        });
        if (body.taskType) {
          updated.taskType = body.taskType;
          saveState(updated);
        }
        const routing = evaluateRoutes(updated, updated.taskType);
        return sendJson(res, 200, { state: updated, routing });
      }

      // Apply reset (Codex ticket or window reset)
      if (req.method === 'POST' && pathname === '/api/reset') {
        const body = await readBody(req);
        const state = loadState();
        const result = applyReset(state, {
          providerId: body.providerId,
          groupId: body.groupId,
          ticketId: body.ticketId
        });
        if (result.error) {
          return sendJson(res, 400, { error: result.error, state: result.state });
        }
        const routing = evaluateRoutes(result.state, result.state.taskType);
        return sendJson(res, 200, { state: result.state, routing, appliedTicket: result.appliedTicket || null });
      }

      // Scan local ~/.gemini, ~/.claude, ~/.codex
      if (req.method === 'POST' && pathname === '/api/scan') {
        const scanResult = scanLocalEnvironments();
        return sendJson(res, 200, scanResult);
      }

      // Generate Context Handoff Prompt
      if (req.method === 'POST' && pathname === '/api/handoff') {
        const body = await readBody(req);
        const prompt = generateHandoffPrompt({
          fromProvider: body.fromProvider || 'Claude',
          toProvider: body.toProvider || 'Antigravity (Gemini 4 Argon)',
          taskSummary: body.taskSummary || '',
          currentFiles: body.currentFiles || ''
        });
        return sendJson(res, 200, { prompt });
      }

      // Reset demo data back to initial
      if (req.method === 'POST' && pathname === '/api/demo/reset') {
        const state = resetDemoState();
        const routing = evaluateRoutes(state, state.taskType);
        return sendJson(res, 200, { state, routing });
      }

      // Serve static frontend
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const htmlPath = path.join(PUBLIC_DIR, 'index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      return sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });
}

if (require.main === module) {
  const PORT = process.env.PORT || 3456;
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`LLM Quota Tracker running at http://localhost:${PORT}`);
  });
}

module.exports = { createServer };
