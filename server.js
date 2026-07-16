import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID, timingSafeEqual, createHash } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { store } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// .trim() guards against a stray trailing space/newline sneaking into the env
// value (common when a secret is pasted), which would make login impossible.
const ADMIN_USER = (process.env.ADMIN_USER || "admin").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "changeme").trim();

const app = express();
app.set("trust proxy", true); // honor X-Forwarded-For behind a host/proxy

// Stripe webhook needs the RAW body for signature verification, so register it
// before express.json().
app.post("/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);

app.use(express.json());

function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress || "unknown";
}

// ---- Sessions (in-memory token -> userId) ----
const sessions = new Map();
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const i = c.indexOf("=");
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function userFromReq(req) {
  const token = parseCookies(req).fcsess;
  const userId = token && sessions.get(token);
  return userId ? store.findById(userId) : null;
}
function issueSession(req, res, userId) {
  const token = randomUUID() + randomUUID();
  sessions.set(token, userId);
  // Mark the cookie Secure when served over HTTPS (req.secure works behind the
  // host's proxy because we set trust proxy).
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `fcsess=${token}; HttpOnly; SameSite=Lax; Path=/${secure}`);
  return token;
}
function publicUser(u) {
  return u ? { id: u.id, email: u.email, premium: !!u.premium, premiumUntil: u.premiumUntil } : null;
}

// ---- Auth API ----
app.post("/api/auth/register", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 6)
    return res.status(400).json({ error: "Email and a 6+ char password required" });
  const { user, error } = store.createUser(email, password);
  if (error) return res.status(409).json({ error });
  issueSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = store.verifyLogin(email, password);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  if (user.banned) return res.status(403).json({ error: "Account suspended" });
  issueSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req).fcsess;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "fcsess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => res.json({ user: publicUser(userFromReq(req)) }));

// ---- Public ads feed (client rotator reads this) ----
app.get("/api/ads", (_req, res) => res.json(store.getEnabledAds()));
// Public ad-network config (zone tags are not secret; the client needs them to render).
app.get("/api/adnetwork", (_req, res) => res.json(store.getAdNetwork()));

// ---- WebRTC ICE config (STUN always; TURN when env vars are set) ----
// TURN credentials are necessarily exposed to the browser (that's how WebRTC
// works), so serving them here is expected. Set TURN_URL / TURN_USER / TURN_PASS.
app.get("/api/ice", (_req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(",").map((s) => s.trim()),
      username: process.env.TURN_USER || "",
      credential: process.env.TURN_PASS || "",
    });
  }
  res.json({ iceServers });
});

