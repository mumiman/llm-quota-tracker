/**
 * Smart Model Switcher & Reset Advisor
 * Evaluates normalized % used across Antigravity, Claude, and Codex
 * and recommends the safest, highest-capability route.
 */

function evaluateRoutes(state, taskType = 'deep') {
  const candidates = [];

  // 1. Antigravity sub-pools
  const agy = state.providers.antigravity;
  for (const grp of agy.groups) {
    const peakUsed = Math.max(...grp.items.map(i => i.usedPct));
    const headroom = 100 - peakUsed;
    let score = headroom;
    if (grp.strengths[0] === taskType) score += 20;
    else if (grp.strengths.includes(taskType)) score += 10;
    if (peakUsed >= 75) score -= 45; // Avoid red zone!

    const cmd = grp.id === 'gemini_argon'
      ? 'agy config set --model gemini-4-argon'
      : grp.id === 'gemini_models'
        ? 'agy config set --model gemini-2.5-pro'
        : 'agy config set --model claude-sonnet-4';

    candidates.push({
      providerId: 'antigravity',
      subId: grp.id,
      label: `Antigravity → ${grp.name}`,
      usedPct: peakUsed,
      headroom,
      score,
      command: cmd,
      resetHint: grp.items[grp.items.length - 1].resetText
    });
  }

  // 2. Claude
  const claude = state.providers.claude;
  const claudePeak = Math.max(...claude.metrics.map(m => m.usedPct));
  const claudeHeadroom = 100 - claudePeak;
  let claudeScore = claudeHeadroom;
  if (claude.strengths[0] === taskType) claudeScore += 20;
  else if (claude.strengths.includes(taskType)) claudeScore += 10;
  if (claudePeak >= 75) claudeScore -= 50;

  candidates.push({
    providerId: 'claude',
    subId: 'claude_default',
    label: 'Claude (Current Session)',
    usedPct: claudePeak,
    headroom: claudeHeadroom,
    score: claudeScore,
    command: claude.cliCommand,
    resetHint: claude.metrics[0].resetText
  });

  // 3. Codex
  const codex = state.providers.codex;
  const codexPeak = Math.max(...codex.limits.map(l => l.usedPct));
  const codexHeadroom = 100 - codexPeak;
  let codexScore = codexHeadroom;
  if (codex.strengths[0] === taskType) codexScore += 20;
  else if (codex.strengths.includes(taskType)) codexScore += 10;
  if (codexPeak >= 75) codexScore -= 45;

  candidates.push({
    providerId: 'codex',
    subId: 'codex_default',
    label: 'Codex (CLI / Agent)',
    usedPct: codexPeak,
    headroom: codexHeadroom,
    score: codexScore,
    command: codex.cliCommand,
    resetHint: codex.limits[1].resetText
  });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Generate Smart Reset Advisor alerts
  const alerts = [];
  if (agy.groups[1].items[1].usedPct >= 75) {
    alerts.push({
      severity: 'critical',
      provider: 'antigravity',
      message: `Antigravity (Claude & GPT models) is at ${agy.groups[1].items[1].usedPct}% used — switch to ${best.label} to avoid lockout.`
    });
  }
  if (claudePeak >= 75) {
    alerts.push({
      severity: 'critical',
      provider: 'claude',
      message: `Claude quota is at ${claudePeak}% used (${claude.metrics[0].resetText}). Pause Claude and route to ${best.label}.`
    });
  }
  const fableMetric = claude.metrics.find(m => m.id === 'fable');
  if (fableMetric && fableMetric.usedPct >= 75) {
    alerts.push({
      severity: 'warning',
      provider: 'claude',
      message: `Claude Fable limit is at ${fableMetric.usedPct}% used (${fableMetric.subtitle || 'Up to 50% of weekly limit'}). Consider switching to ${best.label}.`
    });
  }
  if (codexPeak >= 75 && codex.resetsAvailable.length > 0) {
    const healthyAlternative = candidates.find(c => c.providerId !== 'codex' && c.usedPct < 50);
    if (healthyAlternative) {
      alerts.push({
        severity: 'advice',
        provider: 'codex',
        message: `Codex is at ${codexPeak}% used, but save your ${codex.resetsAvailable.length} Full Reset ticket(s)! Switch to ${healthyAlternative.label} (${healthyAlternative.usedPct}% used) first.`
      });
    } else {
      alerts.push({
        severity: 'warning',
        provider: 'codex',
        message: `All providers are running hot. Consider using 1 of ${codex.resetsAvailable.length} Codex Full Reset tickets (${codex.resetsAvailable[0].expires}).`
      });
    }
  }

  return {
    recommended: best,
    ranked: candidates,
    alerts,
    reason: `Selected ${best.label} (${best.usedPct}% used / ${best.headroom}% headroom) as the optimal route for "${taskType}" tasks.`
  };
}

function generateHandoffPrompt({ fromProvider, toProvider, taskSummary, currentFiles }) {
  const filesList = currentFiles && currentFiles.trim()
    ? currentFiles.split(',').map(f => `- \`${f.trim()}\``).join('\n')
    : '- (No specific files listed)';

  return `# Context Handoff: ${fromProvider} → ${toProvider}

## Why Switching
Quota on **${fromProvider}** is approaching its limit. Continuing the task seamlessly on **${toProvider}**.

## Current Task & Goal
${taskSummary || 'Continue implementing and verifying the current feature without losing context.'}

## Active Files
${filesList}

## Instructions for ${toProvider}
1. Review the active files listed above before making edits.
2. Continue directly from the current state — do not re-scaffold already completed parts.
3. Run tests/verification after applying the next changes.`;
}

module.exports = {
  evaluateRoutes,
  generateHandoffPrompt
};
