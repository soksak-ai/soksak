// Command Registry — the single truth for every soksak capability.
// Every capability is one command registered here; CLI (sok), MCP and UI are only callers.
// Docs (sok help/docs) and MCP tool definitions are generated from this spec — they cannot diverge from the code.

import { degradedAxes, emitTrace } from "./commandObservation";
import { moduleState } from "../lib/moduleState";
import type { CmdErrCode } from "../state/sessions";
import type { LocalizedText } from "../plugins/spec";
import {
  PERMISSIONS,
  contractRequirementSatisfiedBy,
  parseContractProviderRef,
  parseContractRequirement,
  type ContractProviderRef,
  type ContractRequirement,
  type PluginPermission,
  type PluginRuntimePrincipal,
} from "../plugins/spec";
import { currentWindowLabel } from "../lib/webviewLabels";
import { cliName } from "../lib/cliIdentity";
import { hasMessage, tmsg, withReaderLanguage, type MsgKey } from "../i18n";

// Parameter spec (JSON-serializable — used as is for CLI/MCP/docs generation).
export interface ParamSpec {
  // json = arbitrary JSON value (the handler validates it).
  type: "string" | "number" | "boolean" | "string[]" | "number[]" | "json";
  description: string;
  required?: boolean;
  enum?: readonly string[];
  default?: unknown;
}

// Command hint (suggestion) — follow-up command candidates attached to a result. cmd = suggested command line, why = one line on why it is useful.
// [Principle] A hint is a suggestion, not an instruction — it states what is possible so the receiver (human or AI)
// can decide. Not binding: the receiver may ignore it or do something else.
export interface CommandHint {
  cmd: string;
  why: string;
}

// Result contract of the plugin broker. `returns` is the human-readable description; this schema is the machine
// contract that checks normalized CommandOutcome.data. Deliberately a small, closed grammar only.
// Executable schema seams such as $ref, conditionals or user functions are not allowed.
export type CommandMachineSchema =
  | { readonly type: "null" }
  | { readonly type: "boolean" }
  | { readonly type: "json" }
  | {
      readonly type: "number" | "integer";
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: "string";
      readonly enum?: readonly string[];
      readonly maxLength?: number;
    }
  | {
      readonly type: "array";
      readonly items: CommandMachineSchema;
      readonly maxItems?: number;
    }
  | CommandMachineObjectSchema;

export interface CommandMachineObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CommandMachineSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
}

export type CommandBrokerAuthoritySource =
  | { readonly kind: "runtime-id" }
  | { readonly kind: "session-id" }
  | { readonly kind: "window-label" }
  | { readonly kind: "plugin-id" }
  | { readonly kind: "generation" }
  | { readonly kind: "role" }
  | { readonly kind: "contribution-id" }
  | { readonly kind: "instance-id" }
  | { readonly kind: "namespace" }
  | { readonly kind: "path"; readonly key: string }
  | { readonly kind: "label"; readonly key: string }
  | { readonly kind: "coordinates"; readonly key: string };

export interface CommandBrokerAuthorityBinding {
  /** Command parameter owned by the host. Plugin payloads may not contain it. */
  readonly param: string;
  readonly source: CommandBrokerAuthoritySource;
}

export interface CommandBrokerSpec {
  /** Every permission is explicit. `commands` is always required for command.execute. */
  readonly permissions: readonly PluginPermission[];
  /**
   * requires: contracts the caller must provide (its manifest `implements`).
   * provides: contracts this host command provides and the caller must require (`consumes`).
   */
  readonly contracts: {
    readonly requires: readonly ContractRequirement[];
    readonly provides: readonly ContractProviderRef[];
  };
  /** Host-owned selector/identity values injected after rejecting caller copies. */
  readonly authority: readonly CommandBrokerAuthorityBinding[];
  /** Schema for normalized successful CommandOutcome.data (`{}` when data is absent). */
  readonly result: CommandMachineObjectSchema;
}

export interface CommandSpec {
  // description = English base (role, what, when, why). LLM discovery surface — no stub (name copy-paste). Not a human UI.
  description: string;
  // triggers = per-language trigger words for non-English languages (space separated). composeTriggers merges them into base on exposure.
  // The base prose handles English matching, so en is usually omitted. Adding a language (ja/zh) = add a key to this map (docs/I18N.md §3).
  triggers?: Record<string, string>;
  params: Record<string, ParamSpec>;
  // Owner of the parameter contract. Default "registry" = declaration-based validation (undeclared keys rejected — typos caught early).
  // "handler" = the contract is behind the handler (inside the native runtime plugin), so this layer only passes through —
  // runtime command proxies only. Forbidden for an ordinary command as a way to skip validation.
  paramsAuthority?: "registry" | "handler";
  // Human-readable command label (announcer style — "Initializes the git repository"). Display surfaces (feed bubbles etc.)
  // resolve this into the current language instead of showing the raw key. A plugin command uses the title from manifest
  // contributes.commands (owned by the plugin). The single truth for a label is the command definition itself — no separate table.
  title?: LocalizedText;
  // Description of the success response shape (for the manual).
  returns: string;
  // Whether this command's answer is **window-local**. Default is window-local (omitted = true) — the safe side is the default.
  //
  // `false` = the **owner** (store, daemon, process, network), not the window, determines the answer. The answer is then
  // the same in whichever window it runs, and it must run **once** when several windows hold the same label.
  //
  // Why this is needed: two apps in one home make two windows hold a label such as `main` (one orchestrator per app).
  // Sending a command addressed to that label to all of them is correct for a window-local command, but a command the
  // owner answers **runs the same work twice** (measured 2026-08-01: `data.kv.set` ran in both processes
  // separately). Where the answer comes from is a property of the command — so it is declared here.
  //
  // This declaration is **derivable**: if the handler touches window-local state (useSessions, document, window.…) it is
  // window-local. The gate recounts it from source and compares it against the declaration (owner-answer-scan).
  windowScoped?: boolean;
  // Standard answer (message, display) — the success data as one human-readable line. **Required**: every command
  // supplies its own answer. No guessing layer (shape derivation) and no code-echo fallback. tmsg (key table) resolves
  // the sentence into the current language (P0 — adding a language = adding a table column). docs/MESSAGE-PROTOCOL.md response envelope contract.
  message: (data: Record<string, unknown>) => string;
  // Spoken sentence (speak) — the seam symmetric to message (display). This is the only speech axis (§3): with speak,
  // speak(outcome) is the sentence for both success and failure; without it message is the fallback; "" = silence. A
  // command that performs speech (say and friends) cuts the feedback loop with speak: () => "". Built with tmsg like message (P0).
  speak?: (out: CommandOutcome) => string;
  // Success hint (suggestion) — on success, suggests the moves the receiver may make next (max 3, execute truncates).
  // A self-describing field in the same vein as message/speak: the command declares its own follow-ups. Takes the
  // response payload (data) and the call ctx and builds CommandHint[]. [Principle] A suggestion, not an instruction —
  // it helps the receiver decide. On exception execute omits the hint instead of breaking the response.
  hint?: (data: Record<string, unknown>, ctx: CommandContext) => CommandHint[];
  // Service envelope seam (PS7, docs/PLUGIN-SERVICE.md) — only for the synthesized proxy of bind:"service" commands.
  // With "service" the handler envelope's message and hints are preserved as is (the command implementation still owns
  // the human sentence but delivers it over the wire — the ownership rule of MESSAGE-PROTOCOL §3 is unchanged). Never
  // open this to the plugin JS spec: the only registration path is serviceProxy (core synthesis). No unofficial seam such as a $-prefix bypass.
  envelope?: "service";
  /** Primary target parameter of the bare-value syntax — when the required parameters are not exactly one (e.g. omitted = all),
   *  names the one that takes the positional argument (a single value). Undeclared applies only the "sole required parameter" rule. */
  primary?: string;
  // Error codes this command can return.
  errors?: readonly (
    | CmdErrCode
    | "INTERNAL"
    | "TIMEOUT"
    | "AMBIGUOUS_TARGET"
    // Several windows hold this label, so the side effects overwrite each other — the target is not missing but **plural**.
    | "AMBIGUOUS_HOST"
    // The node is visible but its substance is in another realm — observable here, manipulation must go to that realm.
    | "OTHER_REALM"
    | "ALREADY_EXISTS"
    // The node is exposed but its actual rect is offscreen — there are no pixels to capture or measure.
    | "OFFSCREEN"
    // The surface exists but **this framework does not hold it** — a surface drawn by a sidecar engine is owned by
    // that plugin, and the core input path does not extend there.
    | "SURFACE_INPUT_UNAVAILABLE"
    // This address is not a surface — the request asked for a fact only a surface has.
    | "NOT_A_SURFACE"
    // The projection did not declare the facts manipulation needs — it declared which realm, but not where inside it.
    // Passing this to the host DOM does nothing and still returns success.
    | "PROJECTION_UNDECLARED"
  )[];
  // CLI usage examples (for the manual).
  examples?: readonly string[];
  // Danger class (subject to the permission gate on remote/AI calls): destructive = close or remove, inject = input injection.
  danger?: "destructive" | "inject";
  // Isolated plugin calls are opt-in. Only a command whose declaration fully validates is open to executeFromPlugin.
  // Never expose an undeclared legacy command implicitly.
  broker?: CommandBrokerSpec;
  // Execution instrumentation declaration — false excludes this command's runs from the activity trace (command.executed).
  // §5 R2: the only legitimate reason is "avoid double-recording the same fact" (orchestrator.ask — chat.prompt/
  // answer is the representative record of that turn). Never declare it to suppress noise — that is origin's job (the exposure axis).
  trace?: false;
  // [RULE] Never put a top-level "id" on the handler return object — the socket response merges into one object with the
  // JSON-RPC envelope's request id (a number) and overwrites it (identifier lost). Use namespaced fields for identifiers
  // (paneId/tabId/messageId/label …). For the same reason use "ok"/"code"/"message" with their result meaning only.
  handler: (
    params: Record<string, unknown>,
    ctx: CommandContext,
  ) => Promise<object> | object;
}

