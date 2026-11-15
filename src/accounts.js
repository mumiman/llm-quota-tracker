const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.QUOTA_DATA_DIR || path.join(__dirname, '..', 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function getDefaultAccounts() {
  return {
    autoSyncSeconds: 60,
    autoFallbackThreshold: 85,
    providers: {
      antigravity: {
        mode: 'local_and_api',
        apiKey: process.env.GEMINI_API_KEY || '',
        baseUrl: 'https://generativelanguage.googleapis.com',
        connected: Boolean(process.env.GEMINI_API_KEY),
        lastSyncAt: null,
        lastStatus: 'Not synced yet',
        accountLabel: 'Google / Antigravity'
      },
      claude: {
        mode: 'local_and_api',
        apiKey: process.env.ANTHROPIC_API_KEY || '',
        baseUrl: 'https://api.anthropic.com',
        connected: Boolean(process.env.ANTHROPIC_API_KEY),
        lastSyncAt: null,
        lastStatus: 'Not synced yet',
        accountLabel: 'Anthropic / Claude'
      },
      codex: {
        mode: 'local_and_api',
        apiKey: process.env.OPENAI_API_KEY || '',
        adminKey: process.env.OPENAI_ADMIN_KEY || '',
        baseUrl: 'https://api.openai.com',
        connected: Boolean(process.env.OPENAI_API_KEY),
        lastSyncAt: null,
        lastStatus: 'Not synced yet',
        accountLabel: 'OpenAI / Codex'
      },
      kimi: {
        mode: 'local_and_api',
        apiKey: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '',
        baseUrl: 'https://api.moonshot.ai',
        connected: Boolean(process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY),
        lastSyncAt: null,
        lastStatus: 'Not synced yet',
        accountLabel: 'Moonshot / Kimi.ai'
      }
    }
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadAccounts() {
  ensureDataDir();
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    const def = getDefaultAccounts();
    saveAccounts(def);
    return def;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (
      !process.env.QUOTA_DATA_DIR &&
      (parsed?.providers?.claude?.apiKey === 'sk-ant-test-key-123456' ||
        parsed?.providers?.codex?.apiKey === 'sk-openai-test-key-123456' ||
        String(parsed?.providers?.claude?.baseUrl || '').includes('127.0.0.1'))
    ) {
      const def = getDefaultAccounts();
      saveAccounts(def);
      return def;
    }
    return parsed;
  } catch {
    const def = getDefaultAccounts();
    saveAccounts(def);
    return def;
  }
}

function saveAccounts(accounts) {
  ensureDataDir();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  return accounts;
}

function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 10) return '••••••••';
  return `${key.slice(0, 6)}••••••${key.slice(-4)}`;
}

function getMaskedAccounts() {
  const acc = loadAccounts();
  const masked = JSON.parse(JSON.stringify(acc));
  for (const key of Object.keys(masked.providers)) {
    const p = masked.providers[key];
    p.hasApiKey = Boolean(p.apiKey);
    p.apiKeyMasked = maskKey(p.apiKey);
    delete p.apiKey;
    if ('adminKey' in p) {
      p.hasAdminKey = Boolean(p.adminKey);
      p.adminKeyMasked = maskKey(p.adminKey);
      delete p.adminKey;
    }
  }
  return masked;
}

function updateAccountConfig(providerId, updates) {
  const acc = loadAccounts();
  if (!acc.providers[providerId]) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  const target = acc.providers[providerId];
  if (typeof updates.apiKey === 'string') {
    target.apiKey = updates.apiKey.trim();
    target.connected = Boolean(target.apiKey);
  }
  if (typeof updates.adminKey === 'string' && providerId === 'codex') {
    target.adminKey = updates.adminKey.trim();
  }
  if (typeof updates.baseUrl === 'string' && updates.baseUrl.trim()) {
    target.baseUrl = updates.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof updates.mode === 'string') {
    target.mode = updates.mode;
  }
  if (typeof updates.accountLabel === 'string' && updates.accountLabel.trim()) {
    target.accountLabel = updates.accountLabel.trim();
  }
  return saveAccounts(acc);
}

function updateGlobalSettings({ autoSyncSeconds, autoFallbackThreshold }) {
  const acc = loadAccounts();
  if (typeof autoSyncSeconds === 'number' && autoSyncSeconds >= 10) {
    acc.autoSyncSeconds = autoSyncSeconds;
  }
  if (typeof autoFallbackThreshold === 'number' && autoFallbackThreshold >= 50 && autoFallbackThreshold <= 99) {
    acc.autoFallbackThreshold = autoFallbackThreshold;
  }
  return saveAccounts(acc);
}

