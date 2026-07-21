// ---- Chatveo client ----
// STUN-only fallback; the real config (incl. TURN) comes from /api/ice, which
// reads the server's TURN_* env vars. TURN is what makes mobile connections work.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
let iceServersCache = null;
async function getIceServers() {
  if (iceServersCache) return iceServersCache;
  try {
    const { iceServers } = await fetch("/api/ice").then((r) => r.json());
    iceServersCache = iceServers && iceServers.length ? iceServers : ICE_SERVERS;
  } catch {
    iceServersCache = ICE_SERVERS;
  }
  return iceServersCache;
}

const $ = (id) => document.getElementById(id);

// Screens
const gate = $("gate"), setup = $("setup"), chat = $("chat");
const agree = $("agree"), enterBtn = $("enterBtn"), startBtn = $("startBtn");
const statusEl = $("status");
const localVideo = $("localVideo"), remoteVideo = $("remoteVideo");

let ws, myId, pc, localStream;
let partnerActive = false;
let prefs = { gender: "male", seeking: "any" };

// ---- Persistent guest identity ----
// A unique id kept in the browser so anonymous users are recognized on return
// and can rejoin the chat they dropped from (no sign-in required).
let guestId = localStorage.getItem("chatveo_guest");
if (!guestId) {
  guestId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
  localStorage.setItem("chatveo_guest", guestId);
}
// If we were recently in a chat (marker set), try to rejoin on connect.
let attemptingReconnect = Date.now() - Number(localStorage.getItem("chatveo_active") || 0) < 60000;
let reconnectFallback = null, reconnectCountdown = null;
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("guestIdLine");
  if (el) el.textContent = `Your guest ID: ${guestId.slice(0, 8)} · saved on this device`;
});

// ---- Account / premium state ----
// Premium is now tied to a server-side account (verified via session cookie),
// so it can't be spoofed from the client.
let account = null; // { id, email, premium }
let isPremium = false;

function applyPremium() {
  document.body.classList.toggle("premium", isPremium);
  $("goPremiumBtn").classList.toggle("hidden", isPremium);
  $("premiumStatus").classList.toggle("hidden", !isPremium);
  // Gender filter is Premium-only: lock Men/Women for free users.
  document.querySelectorAll('.seg[data-group="seeking"] button[data-val="male"], .seg[data-group="seeking"] button[data-val="female"]')
    .forEach((b) => b.classList.toggle("locked", !isPremium));
  const hint = $("seekingHint");
  if (hint) hint.classList.toggle("hidden", isPremium);
  // Free users are forced back to "Anyone".
  if (!isPremium && prefs.seeking !== "any") {
    prefs.seeking = "any";
    document.querySelectorAll('.seg[data-group="seeking"] button')
      .forEach((b) => b.classList.toggle("active", b.dataset.val === "any"));
  }
}

// Prompt to upgrade (login first if anonymous).
function promptPremium() {
  if (!account) return openAuth();
  $("premiumNote").textContent = "";
  $("premiumModal").classList.remove("hidden");
}

async function refreshAccount() {
  try {
    const { user } = await fetch("/api/auth/me").then((r) => r.json());
    account = user;
    isPremium = !!user?.premium;
  } catch { account = null; isPremium = false; }
  applyPremium();
}

// Clean the ?premium=1 return param from Stripe, then load account state.
(function init() {
  const params = new URLSearchParams(location.search);
  if (params.has("premium")) history.replaceState({}, "", location.pathname);
  refreshAccount();
})();

// ---- Age gate + Cloudflare Turnstile (bot check) ----
let turnstileEnabled = false;
let turnstileToken = null;

function refreshGate() {
  // Enter needs the 18+ agreement, and (if Turnstile is on) a solved challenge.
  enterBtn.disabled = !agree.checked || (turnstileEnabled && !turnstileToken);
}
agree.addEventListener("change", refreshGate);

