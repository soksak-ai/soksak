// The plugin service (third execution form) declaration axis — the norm is docs/PLUGIN-SERVICE.md
// (PS clauses). parseManifest (spec.ts) is the single judge of the manifest schema — this module is
// the service axis of that judgement (declaration parsing, PS consistency rules). spec.ts
// re-exports it.
import { tmsg } from "../../i18n";
import {
  SERVICE_CONTRACT_ID_RE,
  type ContractRequirement,
  parseContractRequirement,
} from "./contracts";
import {
  checkDuplicates,
  checkKnownKeys,
  isNonEmptyString,
  isRecord,
} from "./util";

// The plugin service wire contract (PS5, PS6). A contract id starts with
// "soksak-spec-", so it never collides with a plugin id (soksak-plugin-<name>);
// the C1 scan looks for plugin id tokens in core sources and skips contract ids.
// The service interface a sidecar declares. The core requires the declaration and reads the name
// from it — it held "soksak-spec-service" here until 2026-08-16, which is the core naming an
// interface (C3, C4).
export const SERVICE_CONTRACT_REQUIREMENT_RANGE = "0.0.1";

// Command parameter spec — isomorphic to the core registry ParamSpec (src/commands/registry.ts).
// A bind:"service" command declares the full spec as manifest data (PS3) — the proxy registration
// feeds that declaration to the registry as is (synthesized handler, never hand-written).
export const PARAM_TYPES = [
  "string",
  "number",
  "boolean",
  "string[]",
  "number[]",
  "json",
] as const;
export type ServiceParamType = (typeof PARAM_TYPES)[number];
export interface ServiceParamSpec {
  type: ServiceParamType;
  description: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

// Spec fields a bind:"service" command declares additionally in the manifest (PS3).
// description = the English base (LLM discovery surface — isomorphic to CommandSpec.description;
// the human label is title).
// triggers = the non-English trigger word map (composed by composeTriggers — docs/I18N.md §3).
export interface ServiceCommandFields {
  bind?: "service";
  description?: string;
  triggers?: Record<string, string>;
  params?: Record<string, ServiceParamSpec>;
  returns?: string;
}
export const SERVICE_COMMAND_KEYS = [
  "bind",
  "description",
  "triggers",
  "params",
  "returns",
] as const;

// Service declaration (PS1, PS5, PS9, PS15) — sidecar references a resident binary in sidecars[],
// interface is the wire contract id, subscribe lists the bus topics the core bridges and pushes.
export interface ServiceDecl {
  sidecar: string;
  interface: ContractRequirement;
  subscribe: string[];
}

// Schedule trigger — exactly one variant (the same discipline as the reach strategy). reconcile is
// for poke-only firing with no timer (isomorphic to schedule.rs Reconcile), everyMs is a positive
// integer period, cron is the standard 5-field expression (the core scheduler owns interpretation
// — form only here).
export type ScheduleTrigger =
  | { reconcile: true }
  | { everyMs: number }
  | { cron: string };

// Manifest schedule declaration (PS14) — the core stamps the owner, registers and pokes on bind,
// and cancels by owner on unbind. command references a declaration in contributes.commands.
export interface ContributedSchedule {
  name: string;
  command: string;
  params?: Record<string, unknown>;
  trigger: ScheduleTrigger;
  timeoutMs?: number;
  zombieBackstopMs?: number;
}

const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// Subscribe topic — v1 covers the window bus axis only ("bus:" prefix + topic). The topic itself
// may use colon namespaces.
const SUBSCRIBE_RE = /^bus:[a-z0-9][a-z0-9:._-]*$/;
// cron 5 fields (minute hour day month weekday) — the core scheduler owns field syntax, skeleton
// only here.
const CRON_RE = /^\S+ \S+ \S+ \S+ \S+$/;

// A minimal command view — it does not depend on the whole ContributedCommand of spec.ts
// (no circular import: spec.ts → service.ts, one direction).
export interface ServiceCommandView {
  name: string;
  bind?: "service";
}

// The single source for the hello ops comparison (PS3) — the sorted set of bind:"service" command
// names. The core bind ledger, the proxy registration and hello validation all consume this
// derivation.
export function serviceOps(manifest: {
  contributes: { commands: ServiceCommandView[] };
}): string[] {
  return manifest.contributes.commands
    .filter((c) => c.bind === "service")
    .map((c) => c.name)
    .sort();
}

// Parses the top-level service block — form only (cross-consistency is validateServiceRules).
// undefined on failure.
export function parseServiceDecl(
  raw: unknown,
  errors: string[],
): ServiceDecl | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push(tmsg("plugin.manifest.service.shape"));
    return undefined;
  }
  checkKnownKeys(raw, ["sidecar", "interface", "subscribe"], "service", errors);
  let bad = false;
  if (!isNonEmptyString(raw.sidecar) || !SERVICE_NAME_RE.test(raw.sidecar.trim())) {
    errors.push(tmsg("plugin.manifest.service.sidecarName"));
    bad = true;
  }
  const interfaceRef = parseContractRequirement(
    raw.interface,
    "service.interface",
    errors,
    SERVICE_CONTRACT_ID_RE,
  );
  if (!interfaceRef) bad = true;
  const subscribe: string[] = [];
  if (raw.subscribe !== undefined) {
    if (
      !Array.isArray(raw.subscribe) ||
      !raw.subscribe.every((t) => isNonEmptyString(t) && SUBSCRIBE_RE.test(t.trim()))
    ) {
      errors.push(tmsg("plugin.manifest.service.subscribeShape"));
      bad = true;
    } else {
      subscribe.push(...raw.subscribe.map((t) => (t as string).trim()));
      checkDuplicates(subscribe, "service.subscribe", errors);
    }
  }
  if (bad) return undefined;
  return {
    sidecar: (raw.sidecar as string).trim(),
    interface: interfaceRef!,
    subscribe,
  };
}

