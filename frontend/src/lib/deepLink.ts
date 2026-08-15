// A deep link is a command URI(`soksak://cmd/<command>?<params>`). Every feature is a command(one address
// plane), so notification and external entry route straight to command execution(open, rule-based). All 3
// activation paths(notification click, action button, external soksak://) pass through this parser. The
// permission and danger gates stay on via remote:true — a notification cannot escalate permission(a
// destructive command takes the same settings gate).

import { execute, type CommandContext, type CommandOutcome } from "../commands/registry";
import { invoke } from "../framework";
import { tmsg } from "../i18n";

export interface DeepLink {
  command: string;
  params: Record<string, unknown>;
}

// Value coercion: the parsed value if it parses as JSON(number/bool/object), else the raw string.
function coerce(v: string): unknown {
  if (v === "") return "";
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Is this the product's command scheme — identity suffixes are accepted(`soksak:` · `soksak-dev:` …). */
function isCommandScheme(protocol: string): boolean {
  const s = protocol.replace(/:$/, "");
  return s === "soksak" || /^soksak-[a-z0-9]+$/.test(s);
}

// `soksak://cmd/<command>?<query>` → {command, params}. Format mismatch or empty command → null.
export function parseDeepLink(url: string): DeepLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // The scheme **splits per identity**(`soksak` · `soksak-dev` · `soksak-debug`) — if every identity claims
  // one scheme, which app receives the link becomes a lottery(measured 2026-08-01: this machine had over 200
  // bundles claiming `soksak:`). The verdict matches the core(soksak-core deeplink.rs is_command_scheme) —
  // writing it differently here makes a link one side parses unreadable to the other.
  if (!isCommandScheme(u.protocol) || u.host !== "cmd") return null;
  const command = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!command) return null;
  const params: Record<string, unknown> = {};
  for (const [k, v] of u.searchParams) params[k] = coerce(v);
  return { command, params };
}

// command + params → soksak:// URL(builds the deep link put into a notification). null/undefined values are omitted.
export function buildDeepLink(
  command: string,
  params: Record<string, unknown> = {},
): string {
  const sp = new URLSearchParams();
  for (const [k, val] of Object.entries(params)) {
    if (val == null) continue;
    sp.set(k, typeof val === "string" ? val : JSON.stringify(val));
  }
  const q = sp.toString();
  return `soksak://cmd/${command}${q ? `?${q}` : ""}`;
}

// Deep link activation — bring the app to front, then execute the command. deps injected for tests. remote:true keeps the danger gate.
export async function resolveDeepLink(
  url: string,
  deps: {
    execute: (
      name: string,
      params: Record<string, unknown>,
      ctx: CommandContext,
    ) => Promise<CommandOutcome>;
    activate: () => Promise<void>;
  } = {
    execute,
    activate: async () => {
      await invoke("window_activate");
    },
  },
): Promise<CommandOutcome> {
  const dl = parseDeepLink(url);
  if (!dl) {
    return { ok: false, code: "INVALID_PARAMS", message: tmsg("msg.deepLink.invalid", { url }) };
  }
  await deps.activate();
  return deps.execute(dl.command, dl.params, { remote: true });
}
