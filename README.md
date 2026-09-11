# FileDrop — P2P file transfer (Cloudflare Pages static-only)

Live: https://fdrop.pages.dev

Browser-to-browser transfer. No backend, no R2/KV/Functions, no build step.

## How it works

- **Send tab:** drop one file or a whole batch → get 12-char crypto-random code + `?code=...` link + locally-generated QR. Code expires after 30 min. Only one receiver at a time while live.
- **Receive tab:** enter code (or open link; old 6-char v2 codes still work) → files stream in order over parallel WebRTC DataChannels (4x, ~250KB raw-binary framed chunks, event-driven backpressure) → each file is streamed to disk (OPFS, Blob fallback) with its own manual Download link (no auto-download) + executable/script warnings.
- Signaling via public PeerJS cloud (`0.peerjs.com`). File bytes go peer-to-peer.
- Both tabs must stay open during transfer. Anyone with the code can download while sender is online — share only with someone you trust.
- Security: strict CSP/HSTS/frame-ancestors via `public/_headers`, vendored `peerjs`+`qrcode` (no CDN), receiver validates all sender fields (50 files / 2 GiB per file / 4 GiB batch caps), 5-attempts/min receive rate-limit, sanitized filenames, 7-day vault expiry with OPFS sweep.

## Deploy to Cloudflare Pages

```bash
# from repo root
npx wrangler pages deploy filedrop/ --project-name=filedrop
```

Or via dashboard: Pages → Create → Upload assets → drag `filedrop/` contents.

Local preview:

```bash
python3 -m http.server -d public 8000
# open http://localhost:8000 — use two tabs/browsers to test send/receive
```

## Deploy

```bash
npx wrangler deploy  # assets = ./public, worker = filedrop (workers.dev)
# classic Pages (pages.dev domain) — project must already exist:
npx wrangler pages deploy ./public --project-name=fdrop --force
```

## Limits / notes

- Transfer is live-only (no offline storage). For offline/store-and-forward, add an R2 bucket + Pages Function later.
- Large files (100s of MB) work but keep tabs in foreground; mobile browsers may throttle.
- QR is generated locally (`public/vendor/qrcode.min.js`) — claim codes never leave the tab. Link/code works without QR.
- Dependencies are vendored, no CDN at runtime: `public/vendor/peerjs.min.js` (1.5.4), `qrcode.min.js`, plus animation libs. No `unpkg`/`qrserver` fetches.