// Parses the service spec fields of a command entry (PS3). A spec-data declaration on a command
// without bind is rejected — the runtime register owns the spec of a JS command (no dual
// ownership). null on failure (entry rejected), the field object to merge on success.
export function parseCommandServiceFields(
  v: Record<string, unknown>,
  label: string,
  errs: string[],
): ServiceCommandFields | null {
  if (v.bind === undefined) {
    for (const key of ["description", "triggers", "params", "returns"] as const) {
      if (v[key] !== undefined) {
        errs.push(tmsg("plugin.manifest.command.serviceOnly", { label, key }));
        return null;
      }
    }
    return {};
  }
  if (v.bind !== "service") {
    errs.push(tmsg("plugin.manifest.command.bind", { label }));
    return null;
  }
  if (!isNonEmptyString(v.description)) {
    errs.push(tmsg("plugin.manifest.command.description", { label }));
    return null;
  }
  const out: ServiceCommandFields = {
    bind: "service",
    description: v.description.trim(),
  };
  if (v.triggers !== undefined) {
    if (
      !isRecord(v.triggers) ||
      !Object.entries(v.triggers).every(([, val]) => isNonEmptyString(val))
    ) {
      errs.push(tmsg("plugin.manifest.command.triggers", { label }));
      return null;
    }
    out.triggers = v.triggers as Record<string, string>;
  }
  const params: Record<string, ServiceParamSpec> = {};
  if (v.params !== undefined) {
    if (!isRecord(v.params)) {
      errs.push(tmsg("plugin.manifest.command.params", { label }));
      return null;
    }
    for (const [name, spec] of Object.entries(v.params)) {
      const plabel = `${label}.params.${name}`;
      if (!isRecord(spec)) {
        errs.push(tmsg("plugin.manifest.param.shape", { label: plabel }));
        return null;
      }
      checkKnownKeys(spec, ["type", "description", "required", "enum", "default"], plabel, errs);
      if (typeof spec.type !== "string" || !PARAM_TYPES.includes(spec.type as ServiceParamType)) {
        errs.push(`${plabel}.type: ${PARAM_TYPES.join("|")}`);
        return null;
      }
      if (!isNonEmptyString(spec.description)) {
        errs.push(tmsg("plugin.manifest.param.description", { label: plabel }));
        return null;
      }
      if (spec.required !== undefined && typeof spec.required !== "boolean") {
        errs.push(`${plabel}.required: boolean`);
        return null;
      }
      if (spec.enum !== undefined) {
        if (!Array.isArray(spec.enum) || spec.enum.length === 0 || !spec.enum.every(isNonEmptyString)) {
          errs.push(tmsg("plugin.manifest.param.enum", { label: plabel }));
          return null;
        }
      }
      const p: ServiceParamSpec = {
        type: spec.type as ServiceParamType,
        description: spec.description.trim(),
      };
      if (spec.required !== undefined) p.required = spec.required as boolean;
      if (spec.enum !== undefined) p.enum = (spec.enum as string[]).map((e) => e.trim());
      if (spec.default !== undefined) p.default = spec.default;
      params[name] = p;
    }
    // An unknown key caught above is rejected through errs even without an early return
    // (all-or-nothing).
  }
  out.params = params;
  if (v.returns !== undefined) {
    if (!isNonEmptyString(v.returns)) {
      errs.push(tmsg("plugin.manifest.command.returns", { label }));
      return null;
    }
    out.returns = v.returns.trim();
  } else {
    out.returns = "object";
  }
  return out;
}

