// Sichere Bruecke zwischen Browser-Oberflaeche (ui.html) und Hauptprozess.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const send = (ch) => (...a) => ipcRenderer.send(ch, ...a);
const listen = (ch) => (fn) => ipcRenderer.on(ch, (_e, d) => fn(d));

contextBridge.exposeInMainWorld('net', {
  navigate: send('navigate'),
  newTab: send('new-tab'),
  closeTab: send('close-tab'),
  activateTab: send('activate-tab'),
  back: send('back'),
  forward: send('forward'),
  reload: send('reload'),
  toggleBookmark: send('toggle-bookmark'),
  openBookmark: send('open-bookmark'),
  bookmarkMenu: send('bookmark-menu'),
  mainMenu: send('main-menu'),
  openDownload: send('open-download'),
  win: send('win'),
  installUpdate: send('install-update'),
  ready: send('ui-ready'),
  onTabs: listen('tabs'),
  onBookmarks: listen('bookmarks'),
  onDownload: listen('download'),
  onBlocked: listen('blocked'),
  onAdblock: listen('adblock'),
  onUpdate: listen('update'),
  onVersions: listen('versions'),
  onFocusAddress: listen('focus-address'),
  onCookies: listen('cookies'),
  onCookieMode: listen('cookie-mode'),
  onExtensions: listen('extensions'),
});

// <browser-action-list> fuer die Symbole installierter Chrome-Erweiterungen
try {
  require('electron-chrome-extensions/browser-action').injectBrowserAction();
} catch (e) {
  console.error('browser-action', e);
}
