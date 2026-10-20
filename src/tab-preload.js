// Preload fuer jeden Tab (und jedes iframe): Cookie-Banner automatisch ablehnen.
// Die Autoconsent-Engine (DuckDuckGo) laeuft in einer eigenen, isolierten Welt –
// die Webseite selbst kommt an die Bruecke nicht heran.
'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const WORLD = 1077;
if (/^https?:$/.test(location.protocol)) {
  ipcRenderer.invoke('ac-script').then((script) => {
    if (!script) return; // Cookie-Blocker ausgeschaltet
    contextBridge.exposeInIsolatedWorld(WORLD, 'autoconsentSendMessage', (msg) => {
      ipcRenderer.send('ac-msg', msg);
    });
    ipcRenderer.on('ac-reply', (_e, msg) => {
      webFrame.executeJavaScriptInIsolatedWorld(WORLD, [
        { code: `window.autoconsentReceiveMessage && window.autoconsentReceiveMessage(${JSON.stringify(msg)})` },
      ]);
    });
    webFrame.executeJavaScriptInIsolatedWorld(WORLD, [{ code: script }]);
  }).catch(() => {});
}