// ---- Admin auth (HTTP Basic over HTTPS) ----
function adminAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const [scheme, encoded] = hdr.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    const okUser = safeEqual(user, ADMIN_USER);
    const okPass = safeEqual(pass, ADMIN_PASSWORD);
    if (okUser && okPass) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Chatveo Admin"').status(401).send("Auth required");
}
function safeEqual(a = "", b = "") {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Admin dashboard page + API (must be registered BEFORE express.static so /admin
// is always auth-gated).
app.get("/admin", adminAuth, (_req, res) => res.sendFile(join(__dirname, "admin", "admin.html")));

app.get("/api/admin/stats", adminAuth, (_req, res) => {
  let waitingCount = 0, pairedCount = 0, premiumCount = 0;
  for (const p of peers.values()) {
    if (p.state === "waiting") waitingCount++;
    if (p.state === "paired") pairedCount++;
    if (p.premium) premiumCount++;
  }
  res.json({
    online: peers.size,
    waiting: waitingCount,
    activePairs: Math.floor(pairedCount / 2),
    premium: premiumCount,
    reports: store.getReports(9999).length,
    bans: store.getBans().length,
  });
});

app.get("/api/admin/users", adminAuth, (_req, res) => {
  const list = [];
  for (const [id, p] of peers.entries()) {
    list.push({
      id, gender: p.gender, seeking: p.seeking, state: p.state,
      premium: p.premium, ip: p.ip, partner: p.partner,
      connectedAt: p.connectedAt,
    });
  }
  res.json(list);
});

app.get("/api/admin/reports", adminAuth, (_req, res) => res.json(store.getReports(500)));
app.get("/api/admin/bans", adminAuth, (_req, res) => res.json(store.getBans()));

app.post("/api/admin/kick", adminAuth, (req, res) => {
  const p = peers.get(req.body.id);
  if (!p) return res.status(404).json({ error: "not found" });
  try { p.ws.close(); } catch {}
  res.json({ ok: true });
});

app.post("/api/admin/ban", adminAuth, (req, res) => {
  const { id, ip, reason } = req.body;
  let targetIp = ip;
  if (!targetIp && id) targetIp = peers.get(id)?.ip;
  if (!targetIp) return res.status(400).json({ error: "no ip/id" });
  store.banIp(targetIp, reason);
  // Disconnect anyone currently connected from that IP.
  for (const p of peers.values()) {
    if (p.ip === targetIp) { try { p.ws.close(); } catch {} }
  }
  res.json({ ok: true, ip: targetIp });
});

app.post("/api/admin/unban", adminAuth, (req, res) => {
  if (!req.body.ip) return res.status(400).json({ error: "no ip" });
  store.unbanIp(req.body.ip);
  res.json({ ok: true });
});

// ---- Admin: registered accounts (Users) ----
app.get("/api/admin/accounts", adminAuth, (_req, res) => res.json(store.listUsers()));

app.post("/api/admin/accounts/premium", adminAuth, (req, res) => {
  const { id, premium } = req.body;
  const u = store.setPremium(id, !!premium);
  if (!u) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.post("/api/admin/accounts/ban", adminAuth, (req, res) => {
  const u = store.setUserBanned(req.body.id, !!req.body.banned);
  if (!u) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// ---- Admin: billing ----
app.get("/api/admin/billing", adminAuth, (_req, res) => {
  const accounts = store.listUsers();
  const premiumCount = accounts.filter((u) => u.premium).length;
  const payments = store.getPayments(500);
  const revenueCents = payments.reduce((s, p) => s + (p.amount || 0), 0);
  res.json({
    premiumCount,
    mrrCents: premiumCount * PREMIUM_AMOUNT,
    priceCents: PREMIUM_AMOUNT,
    totalRevenueCents: revenueCents,
    stripeConfigured: !!stripe,
    payments,
    subscribers: accounts.filter((u) => u.premium).map((u) => ({ email: u.email, since: u.createdAt, stripeCustomerId: u.stripeCustomerId })),
  });
});

// ---- Admin: retained chat transcripts ----
app.get("/api/admin/chats", adminAuth, (req, res) => {
  res.json(store.getChatSessions(150, String(req.query.q || "")));
});
app.get("/api/admin/chats/:id", adminAuth, (req, res) => {
  const s = store.getChatSession(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// ---- Admin: advertising control panel ----
app.get("/api/admin/ads", adminAuth, (_req, res) => res.json(store.getAds()));
app.post("/api/admin/ads", adminAuth, (req, res) => res.json(store.addAd(req.body || {})));
app.post("/api/admin/ads/update", adminAuth, (req, res) => {
  const { id, ...patch } = req.body || {};
  const a = store.updateAd(id, patch);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(a);
});
app.post("/api/admin/ads/delete", adminAuth, (req, res) => {
  store.deleteAd(req.body.id);
  res.json({ ok: true });
});

// ---- Admin: ad-network configuration (paste zone tags) ----
app.get("/api/admin/adnetwork", adminAuth, (_req, res) => res.json(store.getAdNetwork()));
app.post("/api/admin/adnetwork", adminAuth, (req, res) => res.json(store.setAdNetwork(req.body || {})));

app.use(express.static(join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, online: peers.size }));

// ---- Stripe premium checkout ----
// Set STRIPE_SECRET_KEY (and PREMIUM_PRICE_ID or PREMIUM_AMOUNT) to enable real
// payments. Without a key the endpoint returns { demo:true } so the flow is
// testable locally — the client then unlocks premium in DEMO mode.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
let stripe = null;
if (STRIPE_KEY) {
  const { default: Stripe } = await import("stripe");
  stripe = new Stripe(STRIPE_KEY);
}

const PREMIUM_AMOUNT = Number(process.env.PREMIUM_AMOUNT || 999); // cents, $9.99

app.post("/create-checkout-session", async (req, res) => {
  // Premium is tied to an account, so a login is required.
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: "login_required" });

  if (!stripe) {
    // DEMO MODE: no Stripe key — grant premium to this account server-side and
    // record a demo payment so Billing shows it.
    store.setPremium(user.id, true, { premiumUntil: null });
    store.addPayment({ email: user.email, userId: user.id, amount: PREMIUM_AMOUNT, currency: "usd", source: "demo" });
    return res.json({ demo: true });
  }
  try {
    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: user.email,
      client_reference_id: user.id, // maps the payment back to the account in the webhook
      line_items: [
        process.env.PREMIUM_PRICE_ID
          ? { price: process.env.PREMIUM_PRICE_ID, quantity: 1 }
          : {
              quantity: 1,
              price_data: {
                currency: "usd",
                recurring: { interval: "month" },
                unit_amount: PREMIUM_AMOUNT,
                product_data: { name: "Chatveo Premium" },
              },
            },
      ],
      success_url: `${origin}/?premium=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?premium=0`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("stripe error", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook — the source of truth for granting/revoking premium.
function handleStripeWebhook(req, res) {
  if (!stripe) return res.json({ received: true, note: "stripe disabled" });
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = whSecret
      ? stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], whSecret)
      : JSON.parse(req.body); // no secret configured: parse unverified (dev only)
  } catch (err) {
    console.error("webhook signature error", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data?.object || {};
  switch (event.type) {
    case "checkout.session.completed": {
      const userId = obj.client_reference_id;
      if (userId) {
        store.setPremium(userId, true, { stripeCustomerId: obj.customer, stripeSubId: obj.subscription });
        const u = store.findById(userId);
        store.addPayment({ email: u?.email || obj.customer_email, userId, amount: obj.amount_total ?? PREMIUM_AMOUNT, currency: obj.currency || "usd", source: "stripe" });
      }
      break;
    }
    case "invoice.paid": {
      const u = store.listUsers().find((x) => x.stripeCustomerId === obj.customer);
      if (u) store.addPayment({ email: u.email, userId: u.id, amount: obj.amount_paid, currency: obj.currency, source: "stripe" });
      break;
    }
    case "customer.subscription.deleted": {
      const u = store.listUsers().find((x) => x.stripeSubId === obj.id || x.stripeCustomerId === obj.customer);
      if (u) store.setPremium(u.id, false);
      break;
    }
  }
  res.json({ received: true });
}

const server = createServer(app);
const wss = new WebSocketServer({ server });

/**
 * peers: id -> {
 *   ws, gender, seeking ('male'|'female'|'any'),
 *   partner (id|null), state ('idle'|'waiting'|'paired')
 * }
 */
const peers = new Map();
const waiting = []; // queue of peer ids looking for a match

// Guest identity + reconnect:
// guestToPeer maps a persistent browser guest id to its current live peer id.
// pendingReconnect holds a dropped guest's slot so, if they return within the
// window, we re-pair them with the SAME partner (who is parked in "awaiting").
const guestToPeer = new Map();      // guestId -> peerId
const pendingReconnect = new Map(); // droppedGuestId -> { partnerPeerId, timer }
const RECONNECT_WINDOW_MS = Number(process.env.RECONNECT_WINDOW_MS || 45000);

function send(id, msg) {
  const p = peers.get(id);
  if (p && p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(msg));
}

// Two peers are compatible if each wants the other's gender (or "any").
function compatible(a, b) {
  const aWantsB = a.seeking === "any" || a.seeking === b.gender;
  const bWantsA = b.seeking === "any" || b.seeking === a.gender;
  return aWantsB && bWantsA;
}

function enqueue(id) {
  const me = peers.get(id);
  if (!me) return;
  me.state = "waiting";
  me.partner = null;

  // Find first compatible waiting peer.
  for (let i = 0; i < waiting.length; i++) {
    const otherId = waiting[i];
    if (otherId === id) continue;
    const other = peers.get(otherId);
    if (!other || other.state !== "waiting") continue;
    if (compatible(me, other)) {
      waiting.splice(i, 1);
      pair(id, otherId);
      return;
    }
  }
  // Premium users get priority: placed at the FRONT of the queue so they're
  // matched first when a compatible partner appears.
  if (!waiting.includes(id)) {
    if (me.premium) waiting.unshift(id);
    else waiting.push(id);
  }
  send(id, { type: "waiting" });
}

function pair(aId, bId, reconnected = false) {
  const a = peers.get(aId);
  const b = peers.get(bId);
  if (!a || !b) return;
  a.partner = bId;
  b.partner = aId;
  a.partnerGuestId = b.guestId || null;
  b.partnerGuestId = a.guestId || null;
  a.state = "paired";
  b.state = "paired";
  a.awaitingGuestId = null;
  b.awaitingGuestId = null;

  // Open a retained chat session for this pairing (text transcript only; video is
  // peer-to-peer and never reaches the server).
  const sessionId = store.startChatSession([
    { peerId: aId, ip: a.ip, userId: a.userId, email: a.email, gender: a.gender },
    { peerId: bId, ip: b.ip, userId: b.userId, email: b.email, gender: b.gender },
  ]);
  a.sessionId = sessionId;
  b.sessionId = sessionId;

  // aId is the initiator; it will create the WebRTC offer.
  send(aId, { type: "matched", initiator: true, peerGender: b.gender, reconnected });
  send(bId, { type: "matched", initiator: false, peerGender: a.gender, reconnected });
}

// Park the dropped peer's partner in "awaiting" and hold their slot so the
// dropped guest can rejoin the same partner if they return in time.
function startReconnectHold(droppedId, droppedPeer) {
  const partnerId = droppedPeer.partner;
  const partner = partnerId ? peers.get(partnerId) : null;
  const gx = droppedPeer.guestId;
  if (droppedPeer.sessionId) store.endChatSession(droppedPeer.sessionId);

  if (!partner || !gx) {
    if (partner) {
      partner.partner = null; partner.state = "idle"; partner.sessionId = null;
      send(partnerId, { type: "partner-left" });
    }
    return;
  }
  partner.partner = null;
  partner.sessionId = null;
  partner.state = "awaiting";
  partner.awaitingGuestId = gx;
  send(partnerId, { type: "partner-dropped", seconds: Math.round(RECONNECT_WINDOW_MS / 1000) });

  const existing = pendingReconnect.get(gx);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingReconnect.delete(gx);
    const p = peers.get(partnerId);
    if (p && p.state === "awaiting" && p.awaitingGuestId === gx) {
      p.state = "idle";
      p.awaitingGuestId = null;
      send(partnerId, { type: "reconnect-timeout" });
    }
  }, RECONNECT_WINDOW_MS);
  pendingReconnect.set(gx, { partnerPeerId: partnerId, timer });
}

function leaveMatch(id, notifyPartner = true) {
  const me = peers.get(id);
  if (!me) return;
  const idx = waiting.indexOf(id);
  if (idx !== -1) waiting.splice(idx, 1);

  const partnerId = me.partner;
  me.partner = null;
  me.state = "idle";
  me.awaitingGuestId = null;

  // Close the retained chat session (once per pairing).
  if (me.sessionId) { store.endChatSession(me.sessionId); me.sessionId = null; }

  if (partnerId && notifyPartner) {
    const partner = peers.get(partnerId);
    if (partner) {
      partner.partner = null;
      partner.state = "idle";
      partner.sessionId = null;
      send(partnerId, { type: "partner-left" });
    }
  }
}

wss.on("connection", (ws, req) => {
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress || "unknown";

  // Reject banned IPs immediately.
  if (store.isBanned(ip)) {
    try { ws.send(JSON.stringify({ type: "banned" })); ws.close(); } catch {}
    return;
  }

  // Server-authoritative premium: derive it from the session cookie / account,
  // NOT from anything the client claims.
  const account = userFromReq(req);

  const id = randomUUID();
  peers.set(id, {
    ws, ip, gender: "other", seeking: "any", partner: null, state: "idle",
    premium: !!account?.premium, userId: account?.id || null,
    email: account?.email || null, connectedAt: new Date().toISOString(),
    guestId: null, partnerGuestId: null, awaitingGuestId: null,
  });
  send(id, { type: "welcome", id, premium: !!account?.premium });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = peers.get(id);
    if (!me) return;

    switch (msg.type) {
      // Client announces its persistent guest id. If this guest has a partner
      // parked waiting for them, re-pair immediately (a fresh WebRTC handshake).
      case "identify": {
        const gid = String(msg.guestId || "").slice(0, 64);
        if (!gid) break;
        me.guestId = gid;
        guestToPeer.set(gid, id);
        const pending = pendingReconnect.get(gid);
        if (pending) {
          clearTimeout(pending.timer);
          pendingReconnect.delete(gid);
          const partner = peers.get(pending.partnerPeerId);
          if (partner && partner.state === "awaiting" && partner.awaitingGuestId === gid) {
            leaveMatch(id, false);
            pair(id, pending.partnerPeerId, true);
          }
        }
        break;
      }
      case "find": {
        if (["male", "female", "other"].includes(msg.gender)) me.gender = msg.gender;
        if (["male", "female", "any"].includes(msg.seeking)) me.seeking = msg.seeking;
        // premium comes from the account (set at connect), never from the client
        me.premium = me.userId ? !!store.findById(me.userId)?.premium : false;
        leaveMatch(id); // clear any existing match first
        enqueue(id);
        break;
      }
      case "next": {
        me.premium = me.userId ? !!store.findById(me.userId)?.premium : false;
        leaveMatch(id);
        enqueue(id);
        break;
      }
      // Relay a text-chat message to the current partner, and retain it.
      case "chat": {
        const text = String(msg.text || "").slice(0, 1000);
        if (me.partner && text) {
          send(me.partner, { type: "chat", text });
          if (me.sessionId) store.appendChatMessage(me.sessionId, { from: id, text });
        }
        break;
      }
      case "stop": {
        leaveMatch(id);
        me.state = "idle";
        break;
      }
      // Relay WebRTC signaling to the current partner.
      case "offer":
      case "answer":
      case "ice": {
        if (me.partner) send(me.partner, { type: msg.type, data: msg.data });
        break;
      }
      case "report": {
        // Persist the report so it shows up in the admin dashboard.
        const reported = me.partner ? peers.get(me.partner) : null;
        store.addReport({
          at: new Date().toISOString(),
          reason: String(msg.reason || "user_report").slice(0, 200),
          reporterId: id,
          reporterIp: me.ip,
          reportedId: me.partner || null,
          reportedIp: reported?.ip || null,
        });
        console.log(`[REPORT] ${me.ip} reported ${reported?.ip || "?"} reason=${msg.reason || "n/a"}`);
        leaveMatch(id);
        break;
      }
    }
  });

  ws.on("close", () => {
    const me = peers.get(id);
    // If they dropped mid-chat and have a guest id, hold their partner for a
    // possible reconnect instead of ending it immediately.
    if (me && me.partner && me.guestId) {
      startReconnectHold(id, me);
    } else {
      leaveMatch(id);
    }
    if (me && me.guestId && guestToPeer.get(me.guestId) === id) guestToPeer.delete(me.guestId);
    peers.delete(id);
  });
});

server.listen(PORT, () => {
  console.log(`Chatveo running on http://localhost:${PORT}`);
  // Diagnostic (no secret leaked): logs the ADMIN_USER value, and the password's
  // length + a one-way SHA-256 hash so we can confirm the exact stored value
  // without exposing it. Compare the hash to sha256 of the candidate password.
  const userHash = createHash("sha256").update(ADMIN_USER).digest("hex").slice(0, 12);
  const passHash = createHash("sha256").update(ADMIN_PASSWORD).digest("hex");
  console.log(`[admin] user="${ADMIN_USER}" (sha12=${userHash}) passLen=${ADMIN_PASSWORD.length} passSha256=${passHash}`);
});
