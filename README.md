# Cyberdeck Netrunner

Cyberpunk-styled Chromium browser (Electron) – part of the Cyberdeck series (Player, Launcher).

- Tabs, `> run` address bar (URL or DuckDuckGo search), bookmarks bar, downloads
- HUD-style new tab page (clock, search, quick links)
- Ad and tracker blocker (Ghostery engine, incl. cookie notice lists)
- Automatically rejects cookie banners (DuckDuckGo Autoconsent) – can be turned off in the menu
- Self-signed certificates (FortiGate, routers, lab servers): warning page with details, "Proceed anyway" only by click, the exception applies only to exactly that certificate (optionally permanent, removable in menu ≡)
- Import from Firefox (menu ≡ → Import from Firefox): bookmarks and cookies (stay logged in), no passwords
- Chrome extensions from the Chrome Web Store (electron-chrome-extensions / -web-store), icons in the toolbar, management in menu ≡ → Extensions
- Auto-update: Linux (AppImage) + Windows (installer) via GitHub Releases
- Daily Chromium check (`.github/workflows/chromium-update.yml`): new Electron → new version → release

## Shortcuts
Ctrl+T new tab · Ctrl+W close · Ctrl+Tab switch · Ctrl+L address · Ctrl+R reload ·
Ctrl+D bookmark · Alt+←/→ back/forward · Ctrl +/−/0 zoom · F12 developer tools

## Development
    npm install
    npm start                 # dev start
    npm run dist:linux        # AppImage into dist/

## License
GPL-3.0 (because of electron-chrome-extensions).