// Caller context: for a call from a terminal this is that tab (PTY env SOKSAK_CALLER_TAB → socket request meta).
// The field name pane is the socket wire field name (renaming it goes together with the protocol axis).
// remote = via the socket (AI/CLI) — the permission gate applies to remote calls only (UI is a human).
export interface CommandContext {
  pane?: string;
  remote?: boolean;
  // Multi-window: label of the window this command arrived at (socket emit_to target). For window commands (window.*) and routing checks.
  window?: { label: string };
  // Correlation parent (conversation turn id) — agent env SOKSAK_PARENT → arrives in the sok request meta. Becomes the
  // trace parentId and groups this run into that turn's activity set (docs/MESSAGE-PROTOCOL.md).
  parent?: string;
  // Run origin (§5) — omitted = human origin (console, terminal, agent turn). System origins such as "schedule" are
  // excluded from speech candidates (execute below) and dimmed in the feed.
  origin?: string;
  /**
   * How many hosts are performing this same request.
   *
   * A label can be held by more than one framework at once (`main` is an orchestrator role, and
   * workspace windows deliberately reuse their stored `w-<uuid>`), and a request that cannot pick
   * one goes to all of them. A command whose side effect lands at a caller-named place must know
   * that: two performers writing the same file both answer OK and only one file survives (measured
   * 2026-08-08, `window.snapshot {path}`). Absent means one.
   */
  hosts?: number;
  /**
   * Register a side effect that may run only after the caller has received this command's result.
   * The socket executor owns this boundary. Commands that terminate or replace their own host must
   * use it so a successful result cannot be destroyed together with the process.
   */
  afterReply?: (task: CommandAfterReplyTask) => void;
  // Isolated runtime principal/grant. Only an object issued by issuePluginCommandContext is authenticated.
  // An object deserialized from a plugin message does not pass the WeakSet check even when passed in directly.
  readonly plugin?: AuthenticatedPluginCommandIdentity;
}

export type CommandAfterReplyTask = () => Promise<void> | void;

export type PluginAuthorityJson =
  | null
  | boolean
  | number
  | string
  | readonly PluginAuthorityJson[]
  | { readonly [key: string]: PluginAuthorityJson };

export interface PluginCommandGrants {
  readonly permissions: readonly PluginPermission[];
  readonly requiredContracts: readonly ContractRequirement[];
  readonly providedContracts: readonly ContractProviderRef[];
}

export interface PluginCommandAuthority {
  readonly namespace: string;
  readonly paths: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly coordinates: Readonly<Record<string, PluginAuthorityJson>>;
}

export interface AuthenticatedPluginCommandIdentity {
  readonly principal: PluginRuntimePrincipal;
  readonly grants: PluginCommandGrants;
  readonly authority: PluginCommandAuthority;
}

export interface PluginCommandContext extends CommandContext {
  readonly remote: true;
  readonly window: { readonly label: string };
  readonly origin: "plugin";
  readonly plugin: AuthenticatedPluginCommandIdentity;
}

export interface PluginCommandContextInput {
  readonly principal: PluginRuntimePrincipal;
  readonly grants: PluginCommandGrants;
  readonly authority: PluginCommandAuthority;
  readonly pane?: string;
  readonly parent?: string;
}

// Permission gate callback (injected so the registry holds no direct reference to the settings store).
// Returns whether a danger class is allowed.
// Outside the hot-swap boundary — a fresh gate resets the human-approval decision to the default,
// and that reset surfaces only as "why was I not asked".
const gate = moduleState("commands/registry#gate.v", () => ({
  v: (() => true) as (danger: "destructive" | "inject") => boolean,
}));

export function setPermissionGate(
  fn: (danger: "destructive" | "inject") => boolean,
): void {
  gate.v = fn;
}

// Standard response envelope (the response of the request/progress/response trio) — symmetric for success and failure. Single truth: docs/MESSAGE-PROTOCOL.md.
//   ok      success/failure
//   code    success: "OK" or a domain code (CREATED, NOOP, UNCHANGED…), failure: the closed ErrCode enum
//   message one human-readable standard answer line (success and failure — the bubble renders this). Provided by the command (spec.message).
//   data    machine payload (optional, nested — removes any collision with the envelope's reserved keys)
export type ErrCode =
  | CmdErrCode
  | "INTERNAL"
  | "TIMEOUT"
  | "UNKNOWN_COMMAND"
  // The registry is entirely empty — not a name problem but a registration problem (boot incomplete, state lost).
  | "REGISTRY_EMPTY"
  | "INVALID_PARAMS"
  | "AMBIGUOUS_TARGET"
  | "AMBIGUOUS_HOST"
  | "ALREADY_EXISTS"
  | "PERMISSION_DENIED"
  | "PLUGIN_AUTH_REQUIRED"
  | "PLUGIN_ENTRYPOINT_REQUIRED"
  | "PLUGIN_CALL_FORBIDDEN"
  | "PLUGIN_AUTHORITY_FORBIDDEN"
  | "PLUGIN_AUTHORITY_UNAVAILABLE"
  | "PLUGIN_CONTRACT_DENIED"
  | "PLUGIN_RESULT_INVALID";
// Display media (optional) — the response itself declares content to render as is, such as an image (matches MCP content).
// Consumers (feed, phone, future surfaces) render from media alone, with no key sniffing. Either base64 or path.
export interface MediaContent {
  kind: string; // MIME type, such as "image/png"
  base64?: string;
  path?: string;
}

export interface CommandOutcome {
  ok: boolean;
  code: string;
  message: string;
  data?: Record<string, unknown>;
  media?: MediaContent;
  // Label of the window where this response was assembled (multi-window correlation and routing). execute adds it on every path (success and failure).
  window?: string;
  // Follow-up command candidates (suggestion) — spec.hint on success, standard per-error-code guidance on failure. Max 3.
  hint?: CommandHint[];
  // Degraded core axes — present **whatever this response answered**. A fact that takes a separate query is one nobody
  // queries (measured: activity publishing had stopped while the app answered fine, and finding out took two ledger
  // queries and a timestamp comparison). When the axes are healthy this key is absent.
  degraded?: string[];
}
// Backward-compatible alias — keeps existing references that named the failure envelope.
export type CommandError = CommandOutcome & { ok: false };

const MAX_MACHINE_SCHEMA_DEPTH = 16;
const MAX_MACHINE_SCHEMA_NODES = 512;
const MAX_MACHINE_RESULT_ERRORS = 16;
// Outside the hot-swap boundary — a fresh table is never refilled: the filler already recorded that it filled one.
const UNSAFE_RECORD_KEYS = moduleState("commands/registry#UNSAFE_RECORD_KEYS", () => new Set(["__proto__", "prototype", "constructor"]));
// Outside the hot-swap boundary — a fresh table is never refilled: the filler already recorded that it filled one.
const PLUGIN_ROLES = moduleState("commands/registry#PLUGIN_ROLES", () => new Set(["controller", "view", "file-viewer", "overlay", "preview"]));
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreezeValue(structuredClone(value));
}

function deepFreezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeValue(child);
    Object.freeze(value);
  }
  return value;
}

