const fs = require('fs');
const os = require('os');
const path = require('path');

function walkFiles(dir, maxDepth = 4, maxFiles = 200, depth = 0, out = []) {
  if (depth > maxDepth || out.length >= maxFiles) return out;
  try {
    if (!fs.existsSync(dir)) return out;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walkFiles(full, maxDepth, maxFiles, depth + 1, out);
      } else if (ent.isFile() && (ent.name.endsWith('.jsonl') || ent.name.endsWith('.json'))) {
        out.push(full);
      }
    }
  } catch {
    // Ignore permission errors
  }
  return out;
}

function inspectProviderDir(dirPath) {
  const exists = fs.existsSync(dirPath);
  if (!exists) {
    return {
      detected: false,
      entriesCount: 0,
      recent5hEvents: 0,
      recent7dEvents: 0,
      status: 'Directory not found on this machine'
    };
  }

  const now = Date.now();
  const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const files = walkFiles(dirPath);
  let recent5hEvents = 0;
  let recent7dEvents = 0;

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < sevenDaysAgo) continue;

      if (file.endsWith('transcript.jsonl') || file.endsWith('.jsonl')) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        // Count USER_INPUT or message lines if JSONL has timestamps, else approximate by mtime
        let countedFromLines = false;
        for (const line of lines.slice(-150)) {
          try {
            const obj = JSON.parse(line);
            const ts = obj.created_at || obj.timestamp || obj.ts;
            if (ts) {
              const t = new Date(ts).getTime();
              if (!Number.isNaN(t)) {
                countedFromLines = true;
                if (t >= sevenDaysAgo) recent7dEvents++;
                if (t >= fiveHoursAgo) recent5hEvents++;
              }
            }
          } catch {
            // ignore malformed line
          }
        }
        if (!countedFromLines && lines.length > 0) {
          recent7dEvents += Math.min(lines.length, 20);
          if (stat.mtimeMs >= fiveHoursAgo) recent5hEvents += Math.min(lines.length, 10);
        }
      } else {
        recent7dEvents++;
        if (stat.mtimeMs >= fiveHoursAgo) recent5hEvents++;
      }
    } catch {
      // ignore read errors
    }
  }

  return {
    detected: true,
    entriesCount: files.length,
    recent5hEvents,
    recent7dEvents,
    status: `Local logs detected (${files.length} files, ${recent5hEvents} recent 5h events)`
  };
}

function scanLocalEnvironments() {
  const home = os.homedir();
  const agy = inspectProviderDir(path.join(home, '.gemini'));
  const claude = inspectProviderDir(path.join(home, '.claude'));
  const codex = inspectProviderDir(path.join(home, '.codex'));

  return {
    scannedAt: new Date().toISOString(),
    sources: {
      antigravity: { path: '~/.gemini', ...agy },
      claude: { path: '~/.claude', ...claude },
      codex: { path: '~/.codex', ...codex }
    }
  };
}

module.exports = { scanLocalEnvironments, inspectProviderDir };
