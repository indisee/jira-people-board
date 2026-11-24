// Shared board state and the board's own settings.

import { call } from "./api.js";
import { dayKey, local } from "./util.js";

export const BOARD_DEFAULTS = { refreshMinutes: 1, maxResults: 100, ownedWarnDays: 30, freshDays: 7 };
const DONE_PERIODS = [0, 7, 14, 30];

export const S = {
  /** From config_get: { settings, effective, defaults, error, zoom }. */
  config: { settings: {}, effective: { teamClause: "cf[10YYY]" }, defaults: {}, error: null, zoom: false },
  /** Board rows in board order: [{accountId, displayName, email, avatarUrl, projects:[{key,name}], addedAt, kind?, teamId?}] */
  people: [],
  /** rowId -> {state: "loading"|"ok"|"err", issues, more, url, err} */
  tickets: {},
  /** Daily notes: {"YYYY-MM-DD": {rowId: {done, doing, at}}} */
  notes: {},
  today: dayKey(),
  /** Row ids folded to one line (kept across restarts). */
  collapsed: new Set(local.get("jpd.collapsed", [])),
  /** rowId -> Set of project keys shown (empty = all). */
  filters: new Map(),
  /** Done tickets: hidden (0), or those moved to Done within the last N days. */
  donePeriod: DONE_PERIODS.includes(Number(local.raw("jpd.donePeriod"))) ? Number(local.raw("jpd.donePeriod")) : 0,
  /** The row "Next" last moved to. */
  currentId: null,
};

/** A board setting from Settings, else its default. */
export function opt(k) {
  const raw = S.config.settings[k];
  const v = Number(raw);
  return raw !== "" && raw != null && Number.isFinite(v) ? v : BOARD_DEFAULTS[k];
}

export const isTeam = p => p.kind === "team";
export const findRow = id => S.people.find(p => p.accountId === id);
export const saveCollapsed = () => local.set("jpd.collapsed", [...S.collapsed]);
export function setDonePeriod(n) {
  S.donePeriod = DONE_PERIODS.includes(n) ? n : 0;
  local.set("jpd.donePeriod", S.donePeriod);
}

/** Jira link for a ticket key. */
export function browseUrl(key) {
  const site = S.config.effective && S.config.effective.site;
  return site ? `${site}/browse/${key}` : "";
}

/** People list in people.json; file order is board order. */
export const store = {
  async init() { S.people = await call("people_load"); },
  persist() { return call("people_save", { list: S.people }); },
  save(p) {
    const i = S.people.findIndex(x => x.accountId === p.accountId);
    if (i >= 0) S.people[i] = p; else S.people.push(p);
    return this.persist();
  },
  remove(id) {
    S.people = S.people.filter(x => x.accountId !== id);
    return this.persist();
  },
};