function autoDetectLocalLogins() {
  const os = require('os');
  const home = os.homedir();
  const acc = loadAccounts();
  const detected = {};

  // 1. Claude Code CLI (~/.claude/.credentials.json or ~/.claude.json or env)
  const claudeCreds = path.join(home, '.claude', '.credentials.json');
  const claudeCfg = path.join(home, '.claude.json');
  const claudeDir = path.join(home, '.claude');
  if (process.env.ANTHROPIC_API_KEY) {
    acc.providers.claude.apiKey = process.env.ANTHROPIC_API_KEY;
    acc.providers.claude.connected = true;
    acc.providers.claude.mode = 'api_key';
    acc.providers.claude.lastStatus = 'Connected via ANTHROPIC_API_KEY env';
    detected.claude = 'env_api_key';
  } else if (fs.existsSync(claudeCreds) || fs.existsSync(claudeCfg) || fs.existsSync(claudeDir)) {
    acc.providers.claude.connected = true;
    acc.providers.claude.mode = 'cli_oauth';
    acc.providers.claude.lastStatus = 'Connected via Claude Code CLI session (~/.claude)';
    detected.claude = 'cli_session';
  } else {
    detected.claude = 'not_found';
  }

  // 2. Codex CLI (~/.codex/auth.json or ~/.codex or env)
  const codexAuth = path.join(home, '.codex', 'auth.json');
  const codexDir = path.join(home, '.codex');
  if (process.env.OPENAI_API_KEY) {
    acc.providers.codex.apiKey = process.env.OPENAI_API_KEY;
    acc.providers.codex.connected = true;
    acc.providers.codex.mode = 'api_key';
    acc.providers.codex.lastStatus = 'Connected via OPENAI_API_KEY env';
    detected.codex = 'env_api_key';
  } else if (fs.existsSync(codexAuth)) {
    try {
      const authData = JSON.parse(fs.readFileSync(codexAuth, 'utf8'));
      if (authData.OPENAI_API_KEY) {
        acc.providers.codex.apiKey = authData.OPENAI_API_KEY;
      }
    } catch {
      // ignore parse error
    }
    acc.providers.codex.connected = true;
    acc.providers.codex.mode = 'cli_oauth';
    acc.providers.codex.lastStatus = 'Connected via Codex CLI login (~/.codex/auth.json)';
    detected.codex = 'cli_session';
  } else if (fs.existsSync(codexDir)) {
    acc.providers.codex.connected = true;
    acc.providers.codex.mode = 'cli_oauth';
    acc.providers.codex.lastStatus = 'Connected via Codex CLI directory (~/.codex)';
    detected.codex = 'cli_session';
  } else {
    detected.codex = 'not_found';
  }

  // 3. Antigravity / Google Gemini (~/.gemini or gcloud ADC or env)
  const geminiDir = path.join(home, '.gemini');
  const gcloudAdc = path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
  if (process.env.GEMINI_API_KEY) {
    acc.providers.antigravity.apiKey = process.env.GEMINI_API_KEY;
    acc.providers.antigravity.connected = true;
    acc.providers.antigravity.mode = 'api_key';
    acc.providers.antigravity.lastStatus = 'Connected via GEMINI_API_KEY env';
    detected.antigravity = 'env_api_key';
  } else if (fs.existsSync(geminiDir) || fs.existsSync(gcloudAdc)) {
    acc.providers.antigravity.connected = true;
    acc.providers.antigravity.mode = 'cli_oauth';
    acc.providers.antigravity.lastStatus = fs.existsSync(geminiDir)
      ? 'Connected via Antigravity / Gemini session (~/.gemini)'
      : 'Connected via Google Cloud ADC (~/.config/gcloud)';
    detected.antigravity = 'cli_session';
  } else {
    detected.antigravity = 'not_found';
  }

  // 4. Kimi.ai (~/.kimi or MOONSHOT_API_KEY / KIMI_API_KEY)
  const kimiDir = path.join(home, '.kimi');
  const kimiKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
  if (kimiKey) {
    acc.providers.kimi.apiKey = kimiKey;
    acc.providers.kimi.connected = true;
    acc.providers.kimi.mode = 'api_key';
    acc.providers.kimi.lastStatus = 'Connected via MOONSHOT_API_KEY / KIMI_API_KEY env';
    detected.kimi = 'env_api_key';
  } else if (fs.existsSync(kimiDir)) {
    acc.providers.kimi.connected = true;
    acc.providers.kimi.mode = 'cli_oauth';
    acc.providers.kimi.lastStatus = 'Connected via Kimi CLI session (~/.kimi)';
    detected.kimi = 'cli_session';
  } else {
    detected.kimi = 'not_found';
  }

  saveAccounts(acc);
  return { detected, accounts: getMaskedAccounts() };
}

module.exports = {
  loadAccounts,
  saveAccounts,
  getMaskedAccounts,
  updateAccountConfig,
  updateGlobalSettings,
  autoDetectLocalLogins,
  maskKey
};