function machineSchemaDefinitionErrors(raw: unknown): string[] {
  const errors: string[] = [];
  const counter = { nodes: 0 };
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_MACHINE_SCHEMA_DEPTH) {
      errors.push(`${path}: schema depth exceeds ${MAX_MACHINE_SCHEMA_DEPTH}`);
      return;
    }
    counter.nodes += 1;
    if (counter.nodes > MAX_MACHINE_SCHEMA_NODES) {
      if (counter.nodes === MAX_MACHINE_SCHEMA_NODES + 1) {
        errors.push(`${path}: schema node count exceeds ${MAX_MACHINE_SCHEMA_NODES}`);
      }
      return;
    }
    if (!isPlainRecord(value) || typeof value.type !== "string") {
      errors.push(`${path}: closed machine schema object required`);
      return;
    }
    const allowed = new Set<string>(["type"]);
    switch (value.type) {
      case "null":
      case "boolean":
      case "json":
        break;
      case "number":
      case "integer": {
        allowed.add("minimum");
        allowed.add("maximum");
        if (value.minimum !== undefined && (typeof value.minimum !== "number" || !Number.isFinite(value.minimum))) {
          errors.push(`${path}.minimum: finite number required`);
        }
        if (value.maximum !== undefined && (typeof value.maximum !== "number" || !Number.isFinite(value.maximum))) {
          errors.push(`${path}.maximum: finite number required`);
        }
        if (
          typeof value.minimum === "number" &&
          typeof value.maximum === "number" &&
          value.minimum > value.maximum
        ) errors.push(`${path}: minimum must not exceed maximum`);
        break;
      }
      case "string": {
        allowed.add("enum");
        allowed.add("maxLength");
        if (value.enum !== undefined && (
          !Array.isArray(value.enum) ||
          value.enum.length === 0 ||
          value.enum.some((item) => typeof item !== "string") ||
          new Set(value.enum).size !== value.enum.length
        )) errors.push(`${path}.enum: non-empty unique string array required`);
        if (
          value.maxLength !== undefined &&
          (!Number.isSafeInteger(value.maxLength) || (value.maxLength as number) < 0)
        ) errors.push(`${path}.maxLength: non-negative safe integer required`);
        break;
      }
      case "array": {
        allowed.add("items");
        allowed.add("maxItems");
        if (!("items" in value)) errors.push(`${path}.items: required`);
        else visit(value.items, `${path}.items`, depth + 1);
        if (
          value.maxItems !== undefined &&
          (!Number.isSafeInteger(value.maxItems) || (value.maxItems as number) < 0)
        ) errors.push(`${path}.maxItems: non-negative safe integer required`);
        break;
      }
      case "object": {
        allowed.add("properties");
        allowed.add("required");
        allowed.add("additionalProperties");
        if (!isPlainRecord(value.properties)) {
          errors.push(`${path}.properties: object required`);
        } else {
          for (const [key, child] of Object.entries(value.properties)) {
            if (!key || UNSAFE_RECORD_KEYS.has(key)) errors.push(`${path}.properties: unsafe property "${key}"`);
            visit(child, `${path}.properties.${key}`, depth + 1);
          }
        }
        if (
          !Array.isArray(value.required) ||
          value.required.some((item) => typeof item !== "string") ||
          new Set(value.required).size !== value.required.length
        ) {
          errors.push(`${path}.required: unique string array required`);
        } else if (isPlainRecord(value.properties)) {
          for (const key of value.required) {
            if (!Object.prototype.hasOwnProperty.call(value.properties, key)) {
              errors.push(`${path}.required: unknown property "${key}"`);
            }
          }
        }
        if (typeof value.additionalProperties !== "boolean") {
          errors.push(`${path}.additionalProperties: boolean required`);
        }
        break;
      }
      default:
        errors.push(`${path}.type: unsupported machine schema type`);
    }
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) errors.push(`${path}: unknown schema keyword "${key}"`);
    }
  };
  visit(raw, "$", 0);
  return errors;
}

function pushMachineResultError(errors: string[], message: string): void {
  if (errors.length < MAX_MACHINE_RESULT_ERRORS) errors.push(message);
}

