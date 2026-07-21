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

// Build a SANDBOXED iframe that renders an ad tag in its own document.
// The sandbox deliberately omits `allow-same-origin` and `allow-top-navigation`,
// so the ad script cannot reach our DOM, hijack clicks, or redirect the page —
// it can only draw inside its own box and open its click-through in a new tab.
function adFrame(slot) {
  const f = document.createElement("iframe");
  f.src = `/ad-frame?slot=${encodeURIComponent(slot)}`;
  f.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  f.setAttribute("scrolling", "no");
  f.setAttribute("loading", "lazy");
  f.title = "Advertisement";
  f.style.cssText = "width:100%;height:100%;border:0;display:block;background:transparent";
  return f;
}

(async function initAds() {
  const adTop = document.getElementById("adTop");
  const adBottom = document.getElementById("adBottom");

  // ---- Mode 1: ad network (always isolated in an iframe) ----
  try {
    const net = await fetch("/api/adnetwork").then((r) => r.json());
    if (net && net.enabled && (net.topHtml || net.bottomHtml || net.headHtml)) {
      // A single site-wide tag (e.g. In-Page Push) renders once, in the bottom
      // bar, so we don't double-count impressions for one zone.
      if (net.topHtml) { adTop.innerHTML = ""; adTop.appendChild(adFrame("top")); }
      else { adTop.classList.add("collapsed"); }

      if (net.bottomHtml || net.headHtml) {
        adBottom.innerHTML = "";
        adBottom.appendChild(adFrame(net.bottomHtml ? "bottom" : "head"));
      } else {
        adBottom.classList.add("collapsed");
      }
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
