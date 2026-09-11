# FileDrop — AGENTS.md

Browser-to-browser P2P file transfer. Static-only: no backend, no R2/KV/Functions, no build step, no package.json, no tests/lint.

## Structure

- `public/index.html` — Send (dropzone + ticket) / Receive views, tab switch, inline scripts for `?code=` deep-link and progress mirroring
- `public/app.js` — all transfer logic (IIFE, vanilla JS): PeerJS signaling, single WebRTC DataChannel, 64KB chunks with ~4MB backpressure guard, bulk queue sent in order
- `public/styles.css` — airmail counter aesthetic (par-avion `.stripe` + perforated `.ticket`); Space Grotesk + Space Mono via Google Fonts
- `wrangler.jsonc` — Worker name `filedrop`, assets `./public`
- `.wrangler/` is gitignored build/deploy output — never commit

## Commands

Local preview (no install):

```bash
python3 -m http.server -d public 8000
# open http://localhost:8000 — use two tabs/browsers to test send/receive
```

Deploy (project must already exist for classic Pages):

```bash
npx wrangler deploy
npx wrangler pages deploy ./public --project-name=fdrop --force
```

No build, no test suite. Verify manually: send 1 file + batch in tab A, receive via code and via `?code=XXXXXX` link in tab B, confirm per-file download links + 100% state. Check `≤520px` width (ticket stacks, linkrow becomes column).

## Conventions / gotchas

- Keep it dependency-free except CDN: `peerjs@1.5.4` (`unpkg`) + optional QR (`api.qrserver.com`). Link/code works without QR.
- Signaling: public PeerJS cloud (`0.peerjs.com`); bytes are P2P only. Peer ID = `filedrop-v1-<CODE>`, code = 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`.
- Both tabs must stay open during transfer; anyone with the code can download while sender is online. No offline/store-and-forward (would need R2 + Function).
- CSS: `[hidden] { display: none !important }` is load-bearing (app.js toggles `hidden`). `.switch` is a segmented control — inner buttons must keep `border-radius: 0` (generic `button` radius leaks white notches into the active tab). `.ticket` grid is 3-track desktop (`auto 2px minmax(0,1fr)` stub|tear|body) → 1-column stack on mobile with horizontal `.tear`.
- `share-link` has a `file://`/opaque-origin fallback using `location.href` base — don't remove.
- Mobile browsers throttle backgrounded tabs; large files (100s of MB) need foreground tabs. Auto-download may be blocked for multiples — the per-file `Download` link must stay as fallback.
- `app.js` + inline script in `index.html` share DOM state (send `100%` → show resend; receive `<progress hidden>` → wrapper). Keep IDs stable: `tab-send/receive`, `view-send/receive`, `dropzone`, `file-input`, `send-panel`, `share-code/link/qr`, `send/receive-progress`, `send/receive-pct`, `send/receive-status`, `send/receive-filelist`, `send/receive-live`, `receive-reconnect`, `vault`, `vault-list`, `vault-clear`.
- Refresh armor: `beforeunload` guard while `transferActive`; sender code persists in `sessionStorage:fd-code` until done/cancel so a reload + re-drop reuses it; receiver `Reconnect` button restarts with the same code; finished files are vaulted in IndexedDB (`filedrop` db, best-effort) and re-offered after reload — clear via `vault-clear`.
