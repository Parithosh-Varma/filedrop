# FileDrop — AGENTS.md

Browser-to-browser P2P file transfer. Static-only: no backend, no R2/KV/Functions, no build step, no package.json, no tests/lint.

## Structure

- `public/index.html` — Send (dropzone + ticket) / Receive views, tab switch. No inline scripts (CSP `script-src 'self'`); UI helpers in `ui.js`.
- `public/app.js` — all transfer logic (IIFE, vanilla JS): PeerJS signaling, 4 parallel reliable DataChannels, ~250KB raw-binary framed chunks (`[fi:uint16][i:uint32][payload]`, SCTP-size negotiated), 4-deep read prefetch via `Blob.arrayBuffer()`, event-driven backpressure (2MB/conn, 8MB total), throttled progress UI (150ms), OPFS streaming receive with Blob fallback. Protocol v3 only (`filedrop-v3-`, 12-char crypto codes; v2 6-char codes are rejected with a re-share prompt). SAS verify (`showSas`/`hideSas` → `send-sas`/`receive-sas`) + ephemeral vault opt-out (`vault-off`). Sender auto-zip: 6+ files (any size) OR 2+ files ≥1 GiB total (and zip fitting 2 GiB `MAX_FILE_SIZE`, zip32 32-bit fields, `MAX_TOTAL_BYTES` minus headroom) pack into one STORE `.zip` (`filedrop-<code>.zip`, real CRCs, no data descriptors) via `zipShouldPack`/`packZipFiles`/`makeZipFacade` (`startZippedSend`); receiver needs no changes. Smaller batches send file-by-file as before.
- `public/ui.js` — resend affordance, tab aria-pressed sync, receive progress mirroring (extracted for CSP).
- `public/vendor/` — vendored `peerjs.min.js` (1.5.4), `qrcode.min.js` (local QR, no third-party leak), `fonts/` (self-hosted Space Grotesk + Space Mono latin woff2 — no Google Fonts requests), animation libs. No runtime CDN.
- `public/_headers` — Cloudflare security headers: self-only CSP (`script-src 'self'`, `style-src 'self'`, `font-src 'self'` — never add third-party script/img/connect sources such as ads/trackers without a security review), `frame-ancestors 'none'`, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP.
- `public/styles.css` — airmail counter aesthetic (par-avion `.stripe` + perforated `.ticket`); self-hosted Space Grotesk + Space Mono via `@font-face`; `.filewarn` risky-type badge; `.sas` verify + `.ephem` opt-out; fx-ambient/confetti additive.
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

- Static-only, no runtime CDN: use `vendor/` files. Never re-add `unpkg`/`api.qrserver.com` (code leak + supply-chain), Google Fonts links, or ad/tracker scripts (they widen trusted JS with full DOM/IDB access to codes + file bytes). QR via `renderQrLocal()` only; fonts via `vendor/fonts` + `@font-face` only.
- Signaling: public PeerJS cloud (`0.peerjs.com`); bytes are P2P only. Sender uses `filedrop-v3-<12-char>` (`crypto.getRandomValues`, `ABCDEFGHJKMNPQRSTUVWXYZ23456789`); v2 6-char codes are rejected (`submitReceive` requires exactly 12). Codes expire after 30 min (`CODE_TTL_MS`), single-receiver binding while live (`sendOwnerPeer`), receive rate-limit 5/min with generic errors (no oracle). SAS verify: both sides show the same 6-digit `showSas()` code derived from `code|sender|receiver` — users compare over a second channel to catch a signaling MITM.
- Receiver validates everything sender-controlled (`validMeta()`, binary caps: 2 GiB per file / 4 GiB batch / 16384 chunks max, file index u16 (65535), `total==ceil(size/chunk)`). Violation → `abortRecv()` + close. Never `new Array(total)` before validation.
- Both tabs must stay open during transfer; anyone with the code can download while sender is online. No offline/store-and-forward (would need R2 + Function).
- CSS: `[hidden] { display: none !important }` is load-bearing (app.js toggles `hidden`). `.switch` is a segmented control — inner buttons must keep `border-radius: 0` (generic `button` radius leaks white notches into the active tab). `.ticket` grid is 3-track desktop (`auto 2px minmax(0,1fr)` stub|tear|body) → 1-column stack on mobile with horizontal `.tear`.
- `share-link` has a `file://`/opaque-origin fallback using `location.href` base — don't remove.
- Mobile browsers throttle backgrounded tabs; large files (100s of MB) need foreground tabs. No auto-download by design (malware vector) — the per-file `Download` link is the only path; risky extensions get `.filewarn`.
- `app.js` + `ui.js` share DOM state (send `100%` → show resend; receive `<progress hidden>` → wrapper). Keep IDs stable: `tab-send/receive`, `view-send/receive`, `dropzone`, `file-input`, `send-panel`, `share-code/link/qr`, `send/receive-progress`, `send/receive-pct`, `send/receive-status`, `send/receive-sas`, `send/receive-filelist`, `send/receive-live`, `receive-reconnect`, `vault`, `vault-list`, `vault-clear`, `vault-off`.
- Refresh armor: `beforeunload` guard while `transferActive`; sender code persists in `sessionStorage:fd-code`+`fd-code-ts` until done/cancel/expiry so a reload + re-drop reuses it if fresh; receiver `Reconnect` button restarts with the same code; finished files are vaulted in IndexedDB (`filedrop` db, 7-day expiry, 100-file cap) unless `vault-off` is ticked (download-only ephemeral mode) and re-offered after reload — `vault-clear` also wipes OPFS `fd-*` temps + `sweepOldTempOpfs()` on load. New transfer while idle wipes history via `clearHistory()` (vault IDB only — OPFS untouched so another tab's live receive survives; same-code reconnects keep the vault, new codes wipe it). Tab switches while idle (`show()`) also wipe the vault and reset the abandoned view to pristine (`resetSendView`/`resetReceiveView`: peers torn down, codes discarded, rows/status/progress cleared; typed receive code + `lastCode` kept so Connect/Reconnect still work). Live transfers (`transferActive`) block all wiping. Filenames via `sanitizeDownloadName()` (RTL/controls stripped) + `riskyKind()` warnings.
- Disconnect halts honestly: sender pump checks `sendAlive` every chunk and `safeSend` trips `onSendDead` on close/error/throw — progress freezes (rounded, never jumps back), code is kept for reconnect; receiver marks pending rows `stopped` and shows `Reconnect`. Never report 100% unless every `fdone`+`done` landed AND the receiver acked `{t:"received"}` — the sender parks at 99% + "waiting for the other side to finish saving" until the ack (45s fallback message, never fake 100%); receiver progress caps at 99 until `recvAllComplete()`. `pumpStarted` resets on all-down (and after a clean finish a fresh connection re-arms it) so reconnect/resubmit actually restarts the pump — without this the receiver waits forever. Explicit Stop sends best-effort `{t:"cancelled"}` (250ms flush delay) so the far side shows a toast naming it ("Sender/Receiver stopped…"); close-detection stays the fallback and must not clobber the named message (`recvCancelNoted`, `!sendAlive` early-return).
- Sender cap violations (count/size/total/names) go through `rejectBatch()`: `toast(..., "warn")` + inline `#send-error` (`role=alert`), ticket stays shut, dropzone stays visible for instant retry. Never show the share ticket without a code.
- Deep links: `?code=XXXX` opens the Receive tab prefilled; `?code=XXXX&auto=1` (what the QR encodes) also auto-connects via `submitReceive()` after ~400ms. Copied share links stay manual (no `auto` flag).
