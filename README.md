# Cyberdeck Netrunner

Chromium-Browser im Cyberpunk-Stil (Electron) – Teil der Cyberdeck-Reihe (Player, Launcher).

- Tabs, Adresszeile `> run` (URL oder DuckDuckGo-Suche), Lesezeichenleiste, Downloads
- Neuer-Tab-Seite im HUD-Stil (Uhr, Suche, Schnellzugriffe)
- Werbe- und Tracker-Blocker (Ghostery-Engine)
- Auto-Update: Linux (AppImage) + Windows (Installer) über GitHub-Releases
- Täglicher Chromium-Check (`.github/workflows/chromium-update.yml`): neues Electron → neue Version → Release

## Tastenkürzel
Strg+T neuer Tab · Strg+W schließen · Strg+Tab wechseln · Strg+L Adresse · Strg+R neu laden ·
Strg+D Lesezeichen · Alt+←/→ zurück/vor · Strg +/−/0 Zoom · F12 Entwicklertools

## Entwickeln
    npm install
    npm start                 # Dev-Start
    npm run dist:linux        # AppImage nach dist/
