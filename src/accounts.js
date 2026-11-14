const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
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

module.exports = {
  loadAccounts,
  saveAccounts,
  getMaskedAccounts,
  updateAccountConfig,
  updateGlobalSettings,
  maskKey
};
