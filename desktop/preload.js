const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAuth', {
  isDesktop: true,
  signIn: (providerId) => ipcRenderer.invoke('oauth-signin', providerId)
});