// Parses contributes.schedules (PS14) — form only (command reference consistency is
// validateServiceRules).
export function parseSchedules(raw: unknown, errors: string[]): ContributedSchedule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(tmsg("plugin.manifest.schedules.shape"));
    return [];
  }
  const out: ContributedSchedule[] = [];
  raw.forEach((item, i) => {
    const label = `contributes.schedules[${i}]`;
    if (!isRecord(item)) {
      errors.push(tmsg("plugin.manifest.schedule.shape", { label }));
      return;
    }
    checkKnownKeys(
      item,
      ["name", "command", "params", "trigger", "timeoutMs", "zombieBackstopMs"],
      label,
      errors,
    );
    if (!isNonEmptyString(item.name) || !SERVICE_NAME_RE.test(item.name.trim())) {
      errors.push(tmsg("plugin.manifest.schedule.name", { label }));
      return;
    }
    if (!isNonEmptyString(item.command)) {
      errors.push(tmsg("plugin.manifest.schedule.command", { label }));
      return;
    }
    if (item.params !== undefined && !isRecord(item.params)) {
      errors.push(tmsg("plugin.manifest.schedule.params", { label }));
      return;
    }
    const trigger = parseTrigger(item.trigger, label, errors);
    if (trigger === null) return;
    for (const key of ["timeoutMs", "zombieBackstopMs"] as const) {
      if (item[key] !== undefined && (!Number.isInteger(item[key]) || (item[key] as number) <= 0)) {
        errors.push(tmsg("plugin.manifest.schedule.positiveMs", { label, key }));
        return;
      }
    }
    const sched: ContributedSchedule = {
      name: item.name.trim(),
      command: item.command.trim(),
      trigger,
    };
    if (item.params !== undefined) sched.params = item.params as Record<string, unknown>;
    if (item.timeoutMs !== undefined) sched.timeoutMs = item.timeoutMs as number;
    if (item.zombieBackstopMs !== undefined) sched.zombieBackstopMs = item.zombieBackstopMs as number;
    out.push(sched);
  });
  checkDuplicates(out.map((s) => s.name), "contributes.schedules.name", errors);
  return out;
}

