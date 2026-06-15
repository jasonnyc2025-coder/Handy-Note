# 随手记 (Handy Note)

A single-file Progressive Web App (PWA) for capturing ideas and to-dos, with 5-level nested sub-items, cloud sync, offline support, and a full desktop layout.

## Features

### Note Types
- **想法 (Idea)** — freeform notes, warm pink title background
- **待办 (Todo)** — checklist notes with completion checkboxes, soft blue title background

### 5-Level Nesting
Each note supports up to 5 levels of sub-items:
- L1: Main note
- L2: Sub-items (子项)
- L3: Sub-sub-items (子子项)
- L4: SSS items (子子子项)
- L5: Fifth-level items

### Attachments
- Photos (camera or album)
- PDF files
- All stored in IndexedDB (no 5 MB localStorage limit)

### Categories
- Create color-coded categories
- Filter notes by category via tab bar
- Assign/change category from note card

### Reminders
- One-time or repeating reminders (daily / weekly / monthly)
- Overdue badge in tab bar
- System notifications (when permission granted)

### Cloud Sync
- Google Sign-In via custom self-hosted server
- Auto-pull every 20 seconds
- Conflict resolution: last-modified wins
- Cross-device deletes propagated via tombstone flags (`_deleted` + `_deletedAt`)
- Tombstones pruned after 60 days

### Inline Calculator
- Type any math expression followed by `=` in any editor to get the result inline
- Example: `1500*12=` → `1500*12=18000`
- Supports `+`, `-`, `*`, `/`, `()`, and percentages (`69*3%=` → `2.07`)
- Results rounded to 2 decimal places; whole numbers shown without decimals
- Works on desktop (keydown) and Android IME keyboards (input event)

### Desktop Layout
At screen widths ≥ 900 px the app automatically switches to a two-column layout:

```
┌──────────────────┬────────────────────────────────┐
│ 🔍  ＋ 新建      │  [Note title / content]         │
│──────────────────│  [idea / todo tag] [category]   │
│ Note 1       ←── │                                 │
│ Note 2           │  ▸ Sub-item 1                   │
│ Note 3           │  ▸ Sub-item 2                   │
│  ...             │  [＋ 子项]  [编辑]  [删除]       │
└──────────────────┴────────────────────────────────┘
```

- **Left column** (380 px): scrollable note list; click any card to load it on the right
- **Right column**: selected note in full view with all sub-levels expanded; all editing and sub-item forms open inline here
- **＋ 新建** button in the header opens the composer in the right column; after saving, the new note is auto-selected
- Keyboard shortcuts: `Ctrl/Cmd+N` — new note; `Esc` — deselect
- Mobile layout (< 900 px) is completely unchanged

### Rich Text Editing
- Font size (small / normal / large / extra-large) — applies to selected text when text is highlighted, otherwise toggles the whole editor
- Text color picker with presets and custom color
- Underline — selection-based or whole-content toggle
- Formatting toolbar sits **above** the editor so the iOS system callout never covers it

### UI & UX
- Pinch-to-zoom (`transform: scale`) on the app canvas; modals stay outside the scaled layer
- Pin notes to top
- Dark / Midnight themes; Nature themes (Sunrise, Ocean, Forest, Sky, Lavender…)
- Custom photo background
- Password lock screen
- Export / Import JSON backup
- ⋯ action menu at every level (consistent order: ＋子项 → 编辑 → 提醒 → × 删除 → 置顶)

### Offline / PWA
- Service worker caches the app shell
- Installable on iOS (Add to Home Screen) and Android

## File Structure

```
Handy-Note/
├── quick-notes.html   # Entire app — all HTML, CSS, JS inline
├── index.html         # Redirect to quick-notes.html
├── manifest.json      # PWA manifest
├── sw.js              # Service worker (cache version bump on each deploy)
├── icon-192.png
└── icon-512.png
```

## Local Development

No build step required. Open `quick-notes.html` directly in a browser, or serve with any static file server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Cloud sync requires HTTPS. For local testing use a self-signed cert or a tunnel (e.g. `ngrok`).

## Cloud Sync Server

The app expects a server at a configurable URL with these endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Returns `{ googleClientId }` |
| POST | `/api/auth/google` | Exchanges Google `id_token` → JWT `{ token, name, email, picture }` |
| GET | `/api/sync` | Returns `{ notes, cats }` for authenticated user |
| PUT | `/api/sync` | Saves `{ notes, cats }` for authenticated user |

Authentication: `Authorization: Bearer <jwt>` header.

## Deployment

Bump `CACHE` in `sw.js` on every deploy so clients pick up the new version:

```js
const CACHE = 'quicknotes-vXXX';
```

## Data Model

```js
// Note (L1)
{
  id: string,          // timestamp-based unique ID
  type: 'idea' | 'todo',
  text: string,        // HTML when rich:true, plain text otherwise
  rich: boolean,
  ts: number,          // creation timestamp
  modified: number,    // last-edit timestamp
  done: boolean,
  pinned: boolean,
  cat: string,         // category ID
  remindAt: number,
  repeat: 'none' | 'daily' | 'weekly' | 'monthly',
  atts: Attachment[],
  subs: Sub[],         // L2
  _deleted: boolean,   // soft-delete tombstone for cross-device sync
  _deletedAt: number,
}

// Attachment
{ kind: 'image' | 'pdf', name: string, blobId: string }

// Sub (L2) → SubSub (L3) → SSS (L4) → L5 follow same shape, nested via .subs[]
```
