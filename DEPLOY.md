# Deploying Chatveo to chatveo.live

Everything in the code is deploy-ready. The steps below are the parts that need
**your** accounts — do them in order. Rough time: ~45–60 min.

---

## 1. Put the code on GitHub
Create an empty repo at github.com (e.g. `chatveo`), then from this folder:

```bash
git remote add origin https://github.com/<you>/chatveo.git
git branch -M main
git push -u origin main
```
(The repo is already committed locally — you just add the remote and push.)

## 2. Deploy on Render
1. Sign up at render.com and connect your GitHub.
2. **New → Blueprint**, pick the `chatveo` repo. Render reads `render.yaml`
   (web service + 1 GB persistent disk mounted at `/data` for the SQLite DB).
3. When prompted, set the secret env vars:
   - `ADMIN_PASSWORD` → a strong password (this protects `/admin`)
   - Leave Stripe/TURN blank for now (Premium runs in demo mode until you add Stripe).
4. Click **Apply**. First deploy takes a few minutes. You'll get a URL like
   `https://chatveo.onrender.com` — verify it loads and `/health` returns ok.

## 3. Point chatveo.live at Render
1. In Render → your service → **Settings → Custom Domain** → add `chatveo.live`
   (and `www.chatveo.live` if you want).
2. Render shows a DNS target. At your **registrar**, add the records it asks for
   (usually an `ANAME`/`ALIAS`/`CNAME` for the apex, or an `A` record).
3. Wait for DNS to propagate; Render auto-issues the HTTPS certificate.
   → Camera/mic and WebSockets only work over HTTPS, so this step is required.

## 4. Add a TURN server (makes mobile reliable)
~15% of connections (esp. mobile carriers) can't do direct peer-to-peer.
1. Sign up at **metered.ca** (free tier) or run your own **coturn**.
2. Get the TURN URL, username, and credential.
3. In Render → Environment, set `TURN_URL`, `TURN_USER`, `TURN_PASS` and redeploy.
   The client fetches these from `/api/ice` automatically — no code change.

## 5. Turn on real payments (when ready)
1. In your Stripe dashboard, get `STRIPE_SECRET_KEY`.
2. Create a webhook pointing to `https://chatveo.live/webhook`; copy its
   signing secret into `STRIPE_WEBHOOK_SECRET`. (Optionally set `PREMIUM_PRICE_ID`.)
3. Set those env vars in Render and redeploy. Premium is now live billing.

## 6. Apply to an ad network
With the site live at chatveo.live, sign up at **Adsterra** or **Monetag**,
create 320×50 and 728×90 zones, and paste the tags in `/admin → Ad network`.

---

## Pre-launch checklist
- [ ] `ADMIN_PASSWORD` changed from the default
- [ ] HTTPS working on chatveo.live
- [ ] TURN configured (test a call between two phones on cellular)
- [ ] Email working for `abuse@` / `dmca@chatveo.live` (legal contacts in Terms)
- [ ] Terms reviewed by an attorney; bracketed jurisdiction filled in
- [ ] Stripe in live mode (if charging)
