# Install & test

**Build**
```
npm i
npm run build
```
# Install into vault

Create folder: `<your-vault>/.obsidian/plugins/obsidian-inline-base64/`

Copy: `manifest.json`, `main.js`, styles.css into that folder.

**Enable**

`Obsidian` → `Settings` → `Community Plugins` → “Inline Images as Base64”.

**Try it**

Copy an image (e.g., from your OS screenshot tool).

Paste into a note. You should see:
```md
![screenshot](data:image/png;base64,iVBORw0K...)
```