# Microsoft Store listing assets

These are the **Store listing** images you upload directly in Partner Center
(Store listings page) — different from the *package* tile assets in
`build/appx/`, which electron-builder embeds inside the .appx itself and
don't need manual uploading.

Nothing in this folder is generated automatically: screenshots have to show
the real running app, so capture them yourself once BlissWork is built and
running on Windows.

## Required

| Asset | Size | Notes |
|---|---|---|
| Screenshots | 1366×768 or 1920×1080 (16:9) | 1 minimum, **4–8 recommended**. PNG or JPG, no transparency. Show real UI — the sticky notes board, a task in progress, etc. |

## Optional but recommended

| Asset | Size | Notes |
|---|---|---|
| Store logo (square) | 300×300 | Falls back to your package's `Square150x150Logo` if omitted — already generated in `build/appx/`. |
| Hero art | 1920×1080 | Shown on featured/promo placements. |
| Poster art | 720×1080 | Used in some collection/category tiles. |

## How to capture screenshots

1. Build + run BlissWork on Windows: `npm run build -w @taskboard/desktop && npm run start -w @taskboard/desktop` (or install the packaged app).
2. Resize the window so the client area is exactly 1920×1080 (or 1366×768) — Windows' own Snipping Tool / `Win+Shift+S` works, or use a tool that captures an exact window size.
3. Capture 4–8 shots covering: the main board, creating/editing a task, an always-on-top sticky note, and any standout feature (team/collaboration view, etc.).
4. Save as PNG into this folder (e.g. `screenshot-1.png` … `screenshot-8.png`) — they're just working files; the real upload happens in Partner Center → Store listings → Screenshots.

## Description copy (paste into Partner Center → Store listings)

**Short description** (max 100 chars):
> Always-on-top sticky task notes for teams

**Full description** — adapt from `apps/desktop/package.json` → `description`
and the website copy at https://blisswork.rnrtechs.com; keep it free of
unverifiable claims Microsoft's certification might flag (e.g. avoid
superlatives like "the best").
