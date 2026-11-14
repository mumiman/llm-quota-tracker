const path = require('path');
const { createServer } = require('../server');

// Electron Desktop / Menu Bar wrapper with native "Sign in with Claude / ChatGPT / Google"
// Run with: npx electron desktop/electron-main.js
let app, BrowserWindow, Tray, Menu, ipcMain;
try {
  ({ app, BrowserWindow, Tray, Menu, ipcMain } = require('electron'));
} catch {
  console.error('Electron is not installed. Run "npm install --save-dev electron" to launch the Desktop Tray app, or run "npm start" for the Web App.');
  process.exit(1);
}

let mainWindow = null;
let tray = null;
let server = null;
let serverPort = 3456;

const PROVIDER_AUTH_URLS = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/codex/settings/usage',
  antigravity: 'https://aistudio.google.com/'
};

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 780,
    show: true,
    title: 'LLM Quota Tracker & Smart Switcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function setupAuthIpc() {
  ipcMain.handle('oauth-signin', async (_event, providerId) => {
    const targetUrl = PROVIDER_AUTH_URLS[providerId];
    if (!targetUrl) return { ok: false, error: 'Unknown provider' };

    return new Promise((resolve) => {
      const authWin = new BrowserWindow({
        width: 960,
        height: 720,
        parent: mainWindow,
        title: `Sign in to ${providerId.toUpperCase()} — Close window once usage page loads`,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      authWin.loadURL(targetUrl);

      let latestParsed = null;

      // Periodically inspect loaded usage page text for % used / % left
      const pollTimer = setInterval(async () => {
        if (authWin.isDestroyed()) return;
        try {
          const text = await authWin.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
          if (!text) return;

          if (providerId === 'claude') {
            const matches = [...text.matchAll(/(\d{1,3})%\s*used/gi)].map(m => Number(m[1]));
            if (matches.length > 0) {
              latestParsed = {
                providerId: 'claude',
                sessionUsedPct: matches[0],
                weeklyUsedPct: matches[1] ?? undefined,
                accountLabel: 'Claude.ai Web Session'
              };
            }
          } else if (providerId === 'codex') {
            const matches = [...text.matchAll(/(\d{1,3})%\s*left/gi)].map(m => 100 - Number(m[1]));
            if (matches.length > 0) {
              latestParsed = {
                providerId: 'codex',
                sessionUsedPct: matches[0],
                weeklyUsedPct: matches[1] ?? undefined,
                accountLabel: 'ChatGPT / Codex Web Session'
              };
            }
          } else if (providerId === 'antigravity') {
            if (text.toLowerCase().includes('api key') || text.toLowerCase().includes('gemini')) {
              latestParsed = {
                providerId: 'antigravity',
                accountLabel: 'Google AI / Antigravity Session'
              };
            }
          }
        } catch {
          // Ignore navigation errors
        }
      }, 2000);

      authWin.on('closed', async () => {
        clearInterval(pollTimer);
        if (latestParsed) {
          try {
            await fetch(`http://127.0.0.1:${serverPort}/api/accounts/session-sync`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(latestParsed)
            });
          } catch {
            // ignore
          }
          resolve({ ok: true, synced: latestParsed });
        } else {
          // Still mark as browser session opened
          resolve({ ok: true, synced: null });
        }
      });
    });
  });
}

app.whenReady().then(() => {
  server = createServer();
  server.listen(0, '127.0.0.1', () => {
    serverPort = server.address().port;
    setupAuthIpc();
    createWindow(serverPort);

    try {
      tray = new Tray(path.join(__dirname, 'tray-icon.png'));
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Quota Tracker', click: () => mainWindow.show() },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
      ]);
      tray.setToolTip('LLM Quota Tracker');
      tray.setContextMenu(contextMenu);
      tray.on('click', () => {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
      });
    } catch {
      // Tray icon optional
    }
  });
});

app.on('before-quit', () => {
  if (server) server.close();
});
