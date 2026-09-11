# FileDrop — P2P file transfer (Cloudflare Pages static-only)

Live: https://fdrop.pages.dev

Browser-to-browser transfer. No backend, no R2/KV/Functions, no build step.

## How it works

- **Send tab:** pick/drop file → get 6-char code + `?code=XXXXXX` link + QR.
- **Receive tab:** enter code (or open link) → WebRTC DataChannel streams 64KB chunks → auto-download.
- Signaling via public PeerJS cloud (`0.peerjs.com`). File bytes go peer-to-peer.
- Both tabs must stay open during transfer. Anyone with the code can download while sender is online.

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
- QR uses `api.qrserver.com` (optional — link/code works without it).
- PeerJS dependency: `https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js`.