/** Validate the exact in-memory domain representable by JSON, without invoking getters. */
function validateJsonMachineValue(
  value: unknown,
  path: string,
  errors: string[],
  depth: number,
  ancestors: WeakSet<object>,
): void {
  if (errors.length >= MAX_MACHINE_RESULT_ERRORS) return;
  if (depth > MAX_MACHINE_SCHEMA_DEPTH) {
    pushMachineResultError(errors, `${path}: result depth exceeds ${MAX_MACHINE_SCHEMA_DEPTH}`);
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) pushMachineResultError(errors, `${path}: finite JSON number required`);
    return;
  }
  if (typeof value !== "object") {
    pushMachineResultError(errors, `${path}: JSON value required`);
    return;
  }
  if (ancestors.has(value)) {
    pushMachineResultError(errors, `${path}: cyclic result forbidden`);
    return;
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      pushMachineResultError(errors, `${path}: safe JSON array prototype required`);
      return;
    }
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    let itemCount = 0;
    for (const key of keys) {
      if (errors.length >= MAX_MACHINE_RESULT_ERRORS) break;
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
        pushMachineResultError(errors, `${path}: JSON array has a non-index property`);
        continue;
      }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
        pushMachineResultError(errors, `${path}.${key}: safe JSON array index required`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        pushMachineResultError(errors, `${path}[${key}]: JSON data property required`);
        continue;
      }
      itemCount += 1;
      validateJsonMachineValue(descriptor.value, `${path}[${key}]`, errors, depth + 1, ancestors);
    }
    if (itemCount !== value.length) {
      pushMachineResultError(errors, `${path}: sparse JSON array forbidden`);
    }
    ancestors.delete(value);
    return;
  }

  if (!isPlainRecord(value)) {
    pushMachineResultError(errors, `${path}: safe plain JSON object required`);
    return;
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (errors.length >= MAX_MACHINE_RESULT_ERRORS) break;
    if (typeof key !== "string") {
      pushMachineResultError(errors, `${path}: symbol JSON key forbidden`);
      continue;
    }
    if (UNSAFE_RECORD_KEYS.has(key)) {
      pushMachineResultError(errors, `${path}: unsafe JSON key "${key}"`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      pushMachineResultError(errors, `${path}.${key}: JSON data property required`);
      continue;
    }
    validateJsonMachineValue(descriptor.value, `${path}.${key}`, errors, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

function validateMachineValue(
  schema: CommandMachineSchema,
  value: unknown,
  path: string,
  errors: string[],
  depth = 0,
  ancestors = new WeakSet<object>(),
): void {
  if (errors.length >= MAX_MACHINE_RESULT_ERRORS) return;
  if (depth > MAX_MACHINE_SCHEMA_DEPTH) {
    errors.push(`${path}: result depth exceeds ${MAX_MACHINE_SCHEMA_DEPTH}`);
    return;
  }
  switch (schema.type) {
    case "null":
      if (value !== null) errors.push(`${path}: null required`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: boolean required`);
      return;
    case "json":
      validateJsonMachineValue(value, path, errors, depth, ancestors);
      return;
    case "number":
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isSafeInteger(value))
      ) {
        errors.push(`${path}: ${schema.type} required`);
        return;
      }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
      return;
    case "string":
      if (typeof value !== "string") {
        errors.push(`${path}: string required`);
        return;
      }
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: value is outside enum`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: string too long`);
      return;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${path}: array required`);
        return;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: array too long`);
      if (ancestors.has(value)) {
        errors.push(`${path}: cyclic result forbidden`);
        return;
      }
      ancestors.add(value);
      value.forEach((item, index) => validateMachineValue(schema.items, item, `${path}[${index}]`, errors, depth + 1, ancestors));
      ancestors.delete(value);
      return;
    case "object":
      if (!isPlainRecord(value)) {
        errors.push(`${path}: plain object required`);
        return;
      }
      if (ancestors.has(value)) {
        errors.push(`${path}: cyclic result forbidden`);
        return;
      }
      ancestors.add(value);
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key}: required`);
      }
      for (const [key, item] of Object.entries(value)) {
        const child = schema.properties[key];
        if (!child) {
          if (!schema.additionalProperties) errors.push(`${path}.${key}: additional property forbidden`);
          continue;
        }
        validateMachineValue(child, item, `${path}.${key}`, errors, depth + 1, ancestors);
      }
      ancestors.delete(value);
  }
}

function authorityParamType(source: CommandBrokerAuthoritySource): ParamSpec["type"] {
  if (source.kind === "generation") return "number";
  if (source.kind === "coordinates") return "json";
  return "string";
}

function certifyBrokerSpec(name: string, command: CommandSpec): CommandBrokerSpec {
  const raw = command.broker as unknown;
  if (!isPlainRecord(raw)) throw new TypeError(`${name}.broker: object required`);
  const errors: string[] = [];
  const permissions = Array.isArray(raw.permissions) ? raw.permissions : [];
  if (!Array.isArray(raw.permissions) || permissions.length === 0) {
    errors.push("permissions: non-empty array required");
  } else {
    if (permissions.some((permission) => typeof permission !== "string" || !PERMISSIONS.includes(permission as PluginPermission))) {
      errors.push("permissions: unknown plugin permission");
    }
    if (new Set(permissions).size !== permissions.length) errors.push("permissions: duplicates forbidden");
    if (!permissions.includes("commands")) errors.push('permissions: "commands" required');
    if (command.danger === "destructive" && !permissions.includes("commands:destructive")) {
      errors.push('permissions: danger destructive requires "commands:destructive"');
    }
    if (command.danger === "inject" && !permissions.includes("commands:inject")) {
      errors.push('permissions: danger inject requires "commands:inject"');
    }
  }

  const contracts = isPlainRecord(raw.contracts) ? raw.contracts : null;
  if (!contracts) errors.push("contracts: { requires, provides } required");
  const requiresRaw = contracts && Array.isArray(contracts.requires) ? contracts.requires : [];
  const providesRaw = contracts && Array.isArray(contracts.provides) ? contracts.provides : [];
  if (contracts && !Array.isArray(contracts.requires)) errors.push("contracts.requires: array required");
  if (contracts && !Array.isArray(contracts.provides)) errors.push("contracts.provides: array required");
  const contractErrors: string[] = [];
  const requires = requiresRaw.flatMap((item, index) => {
    const parsed = parseContractRequirement(item, `broker.contracts.requires[${index}]`, contractErrors);
    return parsed ? [parsed] : [];
  });
  const provides = providesRaw.flatMap((item, index) => {
    const parsed = parseContractProviderRef(item, `broker.contracts.provides[${index}]`, contractErrors);
    return parsed ? [parsed] : [];
  });
  errors.push(...contractErrors);
  if (new Set(requires.map((contract) => contract.id)).size !== requires.length) {
    errors.push("contracts.requires: duplicate ids forbidden");
  }
  if (new Set(provides.map((contract) => contract.id)).size !== provides.length) {
    errors.push("contracts.provides: duplicate ids forbidden");
  }

  const authorityRaw = Array.isArray(raw.authority) ? raw.authority : [];
  if (!Array.isArray(raw.authority)) errors.push("authority: array required");
  const authority: CommandBrokerAuthorityBinding[] = [];
  const boundParams = new Set<string>();
  for (let index = 0; index < authorityRaw.length; index += 1) {
    const binding = authorityRaw[index];
    if (!isPlainRecord(binding) || typeof binding.param !== "string" || !isPlainRecord(binding.source)) {
      errors.push(`authority[${index}]: { param, source } required`);
      continue;
    }
    const param = binding.param;
    const source = binding.source as Record<string, unknown>;
    const kind = source.kind;
    const keyed = kind === "path" || kind === "label" || kind === "coordinates";
    const known = [
      "runtime-id", "session-id", "window-label", "plugin-id", "generation", "role",
      "contribution-id", "instance-id", "namespace", "path", "label", "coordinates",
    ].includes(String(kind));
    if (!known || (keyed && (typeof source.key !== "string" || !source.key))) {
      errors.push(`authority[${index}].source: valid host authority source required`);
      continue;
    }
    const allowedKeys = keyed ? ["kind", "key"] : ["kind"];
    if (Object.keys(source).some((key) => !allowedKeys.includes(key))) {
      errors.push(`authority[${index}].source: unknown field`);
      continue;
    }
    if (!param || UNSAFE_RECORD_KEYS.has(param) || !Object.prototype.hasOwnProperty.call(command.params, param)) {
      errors.push(`authority[${index}].param: declared safe command param required`);
      continue;
    }
    if (boundParams.has(param)) {
      errors.push(`authority[${index}].param: duplicate binding`);
      continue;
    }
    const typedSource = source as unknown as CommandBrokerAuthoritySource;
    if (command.params[param].type !== authorityParamType(typedSource)) {
      errors.push(`authority[${index}].param: ${authorityParamType(typedSource)} param required`);
      continue;
    }
    boundParams.add(param);
    authority.push({ param, source: typedSource });
  }

  const resultErrors = machineSchemaDefinitionErrors(raw.result);
  errors.push(...resultErrors.map((error) => `result${error.slice(1)}`));
  if (isPlainRecord(raw.result) && raw.result.type !== "object") {
    errors.push("result.type: object required for normalized CommandOutcome.data");
  }
  const allowedBrokerKeys = new Set(["permissions", "contracts", "authority", "result"]);
  for (const key of Object.keys(raw)) if (!allowedBrokerKeys.has(key)) errors.push(`unknown broker field "${key}"`);
  if (errors.length > 0) throw new TypeError(`${name}.broker: ${errors.join("; ")}`);

  return cloneAndFreeze({
    permissions: permissions as PluginPermission[],
    contracts: { requires, provides },
    authority,
    result: raw.result as unknown as CommandMachineObjectSchema,
  });
}

// The registry is outside the module boundary — a dev hot-swap replaces this Map with a fresh empty one, while the place
// that fills it (executor's started) is in another module and is not replaced with it. Re-registration then never
// arrives and the core commands disappear entirely (measured 2026-07-31 — the user saw the tab + button create nothing).
const registry = moduleState(
  "commands/registry#registry",
  () => new Map<string, CommandSpec>(),
);
const authenticatedPluginContexts = moduleState(
  "commands/registry#authenticatedPluginContexts",
  () => new WeakSet<object>(),
);

function snapshotCommandSpec(spec: CommandSpec, broker: CommandBrokerSpec | undefined): CommandSpec {
  // getSpec/catalog are read surfaces, not mutation seams. In particular, a caller must not add
  // broker metadata to a legacy command or change a certified authority parameter after register.
  const stored: CommandSpec = {
    ...spec,
    params: cloneAndFreeze(spec.params),
    ...(spec.triggers ? { triggers: cloneAndFreeze(spec.triggers) } : {}),
    ...(spec.title ? { title: cloneAndFreeze(spec.title) } : {}),
    ...(spec.errors ? { errors: cloneAndFreeze(spec.errors) } : {}),
    ...(spec.examples ? { examples: cloneAndFreeze(spec.examples) } : {}),
    ...(broker ? { broker } : {}),
  };
  if (!broker) delete stored.broker;
  return Object.freeze(stored);
}

// Who is told when the set of commands this window answers changes.
//
// The backend holds a delegation table built from a declaration this page sends. Sent once at the
// end of boot, it goes stale the moment a plugin is enabled afterwards: measured 2026-08-16, a
// plugin command the window answered was refused by the socket as not registered, while
// plugin.conformance counted it. §3.5 has one registry, and a window registry that disagrees with
// the backend's delegation is two.
//
// A signal rather than a call at each site, because the sites are the plugin lifecycle in three
// places and whoever adds a fourth would have to know to send it.
const registryWatchers = new Set<() => void>();
let noticeScheduled = false;

/** Subscribe to registry changes. Returns the unsubscribe. */
export function onRegistryChange(listener: () => void): () => void {
  registryWatchers.add(listener);
  return () => registryWatchers.delete(listener);
}

// Collapsed into one microtask. A plugin registers every command it declares in a row, and one
// notice per command would have the backend rebuild its delegation table as many times as the
// plugin has commands — each declaration being the whole catalogue anyway.
function noticeRegistryChange(): void {
  if (noticeScheduled || registryWatchers.size === 0) return;
  noticeScheduled = true;
  queueMicrotask(() => {
    noticeScheduled = false;
    for (const listener of [...registryWatchers]) {
      try {
        listener();
      } catch (e) {
        // One watcher's failure is not the others'. Chaining them would make the second failure
        // depend on the first with nothing reporting that it did.
        console.error("[registry] a change listener failed:", e);
      }
    }
  });
}

export function register(name: string, spec: CommandSpec): void {
  // Re-registering the same name is a programming error — Map overwrites silently and turns the earlier registration
  // into dead code (real case: duplicate window.focus). Surface it as an error at once. A legitimate replacement calls unregister first.
  if (registry.has(name)) {
    throw new Error(`duplicate registration: ${name} — call unregister before registering again`);
  }
  const broker = spec.broker ? certifyBrokerSpec(name, spec) : undefined;
  const stored = snapshotCommandSpec(spec, broker);
  registry.set(name, stored);
  noticeRegistryChange();
}

// Unregister — for the plugin lifecycle (disable/remove) only. True when it existed.
export function unregister(name: string): boolean {
  // A name that was never there changes nothing, and announcing it would have the backend rebuild
  // its table for a no-op.
  if (!registry.delete(name)) return false;
  noticeRegistryChange();
  return true;
}

// The name was not found — but there are two **reasons** it was not. Blurring them hides the cause from the outside.
//
//   The registry is empty = a defect. Registration has not arrived yet (booting) or a hot-swap dropped it.
//   The registry is full but lacks the name = a fact. A typo, or not a capability of that window.
//
// Measured 2026-07-31: the core commands disappeared entirely and the response was the unknown-command line for
// ui.validate. That sentence is word for word the second case, so the first was unreadable from the outside.
function unknownCommand(name: string): CommandOutcome {
  if (registry.size === 0) {
    return {
      ok: false,
      code: "REGISTRY_EMPTY",
      message: tmsg("msg.command.registryEmpty", { name }),
    };
  }
  return { ok: false, code: "UNKNOWN_COMMAND", message: tmsg("msg.command.unknown", { name }) };
}

export function getSpec(name: string): CommandSpec | undefined {
  return registry.get(name);
}

function validateAuthorityJson(
  value: unknown,
  path: string,
  errors: string[],
  depth = 0,
  nodes = { count: 0 },
  ancestors = new WeakSet<object>(),
): void {
  if (depth > MAX_MACHINE_SCHEMA_DEPTH) {
    errors.push(`${path}: JSON depth exceeds ${MAX_MACHINE_SCHEMA_DEPTH}`);
    return;
  }
  nodes.count += 1;
  if (nodes.count > 8_192) {
    if (nodes.count === 8_193) errors.push(`${path}: JSON node count exceeds 8192`);
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${path}: finite JSON number required`);
    return;
  }
  if (typeof value !== "object") {
    errors.push(`${path}: JSON value required`);
    return;
  }
  if (ancestors.has(value)) {
    errors.push(`${path}: cyclic JSON forbidden`);
    return;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateAuthorityJson(item, `${path}[${index}]`, errors, depth + 1, nodes, ancestors));
  } else if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!key || UNSAFE_RECORD_KEYS.has(key)) errors.push(`${path}: unsafe JSON key "${key}"`);
      validateAuthorityJson(item, `${path}.${key}`, errors, depth + 1, nodes, ancestors);
    }
  } else {
    errors.push(`${path}: plain JSON object required`);
  }
  ancestors.delete(value);
}

function nonEmptyBounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/**
 * Trusted host seam. Call only after the native runtime session authenticated the principal
 * and the verified manifest/consent resolver produced the grant snapshot. The returned object
 * is cloned, deeply frozen and WeakSet-certified; a deserialized plugin payload cannot forge it.
 */
export function issuePluginCommandContext(input: PluginCommandContextInput): PluginCommandContext {
  let snapshot: PluginCommandContextInput;
  try {
    snapshot = structuredClone(input);
  } catch {
    throw new TypeError("plugin command context must be structured-cloneable");
  }
  const errors: string[] = [];
  if (!isPlainRecord(snapshot.principal)) {
    errors.push("principal: object required");
  } else {
    for (const key of [
      "runtimeId", "sessionId", "windowLabel", "pluginId", "contributionId", "instanceId",
    ] as const) {
      if (!nonEmptyBounded(snapshot.principal[key])) errors.push(`principal.${key}: non-empty bounded string required`);
    }
    if (!Number.isSafeInteger(snapshot.principal.generation) || snapshot.principal.generation < 0) {
      errors.push("principal.generation: non-negative safe integer required");
    }
    if (!PLUGIN_ROLES.has(snapshot.principal.role)) errors.push("principal.role: invalid runtime role");
    if (snapshot.principal.domHandleId !== null && !nonEmptyBounded(snapshot.principal.domHandleId)) {
      errors.push("principal.domHandleId: null or non-empty bounded string required");
    }
  }

  const permissions = Array.isArray(snapshot.grants?.permissions) ? snapshot.grants.permissions : [];
  if (!Array.isArray(snapshot.grants?.permissions)) errors.push("grants.permissions: array required");
  if (permissions.some((permission) => !PERMISSIONS.includes(permission))) {
    errors.push("grants.permissions: unknown permission");
  }
  if (new Set(permissions).size !== permissions.length) errors.push("grants.permissions: duplicates forbidden");

  const requiredRaw = Array.isArray(snapshot.grants?.requiredContracts) ? snapshot.grants.requiredContracts : [];
  const providedRaw = Array.isArray(snapshot.grants?.providedContracts) ? snapshot.grants.providedContracts : [];
  if (!Array.isArray(snapshot.grants?.requiredContracts)) errors.push("grants.requiredContracts: array required");
  if (!Array.isArray(snapshot.grants?.providedContracts)) errors.push("grants.providedContracts: array required");
  const parsedRequired = requiredRaw.flatMap((item, index) => {
    const parsed = parseContractRequirement(item, `grants.requiredContracts[${index}]`, errors);
    return parsed ? [parsed] : [];
  });
  const parsedProvided = providedRaw.flatMap((item, index) => {
    const parsed = parseContractProviderRef(item, `grants.providedContracts[${index}]`, errors);
    return parsed ? [parsed] : [];
  });
  if (new Set(parsedRequired.map((contract) => contract.id)).size !== parsedRequired.length) {
    errors.push("grants.requiredContracts: duplicate ids forbidden");
  }
  if (new Set(parsedProvided.map((contract) => contract.id)).size !== parsedProvided.length) {
    errors.push("grants.providedContracts: duplicate ids forbidden");
  }

  const authority = snapshot.authority;
  if (!isPlainRecord(authority) || !nonEmptyBounded(authority.namespace)) {
    errors.push("authority.namespace: non-empty bounded string required");
  }
  for (const field of ["paths", "labels"] as const) {
    const values = authority?.[field];
    if (!isPlainRecord(values)) {
      errors.push(`authority.${field}: object required`);
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      if (!key || UNSAFE_RECORD_KEYS.has(key) || !nonEmptyBounded(value)) {
        errors.push(`authority.${field}.${key}: safe non-empty bounded string required`);
      }
    }
  }
  if (!isPlainRecord(authority?.coordinates)) {
    errors.push("authority.coordinates: object required");
  } else {
    for (const [key, value] of Object.entries(authority.coordinates)) {
      if (!key || UNSAFE_RECORD_KEYS.has(key)) errors.push(`authority.coordinates: unsafe key "${key}"`);
      validateAuthorityJson(value, `authority.coordinates.${key}`, errors);
    }
  }
  if (snapshot.pane !== undefined && !nonEmptyBounded(snapshot.pane)) errors.push("pane: non-empty bounded string required");
  if (snapshot.parent !== undefined && !nonEmptyBounded(snapshot.parent)) errors.push("parent: non-empty bounded string required");
  if (errors.length > 0) throw new TypeError(`invalid plugin command context: ${errors.join("; ")}`);

  const ctx = cloneAndFreeze({
    ...(snapshot.pane ? { pane: snapshot.pane } : {}),
    remote: true as const,
    window: { label: snapshot.principal.windowLabel },
    ...(snapshot.parent ? { parent: snapshot.parent } : {}),
    origin: "plugin" as const,
    plugin: {
      principal: snapshot.principal,
      grants: {
        permissions: [...permissions],
        requiredContracts: parsedRequired,
        providedContracts: parsedProvided,
      },
      authority: snapshot.authority,
    },
  }) as PluginCommandContext;
  authenticatedPluginContexts.add(ctx);
  return ctx;
}

export interface CommandBrokerStatus {
  readonly registered: boolean;
  readonly pluginCallable: boolean;
  readonly broker?: CommandBrokerSpec;
}

function publicBrokerMetadata(broker: CommandBrokerSpec): CommandBrokerSpec {
  // Never return the registry-owned frozen object: consumers may mutate catalog/status results.
  return structuredClone(broker);
}

export function brokerStatus(name: string): CommandBrokerStatus {
  const spec = registry.get(name);
  if (!spec) return { registered: false, pluginCallable: false };
  if (!spec.broker) return { registered: true, pluginCallable: false };
  return { registered: true, pluginCallable: true, broker: publicBrokerMetadata(spec.broker) };
}

// Compose the LLM discovery surface (docs/I18N.md §3, decision 8). English base + trigger words of every language in one string.
// A single composition rather than per-locale copies — works around MCP having no locale channel, and extends
// automatically as languages are added (triggers data only). The human UI does not use this (it resolves LocalizedText).
//  - Language order = language code ascending (deterministic, independent of the conversation language). No labels (the script is self-identifying).
//  - Duplicate space-separated tokens removed within each language string (case-insensitive). Empty language or empty triggers → skipped (base unchanged when empty).
export function composeTriggers(base: string, triggers?: Record<string, string>): string {
  if (!triggers) return base;
  const groups = Object.keys(triggers)
    .sort()
    .map((lang) => dedupTokens(triggers[lang]))
    .filter((s) => s.length > 0);
  return groups.length ? `${base} | ${groups.join(" | ")}` : base;
}

// Remove duplicates from space-separated tokens (case-insensitive, keeping first-occurrence order and spelling).
function dedupTokens(s: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of (s ?? "").trim().split(/\s+/)) {
    if (!tok) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
  }
  return out.join(" ");
}

// Catalog (handler excluded, serializable) — the source of the sok commands/help/docs/MCP tool list.
// description = composeTriggers(base, triggers) — the single composed form CLI/MCP/skill see.
export function catalogJson(): {
  name: string;
  description: string;
  params: Record<string, Omit<ParamSpec, never>>;
  returns: string;
  errors: readonly string[];
  examples: readonly string[];
  danger?: "destructive" | "inject";
  // Owner of the answer — true when window-local. It is in the catalog because it must be **readable**:
  // when several windows hold the same label, delivery uses this value to send once or to send to all.
  windowScoped: boolean;
  pluginCallable: boolean;
  broker?: CommandBrokerSpec;
}[] {
  return [...registry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, s]) => ({
      name,
      description: composeTriggers(s.description, s.triggers),
      params: s.params,
      returns: s.returns,
      errors: s.errors ?? [],
      examples: s.examples ?? [],
      // Omitted means window-local — the safe side is the default (registry.ts CommandSpec.windowScoped).
      windowScoped: s.windowScoped !== false,
      pluginCallable: s.broker !== undefined,
      // Only the declaration is public. Actual principal/grant/authority values exist in the context, not the catalog.
      ...(s.broker ? { broker: publicBrokerMetadata(s.broker) } : {}),
      // Include the danger class only when the spec declares it (the permission gate surface reads danger from the catalog).
      ...(s.danger ? { danger: s.danger } : {}),
    }));
}

// Parameter validation: required, type, enum. Undeclared keys rejected (typos caught early).
function validate(
  spec: CommandSpec,
  params: Record<string, unknown>,
): string | null {
  // When the handler owns the contract (native runtime proxy) there is no declaration, so pass through — the runtime validates.
  if (spec.paramsAuthority === "handler") return null;
  for (const key of Object.keys(params)) {
    // The transport stamps who is calling and what they read. Neither is a parameter a command
    // declares, and rejecting them would refuse every call that arrives over the control plane.
    if (key === CALLER_LANGUAGE || key === CALLER_WINDOW) continue;
    if (!(key in spec.params)) return tmsg("msg.command.paramUnknown", { key });
  }
  for (const [key, p] of Object.entries(spec.params)) {
    const v = params[key];
    if (v === undefined || v === null) {
      if (p.required) return tmsg("msg.command.paramRequired", { key });
      continue;
    }
    switch (p.type) {
      case "string":
        if (typeof v !== "string") return tmsg("msg.command.paramString", { key });
        if (p.enum && !p.enum.includes(v))
          return tmsg("msg.command.paramEnum", { key, values: p.enum.join("|") });
        break;
      case "number":
        if (typeof v !== "number") return tmsg("msg.command.paramNumber", { key });
        break;
      case "boolean":
        if (typeof v !== "boolean") return tmsg("msg.command.paramBoolean", { key });
        break;
      case "string[]":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
          return tmsg("msg.command.paramStringArray", { key });
        break;
      case "number[]":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "number"))
          return tmsg("msg.command.paramNumberArray", { key });
        break;
      case "json":
        break; // arbitrary JSON — the handler validates it
    }
  }
  return null;
}

// Execution instrumentation sink (A1 — P12 execution visibility). Commands the orchestrator issues to soksak take this
// path, so without instrumentation here "see what runs" does not hold. Injected (test isolation, no-op before boot).
// params holds key names only — no secrets or other sensitive values in the stream.
// Activity trace — the standard response envelope as is (no post-conversion). message is the standard answer,
// data is shown separately by the activity hub (hover). docs/MESSAGE-PROTOCOL.md.
export interface CommandTrace {
  command: string;
  // Raw command label (LocalizedText) — copied from the spec of the running window. The consumer (orchestrator etc.)
  // resolves it into its own language. A plugin command loads only in the running window, so the stream must include
  // the label for other windows to display it without the raw key (stream self-sufficiency).
  title?: LocalizedText;
  source: "ui" | "remote" | "plugin";
  danger?: "destructive" | "inject";
  paramKeys: string[];
  ok: boolean;
  code: string; // always present (success uses "OK")
  message: string; // standard answer (success and failure alike)
  durationMs: number;
  startedAt: number;
  finishedAt: number;
  // Spoken sentence — the result of effectiveSpeak(spec, outcome). Absent means this entry is not spoken.
  // The wire value symmetric to the display sentence (message): the same name as the spec field speak.
  speak?: string;
  media?: MediaContent; // display media (an image etc.) — the feed renders it as is
  // Correlation parent (passed through from ctx.parent) — id of the conversation turn containing this run. The feed folds it into a turn set.
  parentId?: string;
  // Run origin (passed through from ctx.origin) — a system origin ("schedule" etc.) is not spoken and is dimmed (§5).
  origin?: string;
}
/**
 * State of the observation wiring — **the place to query**.
 *
 * The envelope's degraded is a summary, so it shows only whether degradation exists. Which axis, since when, and how
 * requires counting, and without counts there is no proof a fix worked (measured 2026-07-31: the ledger had stopped,
 * and that surfaced only after a human ran two queries and compared timestamps).
 */

// Execute a command. The result is always {ok:true,…} or {ok:false,code,message}.
export async function execute(
  name: string,
  params: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  return executeTracked(name, params, ctx, "host");
}

/** The only command entry point for an isolated plugin runtime. */
export async function executeFromPlugin(
  name: string,
  params: Record<string, unknown>,
  ctx: PluginCommandContext,
): Promise<CommandOutcome> {
  return executeTracked(name, params, ctx, "plugin");
}

/**
 * What the caller reads, from the stamp the transport put on the call.
 *
 * Absent is a fact: a caller who named no language is not a caller asking for English, and the
 * window then answers in its own — which is what it did before there was a stamp.
 */
function readerOf(params: Record<string, unknown>): string | null {
  const stamped = params[CALLER_LANGUAGE];
  return typeof stamped === "string" && stamped ? stamped : null;
}

// The argument name the control plane stamps. Named here rather than assembled, so this and the Go
// constant are one string to change together (core/control.CallerLanguageArgument).
const CALLER_LANGUAGE = "callerLanguage";

// The window a call is made on behalf of (core/control.CallerWindowArgument). Some commands declare
// it as a parameter of their own and read it; the ones that do not still receive it.
const CALLER_WINDOW = "window";

async function executeTracked(
  name: string,
  params: Record<string, unknown>,
  ctx: CommandContext,
  channel: "host" | "plugin",
): Promise<CommandOutcome> {
  const started = Date.now();
  // Add the common response fields (window, hint) on every path — every response, from any success or failure point,
  // passes through this one place (as message normalization passes through normalizeOutcome alone).
  const inner = channel === "plugin"
    ? await executePluginInner(name, params, ctx as PluginCommandContext)
    : await executeInner(name, params, ctx);
  const out = withReaderLanguage(readerOf(params), () => withCommonFields(inner, name, ctx));
  const finished = Date.now();
  try {
    // Record everything (§5 R2 — every fact is recorded). The only exception = spec.trace === false:
    // avoid double-recording the same fact (orchestrator.ask — chat.prompt/answer is the representative record of that
    // turn; note this is not activity.recent: a query is a fact too and is recorded). Exposure (dimming, no speech) is
    // selected by the origin axis, which does not determine whether to record. Failure envelopes of unregistered commands are instrumented too.
    if (registry.get(name)?.trace !== false) {
      emitTrace({
        command: name,
        title: registry.get(name)?.title,
        source: channel === "plugin" ? "plugin" : ctx.remote ? "remote" : "ui",
        danger: registry.get(name)?.danger,
        paramKeys: Object.keys(params),
        ok: out.ok,
        code: out.code,
        message: out.message,
        durationMs: finished - started,
        startedAt: started,
        finishedAt: finished,
        // Never include the response data — a record is an observation summary (§5). Measured: the activity.recent record
        // swallowed the query result whole (including the earlier records inside it) and self-multiplied into a 75MB row;
        // retention's json parse then allocated 226MB → instant CEF PartitionAlloc death (source of 5 whole-app crashes).
        media: out.media,
        // Speech candidates are human-origin only (§5) — a system origin (scheduler etc.) stays silent regardless of the spec.
        speak: ctx.origin ? undefined : effectiveSpeak(registry.get(name), out),
        parentId: ctx.parent,
        origin: ctx.origin,
      }, finished);
    }
  } catch {
    // Instrumentation failure does not affect command execution.
  }
  return out;
}

function pluginFailure(code: ErrCode, message: string, data?: Record<string, unknown>): CommandOutcome {
  return { ok: false, code, message, ...(data ? { data } : {}) };
}

function authorityValue(
  source: CommandBrokerAuthoritySource,
  identity: AuthenticatedPluginCommandIdentity,
): { found: true; value: unknown } | { found: false } {
  const principal = identity.principal;
  switch (source.kind) {
    case "runtime-id": return { found: true, value: principal.runtimeId };
    case "session-id": return { found: true, value: principal.sessionId };
    case "window-label": return { found: true, value: principal.windowLabel };
    case "plugin-id": return { found: true, value: principal.pluginId };
    case "generation": return { found: true, value: principal.generation };
    case "role": return { found: true, value: principal.role };
    case "contribution-id": return { found: true, value: principal.contributionId };
    case "instance-id": return { found: true, value: principal.instanceId };
    case "namespace": return { found: true, value: identity.authority.namespace };
    case "path":
      return Object.prototype.hasOwnProperty.call(identity.authority.paths, source.key)
        ? { found: true, value: identity.authority.paths[source.key] }
        : { found: false };
    case "label":
      return Object.prototype.hasOwnProperty.call(identity.authority.labels, source.key)
        ? { found: true, value: identity.authority.labels[source.key] }
        : { found: false };
    case "coordinates":
      return Object.prototype.hasOwnProperty.call(identity.authority.coordinates, source.key)
        ? { found: true, value: structuredClone(identity.authority.coordinates[source.key]) }
        : { found: false };
  }
}

async function executePluginInner(
  name: string,
  params: Record<string, unknown>,
  ctx: PluginCommandContext,
): Promise<CommandOutcome> {
  if (!isPlainRecord(ctx) || !authenticatedPluginContexts.has(ctx) || !ctx.plugin) {
    return pluginFailure("PLUGIN_AUTH_REQUIRED", tmsg("msg.plugin.authRequired"));
  }
  const spec = registry.get(name);
  if (!spec) return unknownCommand(name);
  if (!spec.broker) {
    return pluginFailure("PLUGIN_CALL_FORBIDDEN", tmsg("msg.plugin.callForbidden", { name }));
  }
  if (!isPlainRecord(params)) {
    return { ok: false, code: "INVALID_PARAMS", message: tmsg("msg.plugin.paramsObject") };
  }

  const bound = new Set(spec.broker.authority.map((binding) => binding.param));
  const selectedAuthority = Object.keys(params).filter((key) => bound.has(key));
  if (selectedAuthority.length > 0) {
    return pluginFailure(
      "PLUGIN_AUTHORITY_FORBIDDEN",
      tmsg("msg.plugin.authorityForbidden", { params: selectedAuthority.join(", ") }),
    );
  }

  const permissionSet = new Set(ctx.plugin.grants.permissions);
  const missingPermissions = spec.broker.permissions.filter((permission) => !permissionSet.has(permission));
  if (missingPermissions.length > 0) {
    return pluginFailure(
      "PERMISSION_DENIED",
      tmsg("msg.plugin.permissionDenied", { name }),
      { missingPermissions },
    );
  }

  const missingRequiredContracts = spec.broker.contracts.requires.filter((requirement) =>
    !ctx.plugin.grants.providedContracts.some((provider) => contractRequirementSatisfiedBy(requirement, provider))
  );
  const unconsumedProvidedContracts = spec.broker.contracts.provides.filter((provider) =>
    !ctx.plugin.grants.requiredContracts.some((requirement) => contractRequirementSatisfiedBy(requirement, provider))
  );
  if (missingRequiredContracts.length > 0 || unconsumedProvidedContracts.length > 0) {
    return pluginFailure(
      "PLUGIN_CONTRACT_DENIED",
      tmsg("msg.plugin.contractDenied", { name }),
      {
        missingRequiredContracts: missingRequiredContracts.map((contract) => contract.id),
        unconsumedProvidedContracts: unconsumedProvidedContracts.map((contract) => contract.id),
      },
    );
  }

  const injected: Record<string, unknown> = { ...params };
  for (const binding of spec.broker.authority) {
    const resolved = authorityValue(binding.source, ctx.plugin);
    if (!resolved.found) {
      return pluginFailure(
        "PLUGIN_AUTHORITY_UNAVAILABLE",
        tmsg("msg.plugin.authorityUnavailable", { name }),
        { param: binding.param },
      );
    }
    injected[binding.param] = resolved.value;
  }

  const outcome = await executeInner(name, injected, ctx, true);
  if (!outcome.ok) return outcome;
  const violations: string[] = [];
  validateMachineValue(spec.broker.result, outcome.data ?? {}, "$.data", violations);
  if (violations.length > 0) {
    return pluginFailure(
      "PLUGIN_RESULT_INVALID",
      tmsg("msg.plugin.resultInvalid", { name }),
      { violations: violations.slice(0, MAX_MACHINE_RESULT_ERRORS) },
    );
  }
  return outcome;
}

async function executeInner(
  name: string,
  params: Record<string, unknown>,
  ctx: CommandContext,
  allowPluginContext = false,
): Promise<CommandOutcome> {
  if (ctx.plugin !== undefined && !allowPluginContext) {
    return pluginFailure(
      "PLUGIN_ENTRYPOINT_REQUIRED",
      tmsg("msg.plugin.entrypointRequired"),
    );
  }
  const spec = registry.get(name);
  if (!spec) return unknownCommand(name);
  // Bare-value syntax — the CLI sends a single non-JSON value as {"_": value} (sok plugin.install activity).
  // The spec is the truth, so interpretation happens only here: with exactly one required parameter, move it to that name.
  // With two or more, or none, leave it so validate returns INVALID_PARAMS and points at the help.
  if (params && Object.keys(params).length === 1 && "_" in params) {
    const required = Object.entries(spec.params).filter(([, v]) => v.required);
    const key = spec.primary ?? (required.length === 1 ? required[0][0] : undefined);
    const ps = key ? spec.params[key] : undefined;
    if (key && ps) {
      let v: unknown = params._;
      if (ps.type === "number") v = Number(v);
      else if (ps.type === "boolean") v = v === true || v === "true";
      params = { [key]: v };
    }
  }
  const invalid = validate(spec, params);
  if (invalid) return { ok: false, code: "INVALID_PARAMS", message: invalid };
  // Permission gate: a danger command from a remote (AI/CLI) call is checked against policy. UI (human) calls are exempt.
  if (ctx.remote && spec.danger && !gate.v(spec.danger)) {
    return {
      ok: false,
      code: "PERMISSION_DENIED",
      message: tmsg("msg.command.dangerBlocked", { danger: spec.danger, name }),
    };
  }
  try {
    // Fill defaults.
    const filled: Record<string, unknown> = { ...params };
    for (const [key, p] of Object.entries(spec.params)) {
      if (filled[key] === undefined && p.default !== undefined) {
        filled[key] = p.default;
      }
    }
    const result = await spec.handler(filled, ctx);
    // Rendered here, in one synchronous stretch, so the sentence is built for whoever asked. The
    // scope cannot span the await above: two commands from callers reading different languages
    // would interleave and each could finish inside the other's scope.
    return withReaderLanguage(readerOf(params), () => normalizeOutcome(spec, result));
  } catch (e) {
    // The thrown text is engine dialect (§3: message = human sentence, owned by the command). Putting it on the human
    // line makes the receiver read the engine's words as app state — measured: "out of memory" from the store was read
    // as the app having died. The original is not discarded; it goes down in the machine payload (data.detail).
    return {
      ok: false,
      code: "INTERNAL",
      message: tmsg("msg.command.internalFailure", { name }),
      data: { detail: String(e) },
    };
  }
}

// Normalize the handler return (a free object or {ok:false,…}) into the standard response envelope {ok,code,message,data?}.
// Success: split off the reserved keys (ok/code/message) → nest the rest under data; spec.message(data) owns message
// (no guessing layer, no fallback — every command supplies its own answer). Failure: keep code/message, absorb the error dialect.
function normalizeOutcome(spec: CommandSpec | undefined, result: unknown): CommandOutcome {
  const raw: Record<string, unknown> =
    result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const pickData = (rest: Record<string, unknown>, existing: unknown): Record<string, unknown> | undefined => {
    if (existing && typeof existing === "object") return existing as Record<string, unknown>;
    return Object.keys(rest).length ? rest : undefined;
  };
  // Service envelope (PS7) — split and validate hints from the wire envelope the synthesized proxy delivered, as a reserved key.
  // In an ordinary spec hints is not a reserved key (rule unchanged — it goes into data).
  const takeServiceHints = (rest: Record<string, unknown>): [CommandHint[] | undefined, Record<string, unknown>] => {
    if (spec?.envelope !== "service" || !("hints" in rest)) return [undefined, rest];
    const { hints, ...restNoHints } = rest;
    const valid = Array.isArray(hints)
      ? hints
          .filter(
            (h): h is CommandHint =>
              !!h && typeof h === "object" &&
              typeof (h as CommandHint).cmd === "string" &&
              typeof (h as CommandHint).why === "string",
          )
          .slice(0, 3)
      : [];
    return [valid.length ? valid : undefined, restNoHints];
  };
  if (raw.ok === false) {
    const {
      ok: _o, code: rc, message: rm, error: re, data: rd,
      messageKey: rk, messageParams: rp, ...rest0
    } = raw;
    const [svcHints, rest] = takeServiceHints(rest0);
    const code = typeof rc === "string" ? rc : typeof re === "string" ? re : "INTERNAL";
    // A refusal that holds a key is rendered here, where the caller's language has been stamped
    // onto the call. A handler that formatted the sentence itself picked a language before the
    // reader was known — measured 2026-08-16, an English caller was answered in Korean.
    const keyed = typeof rk === "string" && hasMessage(rk)
      ? tmsg(rk as MsgKey, (rp ?? undefined) as Record<string, string | number> | undefined)
      : undefined;
    const message = keyed ?? (typeof rm === "string" ? rm : typeof re === "string" ? re : "error");
    const data = pickData(rest, rd);
    const out: CommandOutcome = { ok: false, code, message };
    if (data) out.data = data;
    if (svcHints) out.hint = svcHints;
    return out;
  }
  const { ok: _ok, code: rc, message: rm, data: rd, media: rmedia, ...rest0 } = raw;
  const [svcHints, rest] = takeServiceHints(rest0);
  const data = pickData(rest, rd);
  const code = typeof rc === "string" ? rc : "OK";
  // spec owns message (it is a reserved key, so the handler return's message is dropped). spec always exists because
  // only execute calls normalization — undefined is a type guard alone (unreachable).
  // Exception = the service envelope (PS7): the message the command implementation built on the wire wins, and
  // spec.message is the fallback only when it is absent (label degradation — same shape as the rule in MESSAGE-PROTOCOL §3).
  const wireMessage =
    spec?.envelope === "service" && typeof rm === "string" && rm.trim() ? rm : undefined;
  const message = wireMessage ?? (spec ? spec.message(data ?? {}) : code);
  const media =
    rmedia && typeof rmedia === "object" && typeof (rmedia as MediaContent).kind === "string"
      ? (rmedia as MediaContent)
      : undefined;
  const out: CommandOutcome = { ok: true, code, message };
  if (data) out.data = data;
  if (media) out.media = media;
  if (svcHints) out.hint = svcHints;
  return out;
}

// The single place that adds the common response fields (window label, hint) — execute routes every path through here.
// window always, hint only when there is something to suggest. A hint is a suggestion, not an instruction:
// it states what is possible so the receiver can decide (not binding).
function withCommonFields(out: CommandOutcome, name: string, ctx: CommandContext): CommandOutcome {
  out.window = currentWindowLabel();
  const degraded = degradedAxes(registry.size);
  if (degraded) out.degraded = degraded;
  if (out.ok) {
    // The command itself (spec.hint) builds the success hint. Truncated to 3. An exception omits the hint instead of
    // breaking the response — a failed suggestion cannot undo a successful run.
    const spec = registry.get(name);
    if (spec?.hint) {
      try {
        out.hint = spec.hint(out.data ?? {}, ctx).slice(0, 3);
      } catch {
        // A hint computation failure is unrelated to the response — only the suggestion is dropped.
      }
    }
  } else {
    // The command builds the failure hint first as well (spec.hint takes {code,message,data} and can guide per cause).
    // data is the failure envelope's structured data as is — a hint reads this instead of parsing the human sentence (message).
    // If the command leaves it empty or throws, fall back to the standard per-error-code guidance — a recovery path for the receiver.
    const spec = registry.get(name);
    if (spec?.hint) {
      try {
        const own = spec
          .hint({ code: out.code, message: out.message, data: out.data }, ctx)
          .slice(0, 3);
        if (own.length) out.hint = own;
      } catch {
        /* A failed suggestion does not block diagnosis */
      }
    }
    if (!out.hint) {
      const std = standardErrorHints(out.code, name);
      if (std) out.hint = std;
    }
  }
  // The prefix is the suggester's identity, not data — hint producers (spec.hint, standard guidance, service envelope)
  // build the command shape only, and this single place always prepends this app's CLI name. A dev app's suggestion must
  // run as sok-dev and a release as sok so each connects to its own socket. No conditional detection — a shape-only contract.
  if (out.hint && out.hint.length) {
    const bin = cliName();
    out.hint = out.hint.map((h) => ({ ...h, cmd: `${bin} ${h.cmd}` }));
  }
  return out;
}

// Standard per-error-code guidance (suggestion). A code with no mapping gets no hint — do not manufacture excess guidance.
// cmd = the suggested command line, why = why it is useful (resolved into the current language by tmsg). INVALID_PARAMS inserts the actual command name.
// UNKNOWN_COMMAND resolver — matches an unknown command name against the registry catalog and builds per-cause guidance
// (not installed → install, disabled → enable). The catalog and plugin state are owned by the layer above (catalogPlugins),
// so only the injection point is here (avoids a dependency cycle — the registry holds no reference to the state store).
// The injection point must survive the hot-swap boundary — if only this slot is emptied, the filler treats it as already
// filled and does not fill again. What remains is "nobody answers", and that silence is not an error.
const unknownCommandResolverSlot = moduleState(
  "commands/registry#unknownCommandResolver",
  () => ({ v: null as ((name: string) => CommandHint[]) | null }),
);
export function setUnknownCommandResolver(fn: (name: string) => CommandHint[]): void {
  unknownCommandResolverSlot.v = fn;
}

function standardErrorHints(code: string, command: string): CommandHint[] | undefined {
  switch (code) {
    case "UNKNOWN_COMMAND": {
      // When the resolver determines the cause, its guidance wins (install or enable path). On failure or absence, generic discovery guidance.
      try {
        const resolved = unknownCommandResolverSlot.v?.(command);
        if (resolved && resolved.length) return resolved.slice(0, 3);
      } catch {
        /* A resolution failure only lowers guidance quality — it does not break the response */
      }
      return [{ cmd: "commands", why: tmsg("hint.error.unknownCommand") }];
    }
    case "TARGET_NOT_FOUND":
      return [{ cmd: "state.tree", why: tmsg("hint.error.targetNotFound") }];
    case "INVALID_PARAMS":
      return [{ cmd: `help ${command}`, why: tmsg("hint.error.invalidParams", { command }) }];
    case "AMBIGUOUS_TARGET":
    case "ALREADY_EXISTS":
      return [{ cmd: `help ${command}`, why: tmsg("hint.error.invalidParams", { command }) }];
    case "CONSENT_REQUIRED":
      return [{ cmd: "plugin.consent.preview '{\"id\":...}'", why: tmsg("hint.error.consentRequired") }];
    case "TIMEOUT":
      return [{ cmd: "state.tree", why: tmsg("hint.error.timeout") }];
    default:
      return undefined;
  }
}

// Resolve the spoken sentence — the single computation point for the speak wire value on an activity entry (§3, the axes are message and speak only).
// Speech is **opt-in**: only a command that declares speak is spoken (no message fallback). message (display) always
// appears in the feed, but speaking read and diagnostic commands too becomes noise — the command declares what is worth
// speaking via speak. With speak, speak(outcome) is the sentence for success and failure alike; "" → silence. Without it, silence (undefined).
export function effectiveSpeak(spec: CommandSpec | undefined, out: CommandOutcome): string | undefined {
  const s = spec?.speak ? spec.speak(out) : "";
  return s || undefined;
}
