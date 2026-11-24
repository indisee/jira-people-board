/* Header notes: free text under the title, saved in memo.txt. Grows with its content; Enter continues a "• " list. */

import { call } from "./api.js";
import { $, local } from "./util.js";

const BULLET = "• ";
const OLD_KEY = "jpd.memo"; // where older versions kept it

export async function initMemo() {
  const m = $("#memo");
  if (!m) return;
  const fit = () => { m.style.height = "auto"; m.style.height = m.scrollHeight + 2 + "px"; };

  let text = null;
  try { text = await call("memo_load"); } catch { /* shown empty; typing still tries to save */ }
  if (text == null) {
    // First run with the file: bring over the memo an older version kept in the browser storage.
    text = local.raw(OLD_KEY) || "";
    if (text) call("memo_save", { text }).then(() => local.remove(OLD_KEY), () => {});
  }
  m.value = text;

  let timer;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      call("memo_save", { text: m.value }).then(
        () => { m.title = ""; },
        e => { m.title = "Not saved: " + e.msg; },
      );
    }, 400);
  };
  // execCommand keeps the native undo stack; fall back to setRangeText where it is missing.
  const put = (t, from, to) => {
    m.setSelectionRange(from, to);
    const ok = from === to && !t ? true : document.execCommand(t ? "insertText" : "delete", false, t);
    if (!ok) m.setRangeText(t, from, to, "end");
  };

  m.addEventListener("input", () => { fit(); save(); });
  m.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    e.preventDefault();
    const v = m.value, a = m.selectionStart, z = m.selectionEnd;
    const ls = v.lastIndexOf("\n", a - 1) + 1, line = v.slice(ls, a);
    if (line === BULLET && a === z) {
      put("", ls, a); // Enter on an empty bullet ends the list
    } else {
      put("\n" + BULLET, a, z);
      if (line.trim() && !line.startsWith(BULLET)) { // the line just finished had no bullet: give it one
        const at = m.selectionStart;
        put(BULLET, ls, ls);
        m.setSelectionRange(at + BULLET.length, at + BULLET.length);
      }
    }
    fit(); save();
  });
  addEventListener("resize", fit);
  requestAnimationFrame(fit);
}