function parseTrigger(raw: unknown, label: string, errors: string[]): ScheduleTrigger | null {
  if (!isRecord(raw)) {
    errors.push(tmsg("plugin.manifest.trigger.shape", { label }));
    return null;
  }
  const variants = (["reconcile", "everyMs", "cron"] as const).filter((k) => k in raw);
  if (variants.length !== 1) {
    errors.push(tmsg("plugin.manifest.trigger.oneOf", { label }));
    return null;
  }
  const v = variants[0];
  if (v === "reconcile") {
    if (raw.reconcile !== true) {
      errors.push(tmsg("plugin.manifest.trigger.reconcile", { label }));
      return null;
    }
    return { reconcile: true };
  }
  if (v === "everyMs") {
    if (!Number.isInteger(raw.everyMs) || (raw.everyMs as number) <= 0) {
      errors.push(tmsg("plugin.manifest.trigger.everyMs", { label }));
      return null;
    }
    return { everyMs: raw.everyMs as number };
  }
  if (!isNonEmptyString(raw.cron) || !CRON_RE.test(raw.cron.trim())) {
    errors.push(tmsg("plugin.manifest.trigger.cron", { label }));
    return null;
  }
  return { cron: raw.cron.trim() };
}

// PS consistency rules (cross validation) — parseManifest calls this once after parsing
// contributes.
// PS3: bind:"service" ⇔ a service declaration + the service owns commands (≥1).
// PS4: entry:null ⇒ a service declaration ∧ every command bind:"service" ∧ 0 code-requiring
//      contributions (views, overlays, nodes, fileViewers, iconSets — the axes that need a
//      runtime provider binding).
//      headerActions/statusItems are host-declarative command bindings, so service commands alone
//      are legal.
// PS9: service.sidecar references sidecars[] (distribution and staging inherit the sidecar law).
// PS14: schedules ⇒ service (the lifetime owner), command references a declaration.
export function validateServiceRules(
  m: {
    service: ServiceDecl | undefined;
    commands: ServiceCommandView[];
    schedules: ContributedSchedule[];
    codeBoundCounts: Record<string, number>; // views/overlays/nodes/fileViewers/iconSets → count
    sidecarNames: string[];
    permissions: readonly string[];
    entryIsNull: boolean;
  },
  errors: string[],
): void {
  const boundOps = m.commands.filter((c) => c.bind === "service");
  if (m.service === undefined) {
    if (boundOps.length > 0) {
      errors.push(tmsg("plugin.manifest.service.bindNeedsService"));
    }
    if (m.schedules.length > 0) {
      errors.push(tmsg("plugin.manifest.schedules.needService"));
    }
  } else {
    if (boundOps.length === 0) {
      errors.push(tmsg("plugin.manifest.service.needsCommand"));
    }
    if (!m.sidecarNames.includes(m.service.sidecar)) {
      errors.push(tmsg("plugin.manifest.service.sidecarUndeclared", { name: m.service.sidecar }));
    }
    if (!m.permissions.includes("service")) {
      errors.push(tmsg("plugin.manifest.service.permission"));
    }
  }
  const declaredNames = new Set(m.commands.map((c) => c.name));
  for (const s of m.schedules) {
    if (!declaredNames.has(s.command)) {
      errors.push(tmsg("plugin.manifest.schedule.unknownCommand", { name: s.name, command: s.command }));
    }
  }
  if (m.entryIsNull) {
    if (m.service === undefined) {
      errors.push(tmsg("plugin.manifest.entryNull.needService"));
    }
    const jsBound = m.commands.filter((c) => c.bind !== "service");
    if (jsBound.length > 0) {
      errors.push(tmsg("plugin.manifest.entryNull.jsCommands", { n: jsBound.length }));
    }
    for (const [key, count] of Object.entries(m.codeBoundCounts)) {
      if (count > 0) {
        errors.push(tmsg("plugin.manifest.entryNull.codeContributes", { key, n: count }));
      }
    }
  }
}