// Load Turnstile if the server has it configured.
(async function initTurnstile() {
  let cfg = {};
  try { cfg = await fetch("/api/config").then((r) => r.json()); } catch {}
  if (!cfg.turnstile) return; // disabled — plain age gate
  turnstileEnabled = true;
  refreshGate();
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  s.async = true; s.defer = true;
  // Fail-open safety net: never let a broken/blocked bot-check lock real users
  // out. If Turnstile hasn't produced a token in 12s, drop the requirement.
  const failOpen = () => { turnstileEnabled = false; turnstileToken = null; refreshGate(); };
  const failOpenTimer = setTimeout(() => { if (!turnstileToken) failOpen(); }, 6000);
  s.onload = () => {
    try {
      window.turnstile.render("#turnstileBox", {
        sitekey: cfg.turnstile,
        theme: "dark",
        callback: (t) => { clearTimeout(failOpenTimer); turnstileToken = t; refreshGate(); },
        "expired-callback": () => { turnstileToken = null; refreshGate(); },
        "error-callback": () => { clearTimeout(failOpenTimer); failOpen(); }, // don't block on error
      });
    } catch { clearTimeout(failOpenTimer); failOpen(); }
  };
  s.onerror = () => { clearTimeout(failOpenTimer); failOpen(); };
  document.head.appendChild(s);
})();

enterBtn.addEventListener("click", async () => {
  if (turnstileEnabled) {
    enterBtn.disabled = true;
    try {
      const r = await fetch("/api/verify-turnstile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: turnstileToken }),
      }).then((res) => res.json());
      if (!r.ok) {
        alert("Verification failed — please complete the challenge again.");
        turnstileToken = null;
        try { window.turnstile.reset("#turnstileBox"); } catch {}
        refreshGate();
        return;
      }
    } catch {
      alert("Could not verify. Please try again.");
      refreshGate();
      return;
    }
  }
  gate.classList.add("hidden");
  setup.classList.remove("hidden");
});

// ---- Preference segmented buttons ----
document.querySelectorAll(".seg").forEach((seg) => {
  const group = seg.dataset.group;
  seg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("locked")) { promptPremium(); return; } // Premium-gated
      seg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      prefs[group] = btn.dataset.val;
    });
  });
});
// default gender selection
document.querySelector('.seg[data-group="gender"] button[data-val="male"]').classList.add("active");

// ---- Start ----
startBtn.addEventListener("click", async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: true,
    });
  } catch (err) {
    alert("Camera & microphone access is required to use Chatveo.\n\n" + err.message);
    return;
  }
  localVideo.srcObject = localStream;
  updateFlipBtnVisibility(); // now that permission is granted, we can count cameras
  setup.classList.add("hidden");
  chat.classList.remove("hidden");
  connect();
});

// ---- WebSocket signaling ----
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    sendWs({ type: "identify", guestId }); // always announce identity first
    if (attemptingReconnect) {
      setStatus("Reconnecting you to your chat…");
      clearTimeout(reconnectFallback);
      // give the server a moment to re-pair us; if it doesn't, look for someone new
      reconnectFallback = setTimeout(() => { if (!partnerActive) find(); }, 2500);
    } else {
      find();
    }
    attemptingReconnect = false;
  };
  ws.onmessage = (e) => handleSignal(JSON.parse(e.data));
  ws.onclose = () => {
    if (intentionalClose) { intentionalClose = false; return; } // user pressed Stop
    if (blockReconnect) return; // banned or needs re-verify — don't loop
    if (partnerActive) attemptingReconnect = true; // reconnect and try to rejoin partner
    setStatus("Reconnecting…");
    setTimeout(connect, 1500);
  };
}
let blockReconnect = false;
let intentionalClose = false; // set by Stop so we don't auto-reconnect

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function find() {
  setStatus("Looking for someone…");
  sendWs({ type: "find", gender: prefs.gender, seeking: prefs.seeking, premium: isPremium });
}

