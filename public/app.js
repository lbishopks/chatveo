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

// ---- Age gate ----
agree.addEventListener("change", () => (enterBtn.disabled = !agree.checked));
enterBtn.addEventListener("click", () => {
  gate.classList.add("hidden");
  setup.classList.remove("hidden");
});

// ---- Preference segmented buttons ----
document.querySelectorAll(".seg").forEach((seg) => {
  const group = seg.dataset.group;
  seg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
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
    if (partnerActive) attemptingReconnect = true; // reconnect and try to rejoin partner
    setStatus("Reconnecting…");
    setTimeout(connect, 1500);
  };
}

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

$("stopBtn").addEventListener("click", () => {
  clearInterval(reconnectCountdown);
  localStorage.removeItem("chatveo_active");
  teardownPc();
  sendWs({ type: "stop" });
  setStatus("Stopped. Tap “Next” to start again.");
});

let micOn = true, camOn = true;
$("muteBtn").addEventListener("click", (e) => {
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  e.currentTarget.textContent = micOn ? "🎤" : "🔇";
});
$("camBtn").addEventListener("click", (e) => {
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  e.currentTarget.style.opacity = camOn ? "1" : ".5";
});

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
