# 随手记 (Handy Note)

A single-file Progressive Web App (PWA) for capturing ideas and to-dos, with 5-level nested sub-items, cloud sync, and offline support.

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

### UI & UX
- Pinch-to-zoom (`transform: scale`) on the app canvas; modals stay outside the scaled layer
- Rich text editing: bold, italic, font size, color picker
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