async function handleSignal(msg) {
  switch (msg.type) {
    case "welcome":
      myId = msg.id;
      break;
    case "needs-verify":
      blockReconnect = true;
      teardownPc();
      chat.classList.add("hidden");
      setup.classList.add("hidden");
      gate.classList.remove("hidden");
      turnstileToken = null;
      try { window.turnstile && window.turnstile.reset("#turnstileBox"); } catch {}
      refreshGate();
      break;
    case "banned":
      blockReconnect = true;
      teardownPc();
      setStatus("You have been blocked from this service.");
      break;
    case "waiting":
      setStatus("Looking for someone…");
      break;
    case "matched":
      clearTimeout(reconnectFallback);
      clearInterval(reconnectCountdown);
      localStorage.setItem("chatveo_active", String(Date.now())); // mark active for reconnect
      if (msg.reconnected) {
        addMessage("sys", "✅ Reconnected — you're back with your partner.");
      } else {
        clearMessages();
        addMessage("sys", "You're now chatting with a stranger. Say hi!");
      }
      await startCall(msg.initiator);
      break;
    case "partner-dropped": {
      // Partner's connection dropped — hold and wait for them to return.
      teardownPc();
      addMessage("sys", "Your partner dropped. Waiting for them to reconnect…");
      let s = msg.seconds || 45;
      clearInterval(reconnectCountdown);
      setStatus(`Partner dropped — waiting for them to return… (${s}s)`);
      reconnectCountdown = setInterval(() => {
        s -= 1;
        if (s <= 0) clearInterval(reconnectCountdown);
        else setStatus(`Partner dropped — waiting for them to return… (${s}s)`);
      }, 1000);
      break;
    }
    case "reconnect-timeout":
      clearInterval(reconnectCountdown);
      localStorage.removeItem("chatveo_active");
      setStatus("Couldn't reconnect. Finding someone new…");
      teardownPc();
      find();
      break;
    case "chat":
      addMessage("them", msg.text);
      break;
    case "offer":
      await ensurePc(false);
      await pc.setRemoteDescription(msg.data);
      { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        sendWs({ type: "answer", data: answer }); }
      break;
    case "answer":
      await pc.setRemoteDescription(msg.data);
      break;
    case "ice":
      if (pc && msg.data) { try { await pc.addIceCandidate(msg.data); } catch {} }
      break;
    case "partner-left":
      localStorage.removeItem("chatveo_active");
      setStatus("Partner left. Finding a new match…");
      addMessage("sys", "Stranger disconnected.");
      teardownPc();
      find();
      break;
  }
}

// ---- WebRTC ----
async function ensurePc() {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: await getIceServers() });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) sendWs({ type: "ice", data: e.candidate }); };
  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    partnerActive = true;
    setStatus("");
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected"].includes(pc.connectionState)) {
      setStatus("Connection lost. Finding a new match…");
      teardownPc();
      find();
    }
  };
}

async function startCall(initiator) {
  setStatus("Connecting…");
  await ensurePc();
  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: "offer", data: offer });
  }
}

function teardownPc() {
  partnerActive = false;
  if (pc) { pc.ontrack = null; pc.onicecandidate = null; pc.close(); pc = null; }
  remoteVideo.srcObject = null;
}

// ---- Controls ----
$("nextBtn").addEventListener("click", () => {
  clearInterval(reconnectCountdown);
  localStorage.removeItem("chatveo_active");
  teardownPc();
  clearMessages();
  setStatus("Finding someone new…");
  sendWs({ type: "next", gender: prefs.gender, seeking: prefs.seeking, premium: isPremium });
});

// Stop = fully end the session: leave the queue, release the camera/mic (so the
// camera light goes off), and go back to the setup screen.
$("stopBtn").addEventListener("click", () => {
  clearInterval(reconnectCountdown);
  clearTimeout(reconnectFallback);
  localStorage.removeItem("chatveo_active");
  teardownPc();
  sendWs({ type: "stop" });

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop()); // releases camera + mic
    localStream = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;

  intentionalClose = true;
  if (ws) { try { ws.close(); } catch {} }
  ws = null;

  clearMessages();
  setStatus("");
  chat.classList.add("hidden");
  setup.classList.remove("hidden");
});

let micOn = true, camOn = true;
$("muteBtn").addEventListener("click", (e) => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  e.currentTarget.textContent = micOn ? "🎤" : "🔇";
});
$("camBtn").addEventListener("click", (e) => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  e.currentTarget.style.opacity = camOn ? "1" : ".5";
});

// ---- Front / rear camera switch ----
// Swaps the video track in place (and in the live call via replaceTrack) so the
// partner keeps seeing you without renegotiating.
let facingMode = "user";
$("flipBtn").addEventListener("click", async (e) => {
  if (!localStream) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  const next = facingMode === "user" ? "environment" : "user";
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next } } });
    const newTrack = tmp.getVideoTracks()[0];
    if (pc) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
    }
    const oldTrack = localStream.getVideoTracks()[0];
    if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
    localStream.addTrack(newTrack);
    localVideo.srcObject = localStream;
    newTrack.enabled = camOn;
    facingMode = next;
  } catch (err) {
    addMessage("sys", "Couldn't switch camera: " + err.message);
  }
  btn.disabled = false;
});

