import { moduleState } from "../lib/moduleState";
// Activity feed folding (pure) — folds stream entries into display units. Two correlations coexist:
// (1) exact parentId correlation (canonical): an entry declaring `turnId` opens a set, and entries
//     carrying that value as `parentId` (command.executed children, command.progress deltas, the
//     closing entry) are joined in. The set is anchored to the opening seq — card visibility uses
//     the parent, not the child window.
//
//     `turnId` opens, `parentId` joins, `closesTurn` ends. MESSAGE-PROTOCOL §2 defines the
//     correlation; this reads it rather than naming a domain.
// (2) heuristic (legacy): command.progress without parentId is joined to a command.executed turn
//     by same window + command name + execution time window (plugin events.progress emission — a world with no correlation id).
// Rendering and filtering are the consumer's job — this only folds (test isolation).

export interface ActivityEntry {
  seq: number;
  ts: number;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
}

// Conversation set card — body holds every set member (child commands, deltas, answer) in seq order as-is.
// The answer may not be last (a late child after stop — displayed as it is). closed = answer present.
export interface ChatCard {
  kind: "chat";
  prompt: ActivityEntry;
  body: ActivityEntry[];
  closed: boolean;
}
export interface PlainItem {
  kind: "entry";
  entry: ActivityEntry;
  deltas?: ActivityEntry[];
}
export type FeedItem = ChatCard | PlainItem;

const parentIdOf = (e: ActivityEntry): string =>
  typeof e.payload.parentId === "string" ? e.payload.parentId : "";

// Human-hand sources — no speaker label is attached (the row's owner is the human: the window/console name is the speaker).
// Outside the hot-swap boundary — a fresh table stays empty, since the populating side records it as already populated and does not repopulate.
const HUMAN_SOURCES = moduleState("orchestrator/feedFold#HUMAN_SOURCES", () => new Set(["ui", "console"]));
/** Speaker key (§5 R3, single derivation rule) — origin first, otherwise a non-human source is the key. "" = human.
 *  The consumer's i18n table `actor.<key>` resolves the label (adding a key = 1 table line, this rule unchanged). */
export function actorKeyOf(e: ActivityEntry): string {
  const origin = typeof e.payload.origin === "string" ? e.payload.origin : "";
  if (origin) return origin;
  return HUMAN_SOURCES.has(e.source) ? "" : e.source;
}

/** Window label of a display unit — a card uses the parent (prompt) window (set visibility = parent). */
export function itemWindow(it: FeedItem): string {
  const e = it.kind === "chat" ? it.prompt : it.entry;
  return String(e.payload.window ?? "");
}

export function foldFeed(entries: ActivityEntry[]): FeedItem[] {
  // (1) Conversation sets — open a card per turnId, absorb entries with a matching parentId.
  const cards = new Map<string, ChatCard>();
  for (const e of entries) {
    if (typeof e.payload.turnId === "string" && e.payload.turnId && !parentIdOf(e)) {
      cards.set(e.payload.turnId, { kind: "chat", prompt: e, body: [], closed: false });
    }
  }
  const claimed = new Set<number>();
  for (const e of entries) {
    const card = cards.get(parentIdOf(e));
    if (!card || e.seq === card.prompt.seq) continue;
    card.body.push(e);
    if (e.payload.closesTurn === true) card.closed = true;
    claimed.add(e.seq);
  }
  // A parentId entry whose parent was pushed out of the ring/cap is displayed standalone (no information lost).

  // (2) Heuristic (legacy) — only progress deltas without parentId. Match = same window + command name
  //     (plugin emission uses the short name) + execution time window (±1.5s). Deltas before completion (still running) are displayed standalone.
  const rest = entries.filter((e) => !claimed.has(e.seq) && !cards.has(String(e.payload.turnId ?? "")));
  const matches = (full: string, short: string) => full === short || full.endsWith(`.${short}`);
  const consumed = new Set<number>();
  const deltasFor = new Map<number, ActivityEntry[]>();
  for (const e of rest) {
    if (e.kind !== "command.executed") continue;
    const p = e.payload;
    const started = Number(p.startedAt ?? 0);
    const finished = Number(p.finishedAt ?? e.ts);
    const list = rest.filter(
      (d) =>
        d.kind === "command.progress" &&
        !parentIdOf(d) &&
        !consumed.has(d.seq) &&
        String(d.payload.window ?? "") === String(p.window ?? "") &&
        matches(String(p.command ?? ""), String(d.payload.command ?? "")) &&
        d.ts >= started - 1500 &&
        d.ts <= finished + 1500,
    );
    if (list.length) {
      deltasFor.set(e.seq, list);
      for (const d of list) consumed.add(d.seq);
    }
  }

  // Display order = anchor seq (a card uses its prompt position) — preserves the original stream order.
  const items: FeedItem[] = [];
  for (const e of rest) {
    if (e.kind === "command.progress" && consumed.has(e.seq)) continue;
    items.push({ kind: "entry", entry: e, deltas: deltasFor.get(e.seq) });
  }
  for (const card of cards.values()) {
    items.push(card);
  }
  items.sort((a, b) => (a.kind === "chat" ? a.prompt.seq : a.entry.seq) - (b.kind === "chat" ? b.prompt.seq : b.entry.seq));
  return items;
}
