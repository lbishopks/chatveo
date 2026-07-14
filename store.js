// SQLite-backed store (via Node's built-in node:sqlite).
// Real ACID database with proper concurrency — replaces the old JSON flat files.
// Keeps the same exported interface so the rest of the app is unchanged.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR is configurable so a host's persistent disk can be mounted at it
// (e.g. Render disk at /data with DATA_DIR=/data). Defaults to ./data locally.
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const CHAT_RETENTION_MAX = Number(process.env.CHAT_RETENTION_MAX || 2000);

const db = new DatabaseSync(join(DATA_DIR, "chatveo.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, at TEXT, reason TEXT,
    reporterId TEXT, reporterIp TEXT, reportedId TEXT, reportedIp TEXT
  );
  CREATE TABLE IF NOT EXISTS bans (ip TEXT PRIMARY KEY, reason TEXT, at TEXT);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE, passwordHash TEXT, salt TEXT,
    premium INTEGER DEFAULT 0, premiumUntil TEXT,
    stripeCustomerId TEXT, stripeSubId TEXT, createdAt TEXT, banned INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, at TEXT, email TEXT, userId TEXT, amount INTEGER, currency TEXT, source TEXT
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, at TEXT, endedAt TEXT, participants TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, from_peer TEXT, at TEXT, text TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_msg_session ON chat_messages(sessionId);
  CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, title TEXT, sub TEXT, href TEXT, img TEXT, ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}
const bool = (v) => v === 1 || v === true;

// ---- One-time migration from legacy JSON files ----
function migrateJson(file, importer) {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) return;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    importer(data);
    renameSync(p, p + ".migrated");
    console.log(`[store] migrated ${file} -> SQLite`);
  } catch (e) {
    console.error(`[store] migration of ${file} failed:`, e.message);
  }
}
(function runMigrations() {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  if (count("users") === 0)
    migrateJson("users.json", (arr) => { for (const u of arr || []) db.prepare(
      `INSERT OR IGNORE INTO users (id,email,passwordHash,salt,premium,premiumUntil,stripeCustomerId,stripeSubId,createdAt,banned)
       VALUES (?,?,?,?,?,?,?,?,?,?)`).run(u.id,u.email,u.passwordHash,u.salt,u.premium?1:0,u.premiumUntil??null,u.stripeCustomerId??null,u.stripeSubId??null,u.createdAt,u.banned?1:0); });
  if (count("reports") === 0)
    migrateJson("reports.json", (arr) => { for (const r of arr || []) db.prepare(
      `INSERT OR IGNORE INTO reports (id,at,reason,reporterId,reporterIp,reportedId,reportedIp) VALUES (?,?,?,?,?,?,?)`)
      .run(r.id,r.at,r.reason,r.reporterId??null,r.reporterIp??null,r.reportedId??null,r.reportedIp??null); });
  if (count("bans") === 0)
    migrateJson("bans.json", (obj) => { for (const [ip,v] of Object.entries(obj || {})) db.prepare(
      `INSERT OR IGNORE INTO bans (ip,reason,at) VALUES (?,?,?)`).run(ip,v.reason,v.at); });
  if (count("payments") === 0)
    migrateJson("payments.json", (arr) => { for (const p of arr || []) db.prepare(
      `INSERT OR IGNORE INTO payments (id,at,email,userId,amount,currency,source) VALUES (?,?,?,?,?,?,?)`)
      .run(p.id,p.at,p.email??null,p.userId??null,p.amount??0,p.currency??"usd",p.source??null); });
  if (count("chats") === 0)
    migrateJson("chats.json", (arr) => { for (const c of arr || []) {
      db.prepare(`INSERT OR IGNORE INTO chats (id,at,endedAt,participants) VALUES (?,?,?,?)`)
        .run(c.id,c.at,c.endedAt??null,JSON.stringify(c.participants||[]));
      for (const m of c.messages || []) db.prepare(
        `INSERT INTO chat_messages (sessionId,from_peer,at,text) VALUES (?,?,?,?)`).run(c.id,m.from,m.at,m.text);
    }});
  if (count("ads") === 0) {
    let migrated = false;
    migrateJson("ads.json", (arr) => { (arr||[]).forEach((a,i) => { migrated = true; db.prepare(
      `INSERT OR IGNORE INTO ads (id,enabled,title,sub,href,img,ord) VALUES (?,?,?,?,?,?,?)`)
      .run(a.id,a.enabled?1:0,a.title??"",a.sub??"",a.href??"#",a.img??"",i); }); });
    if (!migrated && count("ads") === 0) seedAds();
  }
})();

function seedAds() {
  const defaults = [
    ["💎 Go Premium — Skip the Wait", "Priority matching & no ads", "#premium"],
    ["🔥 Your Banner Here — 320×50 / 728×90", "Advertise to thousands of live viewers", "mailto:ads@chatveo.live"],
    ["🎧 Upgrade Your Setup", "Sponsored — gear for streamers", "#sponsor-1"],
  ];
  defaults.forEach(([title, sub, href], i) => db.prepare(
    `INSERT INTO ads (id,enabled,title,sub,href,img,ord) VALUES (?,1,?,?,?,'',?)`).run(randomUUID(), title, sub, href, i));
}

