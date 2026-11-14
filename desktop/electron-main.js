const path = require('path');
const { createServer } = require('../server');

// Optional Electron Desktop / Menu Bar wrapper
// Run with: npx electron desktop/electron-main.js
let app, BrowserWindow, Tray, Menu;
try {
  ({ app, BrowserWindow, Tray, Menu } = require('electron'));
} catch {
  console.error('Electron is not installed. Run "npm install --save-dev electron" to launch the Desktop Tray app, or run "npm start" for the Web App.');
  process.exit(1);
}

let mainWindow = null;
let tray = null;
let server = null;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 760,
    show: true,
    title: 'LLM Quota Tracker & Smart Switcher',
    webPreferences: {
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

app.whenReady().then(() => {
  server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    createWindow(port);

    // System Tray / Menu Bar integration
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
