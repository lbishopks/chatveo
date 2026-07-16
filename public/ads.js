// ============================================================
//  Chatveo — Rotating Ad Banners
//
//  TWO MODES (configured from the ADMIN PANEL → "Ad network" / "Ads"):
//   1) Ad network: paste your network's zone tag (Adsterra, Monetag, AdSense,
//      Media.net, etc.) into the admin panel. It renders into the top & bottom
//      bars and the network fills + rotates the ads (and pays you). Scripts in
//      the tag ARE executed (unlike a naive innerHTML).
//   2) House ads: if no network is enabled, the banners rotate through the
//      house creatives you manage in admin (served from /api/ads).
// ============================================================

const ROTATE_MS = 6000;
const FALLBACK = [{ title: "💎 Go Premium — Skip the Wait", sub: "Priority matching & no ads", href: "#premium" }];

// Insert an HTML string into `target`, re-creating <script> nodes so they run
// (browsers do NOT execute scripts inserted via innerHTML).
function injectWithScripts(target, html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  Array.from(tmp.childNodes).forEach((node) => {
    if (node.tagName === "SCRIPT") {
      const s = document.createElement("script");
      for (const a of node.attributes) s.setAttribute(a.name, a.value);
      s.textContent = node.textContent;
      target.appendChild(s);
    } else {
      target.appendChild(node);
    }
  });
}

(async function initAds() {
  const adTop = document.getElementById("adTop");
  const adBottom = document.getElementById("adBottom");

  // ---- Mode 1: ad network ----
  try {
    const net = await fetch("/api/adnetwork").then((r) => r.json());
    if (net && net.enabled && (net.topHtml || net.bottomHtml || net.headHtml)) {
      if (net.headHtml) injectWithScripts(document.head, net.headHtml);
      // Top/bottom bars only exist for banner tags. If there's no banner tag for
      // a bar (e.g. head-only formats like In-Page Push), collapse the empty bar.
      if (net.topHtml) { adTop.innerHTML = ""; injectWithScripts(adTop, net.topHtml); }
      else { adTop.classList.add("collapsed"); }
      if (net.bottomHtml) { adBottom.innerHTML = ""; injectWithScripts(adBottom, net.bottomHtml); }
      else { adBottom.classList.add("collapsed"); }
      return; // network handles rendering + rotation
    }
  } catch { /* fall through to house ads */ }

  // ---- Mode 2: house ads (rotating) ----
  const bars = [
    { slot: document.getElementById("adTopSlot"), i: 0 },
    { slot: document.getElementById("adBottomSlot"), i: 1 },
  ];

  let creatives = FALLBACK;
  try {
    const data = await fetch("/api/ads").then((r) => r.json());
    if (Array.isArray(data) && data.length) creatives = data;
  } catch { /* keep fallback */ }

  function render(slot, ad) {
    if (!slot || !ad) return;
    slot.href = ad.href || "#";
    if (ad.img) {
      slot.style.background = "#000";
      slot.innerHTML = `<span class="ad-badge">Ad</span>` +
        `<img src="${ad.img}" alt="ad" style="width:100%;height:100%;object-fit:contain">`;
    } else {
      slot.style.background = "";
      slot.innerHTML = `<span class="ad-badge">Ad</span>` +
        `<span class="ad-title">${ad.title || ""}</span>` +
        `<span class="ad-sub">${ad.sub || ""}</span>`;
    }
  }

  bars.forEach((b) => render(b.slot, creatives[b.i % creatives.length]));
  if (creatives.length <= 1) return;

  setInterval(() => {
    bars.forEach((b) => {
      if (!b.slot) return;
      b.slot.classList.add("fade");
      setTimeout(() => {
        b.i = (b.i + 1) % creatives.length;
        render(b.slot, creatives[b.i]);
        b.slot.classList.remove("fade");
      }, 400);
    });
  }, ROTATE_MS);
})();
