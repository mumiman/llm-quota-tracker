const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'quota-state.json');

function getInitialState() {
  return {
    selectedProvider: 'antigravity',
    taskType: 'deep',
    providers: {
      antigravity: {
        id: 'antigravity',
        name: 'Antigravity',
        summary: 'Claude & GPT models at 78% weekly usage.',
        cliCommand: 'agy config set --model gemini-4-argon',
        groups: [
          {
            id: 'gemini_models',
            name: 'Gemini Models',
            strengths: ['agentic', 'fast', 'deep'],
            items: [
              { id: 'g_5h', label: 'Current session (5h limit)', usedPct: 13, resetText: 'Resets in <1m', windowHours: 5 },
              { id: 'g_weekly', label: 'This week (Weekly limit)', usedPct: 4, resetText: 'Resets in 6d 19h', windowHours: 168 }
            ]
          },
          {
            id: 'claude_gpt_models',
            name: 'Claude and GPT models',
            strengths: ['deep', 'agentic'],
            items: [
              { id: 'cg_5h', label: 'Current session (5h limit)', usedPct: 0, resetText: 'Resets in 5h 00m', windowHours: 5 },
              { id: 'cg_weekly', label: 'This week (Weekly limit)', usedPct: 78, resetText: 'Resets in 1d 11h', windowHours: 168 }
            ]
          },
          {
            id: 'gemini_argon',
            name: 'Gemini 4 Argon',
            strengths: ['agentic', 'deep'],
            items: [
              { id: 'argon_weekly', label: 'This week (Weekly limit)', usedPct: 2, resetText: 'Resets in 6d 18h', windowHours: 168 }
            ]
          }
        ]
      },
      claude: {
        id: 'claude',
        name: 'Claude',
        summary: 'On track. You should reach the Nov 20 reset with room to spare.',
        cliCommand: 'export ANTHROPIC_MODEL="claude-3-7-sonnet-latest"',
        strengths: ['deep', 'agentic'],
        metrics: [
          { id: 'session', label: 'Current session', usedPct: 0, resetText: 'Starts with your first message', countdown: '5h 00m' },
          { id: 'week', label: 'This week', usedPct: 11, resetText: 'Resets Friday 11:00 PM', countdown: '5d 21h' },
          { id: 'fable', label: 'Fable', subtitle: 'Up to 50% of your weekly limit', usedPct: 14, resetText: 'Resets Friday 11:00 PM', countdown: '5d 21h' }
        ]
      },
      codex: {
        id: 'codex',
        name: 'Codex',
        summary: 'Shared across Codex, Work, Workspace Agents, and ChatGPT for Excel.',
        cliCommand: 'codex --model o3-mini',
        strengths: ['fast', 'deep'],
        limits: [
          { id: '5h', label: 'Current session (5-hour limit)', usedPct: 0, resetText: 'Resets in 5h 1m' },
          { id: 'weekly', label: 'This week (Weekly limit)', usedPct: 55, resetText: 'Resets in 4d 16h' }
        ],
        resetsAvailable: [
          { id: 'r1', title: 'Full reset (Weekly + 5 hr)', expires: 'Expires Dec 1, 2:22 AM GMT+7', expiresIso: '2026-12-01T02:22:00+07:00' },
          { id: 'r2', title: 'Full reset (Weekly + 5 hr)', expires: 'Expires Dec 2, 4:04 AM GMT+7', expiresIso: '2026-12-02T04:04:00+07:00' },
          { id: 'r3', title: 'Full reset (Weekly + 5 hr)', expires: 'Expires Dec 13, 3:51 AM GMT+7', expiresIso: '2026-12-13T03:51:00+07:00' }
        ],
        resetsHistory: [
          { id: 'h1', title: 'Full reset (Weekly + 5 hr)', usedAt: 'Used Nov 10, 9:15 PM GMT+7' }
        ]
      },
      kimi: {
        id: 'kimi',
        name: 'Kimi (kimi.ai)',
        summary: 'Kimi k2 / Thinking & Long-Context quota.',
        cliCommand: 'kimi --model kimi-k2-thinking',
        strengths: ['deep', 'agentic', 'fast'],
        limits: [
          { id: '5h', label: 'Current session (5h / Thinking)', usedPct: 12, resetText: 'Resets in 4h 20m', countdown: '4h 20m' },
          { id: 'weekly', label: 'This week (Weekly limit)', usedPct: 24, resetText: 'Resets in 5d 12h', countdown: '5d 12h' }
        ]
      }
    },
    history: [
      { ts: '09:00', antigravity: 65, claude: 10, codex: 40, kimi: 5 },
      { ts: '10:00', antigravity: 70, claude: 18, codex: 45, kimi: 10 },
      { ts: '11:00', antigravity: 74, claude: 25, codex: 50, kimi: 18 },
      { ts: '12:00', antigravity: 78, claude: 14, codex: 55, kimi: 24 }
    ]
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const init = getInitialState();
    saveState(init);
    return init;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    const init = getInitialState();
    saveState(init);
    return init;
  }
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function resetDemoState() {
  const init = getInitialState();
  return saveState(init);
}

function recordUsage(state, { providerId, groupId, amount = 10 }) {
  if (providerId === 'antigravity') {
    const grp = state.providers.antigravity.groups.find(g => g.id === groupId) || state.providers.antigravity.groups[0];
    grp.items.forEach(item => {
      item.usedPct = Math.min(100, Math.max(0, item.usedPct + amount));
    });
  } else if (providerId === 'claude') {
    state.providers.claude.metrics[0].usedPct = Math.min(100, state.providers.claude.metrics[0].usedPct + amount);
    state.providers.claude.metrics[1].usedPct = Math.min(100, state.providers.claude.metrics[1].usedPct + Math.max(1, Math.round(amount * 0.35)));
    const fable = state.providers.claude.metrics.find(m => m.id === 'fable');
    if (fable) {
      fable.usedPct = Math.min(100, fable.usedPct + Math.max(1, Math.round(amount * 0.45)));
    }
    state.providers.claude.summary = `Fresh week. ${state.providers.claude.metrics[1].usedPct}% of your weekly limit used.`;
  } else if (providerId === 'codex') {
    state.providers.codex.limits[0].usedPct = Math.min(100, state.providers.codex.limits[0].usedPct + amount);
    state.providers.codex.limits[1].usedPct = Math.min(100, state.providers.codex.limits[1].usedPct + Math.max(1, Math.round(amount * 0.5)));
  } else if (providerId === 'kimi') {
    state.providers.kimi.limits[0].usedPct = Math.min(100, state.providers.kimi.limits[0].usedPct + amount);
    state.providers.kimi.limits[1].usedPct = Math.min(100, state.providers.kimi.limits[1].usedPct + Math.max(1, Math.round(amount * 0.4)));
  }

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const agyPeak = Math.max(
    ...state.providers.antigravity.groups.flatMap(g => g.items.map(i => i.usedPct))
  );
  const claudePeak = Math.max(...state.providers.claude.metrics.map(m => m.usedPct));
  const codexPeak = Math.max(...state.providers.codex.limits.map(l => l.usedPct));
  const kimiPeak = state.providers.kimi ? Math.max(...state.providers.kimi.limits.map(l => l.usedPct)) : 0;

  state.history.push({
    ts: `${hh}:${mm}`,
    antigravity: agyPeak,
    claude: claudePeak,
    codex: codexPeak,
    kimi: kimiPeak
  });
  if (state.history.length > 16) state.history.shift();

  return saveState(state);
}

function applyReset(state, { providerId, groupId, ticketId }) {
  if (providerId === 'codex') {
    const codex = state.providers.codex;
    const idx = ticketId
      ? codex.resetsAvailable.findIndex(r => r.id === ticketId)
      : 0;
    if (idx === -1 || codex.resetsAvailable.length === 0) {
      return { error: 'No available Codex reset tickets remaining', state };
    }
    const [removed] = codex.resetsAvailable.splice(idx, 1);
    codex.resetsHistory.unshift({
      id: removed.id,
      title: removed.title,
      usedAt: `Used ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (Restored 5-hr & Weekly to 0% used)`
    });
    codex.limits.forEach(l => { l.usedPct = 0; });
    return { state: saveState(state), appliedTicket: removed };
  }

  if (providerId === 'antigravity') {
    const grp = state.providers.antigravity.groups.find(g => g.id === groupId);
    if (grp) {
      grp.items.forEach(it => { it.usedPct = 0; });
    } else {
      state.providers.antigravity.groups.forEach(g => g.items.forEach(it => { it.usedPct = 0; }));
    }
    return { state: saveState(state) };
  }

  if (providerId === 'claude') {
    if (groupId === 'session') {
      state.providers.claude.metrics[0].usedPct = 0;
    } else if (groupId === 'week') {
      state.providers.claude.metrics[1].usedPct = 0;
      state.providers.claude.summary = 'Fresh week. 0% of your weekly limit used.';
    } else if (groupId === 'fable') {
      const fable = state.providers.claude.metrics.find(m => m.id === 'fable');
      if (fable) fable.usedPct = 0;
    } else {
      state.providers.claude.metrics.forEach(m => { m.usedPct = 0; });
      state.providers.claude.summary = 'Fresh week. 0% of your weekly limit used.';
    }
    return { state: saveState(state) };
  }

  if (providerId === 'kimi') {
    if (groupId === '5h' || groupId === 'weekly') {
      const target = state.providers.kimi.limits.find(l => l.id === groupId);
      if (target) target.usedPct = 0;
    } else {
      state.providers.kimi.limits.forEach(l => { l.usedPct = 0; });
    }
    return { state: saveState(state) };
  }

  return { error: 'Unknown provider', state };
}

module.exports = {
  getInitialState,
  loadState,
  saveState,
  resetDemoState,
  recordUsage,
  applyReset
};
