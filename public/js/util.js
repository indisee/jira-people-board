// Small helpers with no app state.

export const $ = (s, r = document) => r.querySelector(s);

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escape for HTML text and attribute values. Every value from Jira or the user goes through this. */
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);

export const initials = n => (n || "?").replace(/\(.*?\)/g, "").trim().split(/\s+/).slice(0, 2)
  .map(w => w[0]).join("").toUpperCase();

/** A string usable inside an element id. */
export const domId = id => String(id).replace(/[^A-Za-z0-9_-]/g, "_");

/** Stable hue (0–359) for a string: avatars, project tints. */
export function hueOf(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** HSL → #rrggbb. */
export function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
    .toString(16).padStart(2, "0");
  return "#" + f(0) + f(8) + f(4);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** localStorage that never throws (private mode, quota, disabled storage). For UI conveniences only. */
export const local = {
  get(k, fallback) {
    try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not critical */ } },
  raw(k) { try { return localStorage.getItem(k); } catch { return null; } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* not critical */ } },
};

export const DAY = 864e5;
export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const fmtDay = k => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
};
export const clock = ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* fall back below */ }
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* nothing else to try */ }
  ta.remove();
  return ok;
}

/** Lucide-style stroke icon from path data. */
export const icon = paths =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