// Only show the flip button when the device actually has more than one camera.
// Must run AFTER camera permission is granted — browsers hide device details
// until then, so checking on page load would wrongly hide it on phones.
async function updateFlipBtnVisibility() {
  const btn = $("flipBtn");
  if (!btn || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    btn.classList.toggle("hidden", devices.filter((d) => d.kind === "videoinput").length < 2);
  } catch { /* leave it visible */ }
}

$("reportBtn").addEventListener("click", () => {
  if (!partnerActive) return;
  if (confirm("Report this person for inappropriate behavior and skip to the next?")) {
    sendWs({ type: "report", reason: "user_report" });
    teardownPc();
    clearMessages();
    setStatus("Reported. Finding someone new…");
    sendWs({ type: "next", gender: prefs.gender, seeking: prefs.seeking, premium: isPremium });
  }
});

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.style.display = text ? "block" : "none";
  return true;
}

// ---- Text chat ----
const messagesEl = $("messages");
function addMessage(kind, text) {
  const el = document.createElement("div");
  el.className = "msg " + kind;
  el.textContent = kind === "you" ? "You: " + text : kind === "them" ? text : text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function clearMessages() { messagesEl.innerHTML = ""; }

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chatText");
  const text = input.value.trim();
  if (!text || !partnerActive) return;
  sendWs({ type: "chat", text });
  addMessage("you", text);
  input.value = "";
});

// ---- Auth modal (login / register) ----
let authMode = "login"; // 'login' | 'register'
function openAuth() {
  $("authError").textContent = "";
  setAuthMode("login");
  $("authModal").classList.remove("hidden");
}
function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === "register";
  $("authTitle").textContent = reg ? "Create account" : "Log in";
  $("authSubmit").textContent = reg ? "Create account" : "Log in";
  $("authToggleText").textContent = reg ? "Already have an account?" : "No account?";
  $("authToggle").textContent = reg ? "Log in" : "Create one";
  $("authPass").autocomplete = reg ? "new-password" : "current-password";
}
$("authToggle").addEventListener("click", (e) => { e.preventDefault(); setAuthMode(authMode === "login" ? "register" : "login"); $("authError").textContent = ""; });
$("closeAuth").addEventListener("click", () => $("authModal").classList.add("hidden"));

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("authEmail").value.trim();
  const password = $("authPass").value;
  const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
  try {
    const res = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) { $("authError").textContent = data.error || "Failed"; return; }
    account = data.user; isPremium = !!data.user.premium; applyPremium();
    $("authModal").classList.add("hidden");
    $("premiumModal").classList.remove("hidden"); // continue to upgrade
  } catch (err) { $("authError").textContent = "Network error: " + err.message; }
});

// ---- Premium ----
$("goPremiumBtn").addEventListener("click", () => {
  if (!account) return openAuth(); // must have an account to buy premium
  $("premiumNote").textContent = "";
  $("premiumModal").classList.remove("hidden");
});
$("closePremium").addEventListener("click", () => $("premiumModal").classList.add("hidden"));

$("checkoutBtn").addEventListener("click", async () => {
  const note = $("premiumNote");
  note.textContent = "Starting checkout…";
  try {
    const res = await fetch("/create-checkout-session", { method: "POST" });
    const data = await res.json();
    if (res.status === 401) { $("premiumModal").classList.add("hidden"); return openAuth(); }
    if (data.url) {
      window.location.href = data.url; // real Stripe Checkout
    } else if (data.demo) {
      // No Stripe key — server granted premium to this account in DEMO mode.
      await refreshAccount();
      $("premiumModal").classList.add("hidden");
      alert("DEMO MODE: Premium enabled on your account.\n\nAdd STRIPE_SECRET_KEY on the server to charge real payments.");
    } else {
      note.textContent = data.error || "Could not start checkout.";
    }
  } catch (err) {
    note.textContent = "Network error: " + err.message;
  }
});
