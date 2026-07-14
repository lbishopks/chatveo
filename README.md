# Chatveo — free random video chat

Mobile-friendly, peer-to-peer **general (SFW) random video chat** with optional match
preferences. Positioned as a general-audience "meet new people" service (nudity/sexual
content prohibited). Built with WebRTC + a lightweight Node signaling server.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

To test a real match you need **two participants**: open the site in two browsers/devices,
or on your phone via your computer's LAN IP (see below). Camera/mic require HTTPS on
remote devices (localhost is exempt).

## How matching works

Each user picks their own gender (Man/Woman/Other) and who they want to meet
(Men/Women/Anyone). Two users match only if the preference is **mutual**. "Anyone"
matches fastest.

## Features

- **Random video chat** over WebRTC (peer-to-peer), Next/Stop/mute/camera toggle
- **Match preferences** — pick who you meet (Men/Women/Anyone), mutual-match model
- **Live text chat** alongside the video (relayed via the signaling server)
- **Rotating ad banners** (top + bottom) — see `public/ads.js`
- **Premium tier** via Stripe — priority matching, ad-free, $9.99/mo
- **Safety basics** — 18+ gate, Terms, Report button

## Accounts & billing

Chat is anonymous; **an account (email + password) is only required to buy Premium**, so
billing attaches to a real user. Auth API: `/api/auth/register|login|logout|me` (session
cookie). Premium is **server-authoritative** — derived from the account on the WebSocket
connection, so a client cannot spoof it. Passwords are scrypt-hashed.

Stripe is the source of truth for real payments: `/create-checkout-session` requires login
and tags the account; the `/webhook` endpoint grants/revokes premium on
`checkout.session.completed`, `invoice.paid`, and `customer.subscription.deleted`. Set
`STRIPE_WEBHOOK_SECRET` for signature verification. Without a Stripe key, checkout runs in
DEMO mode and grants premium to the logged-in account so the flow is testable.

## Admin dashboard

Password-protected at **`/admin`** (HTTP Basic auth). Auto-refreshes every 5s. Includes:

- **Stats** — online, waiting, active pairs, premium, reports, bans
- **Live users** — with **kick / ban-IP** actions
- **Reports** & **Banned IPs** — with ban/unban
- **Billing** — subscribers, MRR, total revenue, Stripe/Demo status, recent payments
- **Users (accounts)** — grant/revoke premium, suspend/unsuspend
- **Chat logs** — retained text transcripts, searchable by IP / email / message text,
  with a per-session transcript viewer (backs the child-safety preservation policy)
- **Advertising control panel** — add / edit / enable-disable / delete rotating banners
  (served live to the site via `/api/ads`)

## Database

Data is stored in **SQLite** (`data/chatveo.db`) via Node's built-in `node:sqlite` — a
real ACID database with WAL concurrency, no external DB server or native dependency
required. All state (accounts, premium, payments, reports, bans, chat transcripts, ads)
lives here and **survives restarts/redeploys**.

- On first boot it creates the schema and seeds default ads.
- If legacy `data/*.json` files exist (from the old flat-file store), they are imported
  once and renamed `*.json.migrated`.

> **Deploy note:** SQLite needs a **persistent disk**. On hosts with an ephemeral
> filesystem (e.g. Render's free tier), attach a persistent volume mounted at `data/`,
> or the DB is wiped on each deploy. For multi-instance horizontal scaling, migrate to a
> networked database (Postgres) — SQLite is single-node.

## Chat retention

Text messages are logged server-side per pairing session (participants' IPs, accounts,
genders, timestamps) to the SQLite database, retained newest-first up to
`CHAT_RETENTION_MAX` sessions (default 2000). **Video is peer-to-peer and never reaches
the server, so it is not recorded.** Retaining chats is what makes the Section 2
child-safety preservation clause actionable — but it also makes you a data controller:
keep the retention window tight, secure the store, and honor deletion requests
(GDPR/CCPA) if you serve those regions.

```bash
export ADMIN_USER=admin
export ADMIN_PASSWORD=use-a-strong-password   # default is "changeme" — CHANGE IT
npm start
# visit http://localhost:3000/admin
```

Reports (from the in-app Report button) and bans persist to the SQLite database. Banned
IPs are rejected on connect and disconnected immediately when banned.

> For production, put the admin panel behind HTTPS (Basic-auth credentials are only safe
> over TLS) and change the default `ADMIN_PASSWORD`.

## Legal / disclaimer

`public/terms.html` is a full Terms + Disclaimer + **Child-Safety Policy** (zero-tolerance,
NCMEC reporting, and immediate voluntary disclosure to law enforcement for minor-related
material). The entry gate links to it and requires 18+ agreement.

> ⚠️ **Not legal advice.** This is a template. Fill in the bracketed jurisdiction/contacts
> and have a qualified internet/media attorney review it before launch. A disclaimer
> reduces but does not eliminate liability — actual moderation and (likely) age
> verification are also required for a public adult service.

## Files

- `server.js` — Express host + WebSocket signaling + matching + auth + Stripe + admin API
- `store.js` — SQLite persistence (accounts, premium, payments, reports, bans, chats, ads)
- `public/index.html` / `style.css` / `app.js` — the client (age gate, prefs, WebRTC, chat, premium, login)
- `public/ads.js` — rotating ad banners (fetched from `/api/ads`, managed in admin)
- `public/terms.html` — Terms, Disclaimer & Child-Safety Policy
- `admin/admin.html` — moderation + billing + ads dashboard

## Monetization

### 1. Ads (`public/ads.js`)
Add banners to `AD_CREATIVES`, or set `USE_NETWORK_TAG = true` and paste a zone tag from
an adult-friendly network (ExoClick, JuicyAds, TrafficJunky, EroAdvertising — Google won't
approve this vertical).

### 2. Premium subscription (Stripe)
The "Go Premium" flow calls `POST /create-checkout-session`.

- **No `STRIPE_SECRET_KEY` set** → the endpoint returns `{ demo:true }` and the client
  unlocks premium locally in DEMO mode (for testing the UX).
- **Real payments** → set env vars and restart:
  ```bash
  export STRIPE_SECRET_KEY=sk_live_...        # or sk_test_...
  export PREMIUM_PRICE_ID=price_...           # optional; else a $9.99/mo price is built inline
  npm start
  ```
  Stripe Checkout redirects back to `/?premium=1` on success.

> Premium is **account-based and server-authoritative** (verified from the session on the
> WebSocket connection), and granted via the Stripe webhook — not spoofable from the client.

## Deploying (making it "free" and public)

1. **Host the server** on any Node host (Render, Railway, Fly.io have free tiers). It must
   support WebSockets and HTTPS — both required for camera access + signaling.
2. **Add a TURN server.** ~15% of connections (especially mobile carriers) can't do
   direct P2P and need a relay. Public STUN is already wired in; add TURN credentials in
   `public/app.js` (`ICE_SERVERS`). Options: self-host [coturn](https://github.com/coturn/coturn),
   or a paid service (Twilio, Metered, Cloudflare Calls) — a few dollars/month.

## ⚠️ Before going public — safety & legal

Anonymous stranger video attracts nudity and minors. This MVP includes an 18+ gate, a
Report button, and Terms, but a public launch needs more:

- **Real moderation** (the Report handler currently just logs + disconnects).
- **Ban/rate-limiting** of abusive users (persist reports, block by IP/device).
- **Age verification / CSAM reporting** obligations vary by jurisdiction — get legal advice.
- **AI content filtering** (e.g. nudity detection on video frames) if you scale.

Treat this as a working prototype, not a launch-ready public service.