export const store = {
  // ---------- reports ----------
  addReport(r) {
    db.prepare(`INSERT INTO reports (id,at,reason,reporterId,reporterIp,reportedId,reportedIp) VALUES (?,?,?,?,?,?,?)`)
      .run(Date.now() + "-" + Math.random().toString(36).slice(2, 7), r.at, r.reason, r.reporterId ?? null, r.reporterIp ?? null, r.reportedId ?? null, r.reportedIp ?? null);
  },
  getReports(limit = 200) { return db.prepare(`SELECT * FROM reports ORDER BY at DESC LIMIT ?`).all(limit); },

  // ---------- bans ----------
  banIp(ip, reason) { db.prepare(`INSERT INTO bans (ip,reason,at) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET reason=excluded.reason, at=excluded.at`).run(ip, reason || "manual", new Date().toISOString()); },
  unbanIp(ip) { db.prepare(`DELETE FROM bans WHERE ip=?`).run(ip); },
  isBanned(ip) { return !!db.prepare(`SELECT 1 FROM bans WHERE ip=?`).get(ip); },
  getBans() { return db.prepare(`SELECT ip,reason,at FROM bans ORDER BY at DESC`).all(); },

  // ---------- accounts ----------
  createUser(email, password) {
    email = String(email).trim().toLowerCase();
    if (this.findByEmail(email)) return { error: "Email already registered" };
    const { salt, hash } = hashPassword(password);
    const user = { id: randomUUID(), email, premium: false, premiumUntil: null, stripeCustomerId: null, stripeSubId: null, createdAt: new Date().toISOString(), banned: false };
    db.prepare(`INSERT INTO users (id,email,passwordHash,salt,premium,premiumUntil,stripeCustomerId,stripeSubId,createdAt,banned) VALUES (?,?,?,?,0,NULL,NULL,NULL,?,0)`)
      .run(user.id, email, hash, salt, user.createdAt);
    return { user };
  },
  verifyLogin(email, password) {
    const row = db.prepare(`SELECT * FROM users WHERE email=?`).get(String(email).trim().toLowerCase());
    if (!row) return null;
    const { hash } = hashPassword(password, row.salt);
    const a = Buffer.from(hash), b = Buffer.from(row.passwordHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return this._shape(row);
  },
  findByEmail(email) { const r = db.prepare(`SELECT * FROM users WHERE email=?`).get(String(email).trim().toLowerCase()); return r ? this._shape(r) : null; },
  findById(id) { const r = db.prepare(`SELECT * FROM users WHERE id=?`).get(id); return r ? this._shape(r) : null; },
  _shape(r) { const { passwordHash, salt, ...rest } = r; return { ...rest, premium: bool(r.premium), banned: bool(r.banned) }; },
  setPremium(userId, premium, extra = {}) {
    const u = db.prepare(`SELECT id FROM users WHERE id=?`).get(userId);
    if (!u) return null;
    db.prepare(`UPDATE users SET premium=?, premiumUntil=COALESCE(?,premiumUntil), stripeCustomerId=COALESCE(?,stripeCustomerId), stripeSubId=COALESCE(?,stripeSubId) WHERE id=?`)
      .run(premium ? 1 : 0, extra.premiumUntil ?? null, extra.stripeCustomerId ?? null, extra.stripeSubId ?? null, userId);
    return this.findById(userId);
  },
  setUserBanned(userId, banned) {
    const u = db.prepare(`SELECT id FROM users WHERE id=?`).get(userId);
    if (!u) return null;
    db.prepare(`UPDATE users SET banned=? WHERE id=?`).run(banned ? 1 : 0, userId);
    return this.findById(userId);
  },
  listUsers() { return db.prepare(`SELECT * FROM users ORDER BY createdAt DESC`).all().map((r) => this._shape(r)); },

  // ---------- payments ----------
  addPayment(p) {
    db.prepare(`INSERT INTO payments (id,at,email,userId,amount,currency,source) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), new Date().toISOString(), p.email ?? null, p.userId ?? null, p.amount ?? 0, p.currency ?? "usd", p.source ?? null);
  },
  getPayments(limit = 200) { return db.prepare(`SELECT * FROM payments ORDER BY at DESC LIMIT ?`).all(limit); },

  // ---------- chat transcripts ----------
  startChatSession(participants) {
    const id = randomUUID();
    db.prepare(`INSERT INTO chats (id,at,endedAt,participants) VALUES (?,?,NULL,?)`).run(id, new Date().toISOString(), JSON.stringify(participants));
    // enforce retention cap
    const total = db.prepare(`SELECT COUNT(*) c FROM chats`).get().c;
    if (total > CHAT_RETENTION_MAX) {
      const cut = db.prepare(`SELECT at FROM chats ORDER BY at DESC LIMIT 1 OFFSET ?`).get(CHAT_RETENTION_MAX - 1);
      if (cut) {
        db.prepare(`DELETE FROM chat_messages WHERE sessionId IN (SELECT id FROM chats WHERE at < ?)`).run(cut.at);
        db.prepare(`DELETE FROM chats WHERE at < ?`).run(cut.at);
      }
    }
    return id;
  },
  appendChatMessage(sessionId, msg) {
    if (!db.prepare(`SELECT 1 FROM chats WHERE id=?`).get(sessionId)) return;
    db.prepare(`INSERT INTO chat_messages (sessionId,from_peer,at,text) VALUES (?,?,?,?)`).run(sessionId, msg.from, new Date().toISOString(), String(msg.text).slice(0, 1000));
  },
  endChatSession(sessionId) { db.prepare(`UPDATE chats SET endedAt=? WHERE id=? AND endedAt IS NULL`).run(new Date().toISOString(), sessionId); },
  getChatSessions(limit = 100, query = "") {
    let rows;
    if (query) {
      const q = `%${query.toLowerCase()}%`;
      rows = db.prepare(`
        SELECT c.* FROM chats c WHERE lower(c.participants) LIKE ?
        OR c.id IN (SELECT sessionId FROM chat_messages WHERE lower(text) LIKE ?)
        ORDER BY c.at DESC LIMIT ?`).all(q, q, limit);
    } else {
      rows = db.prepare(`SELECT * FROM chats ORDER BY at DESC LIMIT ?`).all(limit);
    }
    return rows.map((c) => {
      const cnt = db.prepare(`SELECT COUNT(*) n FROM chat_messages WHERE sessionId=?`).get(c.id).n;
      const first = db.prepare(`SELECT text FROM chat_messages WHERE sessionId=? ORDER BY id ASC LIMIT 1`).get(c.id);
      return { id: c.id, at: c.at, endedAt: c.endedAt, participants: JSON.parse(c.participants), messageCount: cnt, preview: first?.text || "" };
    });
  },
  getChatSession(id) {
    const c = db.prepare(`SELECT * FROM chats WHERE id=?`).get(id);
    if (!c) return null;
    const messages = db.prepare(`SELECT from_peer, at, text FROM chat_messages WHERE sessionId=? ORDER BY id ASC`).all(id)
      .map((m) => ({ from: m.from_peer, at: m.at, text: m.text }));
    return { id: c.id, at: c.at, endedAt: c.endedAt, participants: JSON.parse(c.participants), messages };
  },

  // ---------- ads ----------
  getAds() { return db.prepare(`SELECT * FROM ads ORDER BY ord ASC`).all().map((a) => ({ ...a, enabled: bool(a.enabled) })); },
  getEnabledAds() { return db.prepare(`SELECT * FROM ads WHERE enabled=1 ORDER BY ord ASC`).all().map((a) => ({ ...a, enabled: true })); },
  addAd(ad) {
    const id = randomUUID();
    const ord = (db.prepare(`SELECT MAX(ord) m FROM ads`).get().m ?? -1) + 1;
    db.prepare(`INSERT INTO ads (id,enabled,title,sub,href,img,ord) VALUES (?,?,?,?,?,?,?)`)
      .run(id, ad.enabled === false ? 0 : 1, ad.title ?? "", ad.sub ?? "", ad.href ?? "#", ad.img ?? "", ord);
    return { id, enabled: ad.enabled !== false, title: ad.title ?? "", sub: ad.sub ?? "", href: ad.href ?? "#", img: ad.img ?? "", ord };
  },
  updateAd(id, patch) {
    const a = db.prepare(`SELECT * FROM ads WHERE id=?`).get(id);
    if (!a) return null;
    const next = {
      enabled: patch.enabled === undefined ? a.enabled : (patch.enabled ? 1 : 0),
      title: patch.title ?? a.title, sub: patch.sub ?? a.sub, href: patch.href ?? a.href, img: patch.img ?? a.img,
    };
    db.prepare(`UPDATE ads SET enabled=?, title=?, sub=?, href=?, img=? WHERE id=?`).run(next.enabled, next.title, next.sub, next.href, next.img, id);
    return { ...a, ...next, enabled: bool(next.enabled) };
  },
  deleteAd(id) { db.prepare(`DELETE FROM ads WHERE id=?`).run(id); },

  // ---------- settings (key/value) ----------
  getSetting(key, fallback = null) {
    const r = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
    return r ? r.value : fallback;
  },
  setSetting(key, value) {
    db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  },

  // ---------- ad network config ----------
  getAdNetwork() {
    const raw = this.getSetting("adnetwork");
    const def = { enabled: false, name: "", headHtml: "", topHtml: "", bottomHtml: "" };
    if (!raw) return def;
    try { return { ...def, ...JSON.parse(raw) }; } catch { return def; }
  },
  setAdNetwork(cfg) {
    const clean = {
      enabled: !!cfg.enabled,
      name: String(cfg.name || "").slice(0, 100),
      headHtml: String(cfg.headHtml || "").slice(0, 20000),
      topHtml: String(cfg.topHtml || "").slice(0, 20000),
      bottomHtml: String(cfg.bottomHtml || "").slice(0, 20000),
    };
    this.setSetting("adnetwork", JSON.stringify(clean));
    return clean;
  },
};
