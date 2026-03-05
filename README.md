# Ordinator (Chrome Extension)

Chrome extension that organizes tabs by workspace in a full dashboard browser tab.

## Implemented Features

- Left-side workspace list in a dedicated dashboard tab.
- Workspace identity:
  - Each workspace gets an assigned color shown as a marker next to its name.
  - Click a workspace color dot to pick and save a new color.
  - Dashboard pinned-tab icon updates to a letter badge based on the active workspace name.
- Workspace switch: closes the previous workspace tabs from view (sleeps/saves them) and loads only the selected workspace tabs while staying on the dashboard page.
- Workspace organization:
  - Drag-and-drop reorder for workspaces.
- Global settings:
  - Accessible from a single gear icon at the bottom of the left rail.
- Tab organization:
  - Drag-and-drop reorder for open tabs and sleeping tabs.
  - Move tabs between workspaces via drag-and-drop (drop a tab onto a workspace) or per-tab workspace menu.
- Sleep behavior:
  - Manual sleep button for open tabs.
  - Workspace switching automatically sleeps/removes prior-workspace tabs from view.
- Memory management:
  - Alarm-based cleanup sleeps inactive tabs (default: 120 minutes).
  - Uses tab `lastAccessed`, skips pinned and active tabs.
- History snapshots:
  - Auto-captured on switch, sleep, and memory cleanup.
  - Per-workspace history with restore action.
- Resources:
  - Bookmark-like list that is not auto-opened.
  - Add manually or bookmark a copy of open/sleeping tabs into resources.
  - Tab rows use icon actions: bookmark icon (`🔖`) and move menu icon (`|->`).
  - Bookmark icon is highlighted when the exact URL is already in Resources.
- Toolbar click behavior:
  - Clicking the extension icon opens/focuses the dashboard tab in the current window.
  - The dashboard tab is pinned and moved to the first tab position (index 0).
  - On Chrome startup, the extension auto-opens/focuses one dashboard tab in each normal window.
- Storage model:
  - Persists in `chrome.storage.local` (profile-local, higher capacity).

## Project Structure

- `manifest.json` - MV3 manifest.
- `background.js` - service worker with workspace/tab lifecycle engine.
- `dashboard.html` - main dashboard page opened as a browser tab.
- `sidepanel.css`, `sidepanel.js` - shared dashboard UI styles and behavior.
- `sidepanel.html` - legacy side-panel shell (not active by default).
- `popup.html`, `popup.js` - legacy quick actions popup (not active by default).

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `/Applications/browserManager/tabmanager`.
5. Pin the extension and click its icon.
6. The extension opens/focuses a `dashboard.html` tab with workspace controls.

## Notes / Limitations

- Uses `chrome.storage.local` to avoid `chrome.storage.sync` per-item quota limits for large workspace state.
- Tabs are treated as belonging to the active workspace for the current window.
- Pinned tabs are intentionally excluded from sleep/snapshot flows.
