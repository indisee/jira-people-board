// The only way the page talks to the backend: Tauri commands (src-tauri/src).
// Errors arrive as { kind, message } (src-tauri/src/error.rs) and leave here as UiError.

const T = window.__TAURI__;

/**
 * @typedef {{ msg: string, kind: string, page?: boolean, settings?: boolean }} UiError
 * page: show it in the banner; settings: the user has to fix Settings.
 */
function uiError(e) {
  const kind = (e && e.kind) || "other";
  const message = String((e && e.message) ?? e ?? "Unknown error");
  if (kind === "auth") {
    return { kind, page: true, settings: true,
      msg: "Jira rejected the API token. Check ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the credentials file (Settings)." };
  }
  if (kind === "config") return { kind, page: true, settings: true, msg: message + ". Fix it in Settings." };
  return { kind, msg: message };
}

/** Run a backend command. Throws UiError. */
export async function call(cmd, args = {}) {
  if (!T) throw { kind: "other", page: true, msg: "This page runs inside the Jira People Board app. Start it with: npm run dev" };
  try { return await T.core.invoke(cmd, args); } catch (e) { throw uiError(e); }
}

/** Image URL served by the backend's avatar:// proxy (it adds the Jira token where needed). */
export const imgSrc = url => (T ? T.core.convertFileSrc(url, "avatar") : "");

/** Open a link in the default browser. */
export const openUrl = url => call("plugin:opener|open_url", { url });

export const listen = (event, fn) => T && T.event && T.event.listen(event, e => fn(e.payload));

export const closeWindow = () => T && T.window.getCurrentWindow().close();

export const pickFile = options => call("plugin:dialog|open", { options });
export const saveDialog = options => call("plugin:dialog|save", { options });
