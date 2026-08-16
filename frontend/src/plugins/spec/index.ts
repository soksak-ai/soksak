// Plugin spec — soksak-spec-plugin@0.0.1.
//
// ── §0 Invariants ────────────────────────────────────────────────────────────
// 1. Single source of truth = Command Registry. Plugin commands register in the existing registry
//    and are exposed to sok CLI/MCP/docs at once. Do not create a plugin-only call path.
// 2. Isolation + least privilege. Plugin code runs in an opaque-origin sandbox document and
//    communicates with the host only through a principal-stamped MessagePort capability broker.
//    Manifest permissions are the consent notice and the broker allowlist; raw Tauri, host DOM,
//    and direct network are not exposed.
// 3. Validation is all-or-nothing. A bad manifest is rejected with a reason, never partially
//    accepted (same as the theme model). No silent failure — rejections appear in the rejected list.
// 4. A plugin failure cannot kill the host. activate/mount/format/event callbacks all run inside
//    try/catch boundaries, and a failure shows as status:"error" + reason.
// 5. Only a human grants activation consent. plugin.enable from remote (sok/MCP) is rejected with
//    CONSENT_REQUIRED when no consent is recorded. The plugin API blocks calls to plugin.*
//    management commands outright (no self-propagation). The one exception = dev source: work the
//    developer pointed at locally is outside the consent gate (not third-party risk). Both dev
//    paths are local user acts — (a) the version="dev" marker in ~/.soksak/plugins/<id>/.soksak.json
//    (single-folder model: the folder records its own state), (b) loading a path outside the folder
//    through plugin.dev.load (danger:"inject"). Remote can produce neither, so the gate is local.
// 6. Implementation and placement are orthogonal. The manifest declares static contributions and
//    placement, and the runtime module provider map matches exactly. Only the host owns the actual
//    slot, visibility, and input-enabled state.
// 7. The core does not own the content render engine (engine-neutral A13). The editor, the
//    terminal and the browser are replaceable plugin choices. The core exposes raw primitives
//    only (file IO, PTY, webview hosting, content slot) and holds no engine-specific
//    capability.
// 8. Standards do not move. When a test/validation standard is not met, fix the code. When the
//    standard itself is wrong, record it as an open question and correct it instead of lowering it.
//
// ── Distribution model — unit ownership, release, registry separation (P1-P5, invariant) ────
// A plugin = one independent repo. The repo owns plugin.json, the implementation, docs, tests, and
// the owner release manifest. entry is declared by plugin.json inside the release artifact; the
// installer does not substitute a checkout/branch/guessed path.
//
// P1. The core has no per-unit data. No unit list, no source, no publishing tool — only the public wire.
// P2. A registry is a signed discovery/trust index, and there can be several. It does not copy unit
//     content; it points at the GitHub Release URL + SHA-256 of the owner release manifest and of
//     the conformance report.
// P3. The repo of a plugin/sidecar/kit is finally responsible for its own identity/source/
//     dependency/artifact/entrypoint and its own contracts, docs, and tests. Split a shared domain
//     contract only when multiple implementations really exist.
// P4. Install input is the exact GitHub Release asset bytes. Use the declared entrypoint only after
//     Ed25519 registry authentication, high-water continuity, and owner manifest/report/artifact
//     SHA-256 all pass. git clone, branch, latest, package registry fallback, and relative topology
//     guessing are not part of the install contract.
// P5. Dependencies resolve transitively only inside the chosen source registry. Never fall back
//     silently to the same id in another registry, and never hide a validation failure behind
//     another source.

// Contract id grammar (C3 L2 contract-pin). Single source: contracts.ts — CONTRACT_ID_RE, validateImplements.
import {
  SIDECAR_CONTRACT_ID_RE,
  type ContractProviderRef,
  type ContractRequirement,
  parseContractRequirement,
  validateConsumes,
  validateImplements,
} from "./contracts";
export * from "./contracts";
// plugin service (third form) declaration axis. Single source: service.ts (norm docs/PLUGIN-SERVICE.md).
import {
  type ContributedSchedule,
  parseCommandServiceFields,
  parseSchedules,
  parseServiceDecl,
  type ServiceCommandFields,
  SERVICE_COMMAND_KEYS,
  type ServiceDecl,
  validateServiceRules,
} from "./service";
export * from "./service";
// semver comparison utilities. Single source: semver.ts (public API re-exported here).
import { SEMVER_RE } from "./semver";
export * from "./semver";
import { UNIT_ID_RE, UNIT_SPEC_BY_KIND, isUnitDependencyRange } from "./unit";
export * from "./unit";
export * from "./release";
export * from "./conformanceWire";
export * from "./identityVocabulary";
export * from "./pluginRuntime";
import {
  DEFAULT_PLUGIN_RUNTIME_POLICY,
  parsePluginRuntimePolicy,
  type PluginRuntimePolicy,
} from "./pluginRuntime";
import {
  type ContributedHeaderAction,
  type ContributedOverlay,
  type ContributedStatusItem,
  parseUiSurfaces,
} from "./uiSurfaces";
export type {
  ContributedHeaderAction,
  ContributedOverlay,
  ContributedStatusItem,
  OverlayScope,
} from "./uiSurfaces";
// Internal validation utilities (private) — shared by spec.ts and service.ts.
import {
  checkDuplicates,
  checkKnownKeys,
  isNonEmptyString,
  isRecord,
} from "./util";
// C2 static transparency verdict (pure functions). Single source: transparency.ts.
// Consumed by the core loader, conformance, the gate, and the CLI.
export * from "./transparency";
// §1 Permissions — permissions.ts is the single source of the permission vocabulary and the consent notice.
import { PERMISSIONS, type PluginPermission } from "./permissions";
export * from "./permissions";
// Signed multi-registry install index — a public wire contract that does not copy unit-owned manifest/docs.
export * from "./registry";
// Chrome standard gate (host chrome tokens, entry static scan). Single source: hostChrome.ts.
export * from "./hostChrome";
// Surface × engine grade — an axis that names neither framework nor platform.
export * from "./engineNeeds";
import type { EngineGrade } from "./engineNeeds";
import {
  type LocalizedText,
  normalizeText,
  validateLocalizedText,
} from "./localizedText";
export { resolveText } from "./localizedText";
export type { LocalizedText } from "./localizedText";

// ── §1 Permissions (moved) ───────────────────────────────────────────────────
// permissions.ts is the single source of the permission vocabulary (PluginPermission, PERMISSIONS)
// and the consent notice text (PERMISSION_INFO) — the export * above exposes it as is.

// ── §2 View placement ────────────────────────────────────────────────────────
// View provider and placement are orthogonal (§0-6). placements = supported placements, default right sidebar.

// Projection model (plans/sidebar-projection-spec.md §3.3): content = content plane,
// rail = rail view (projection reference target — the left rail is projection-only, resident marks
// a right-side resident surface, and left/right direction is a placement-time decision so it is not
// in the declaration), rail-footer = resident slot at the bottom of the rail.
// The old sidebar-* names do not exist.
export type ViewPlacement = "content" | "rail" | "rail-footer";

export const VIEW_PLACEMENTS: readonly ViewPlacement[] = [
  "content",
  "rail",
  "rail-footer",
];

// ── §2.5 Sidebar projection contract ─────────────────────────────────────────
// Sidebar declaration of content views and file viewers (plans/sidebar-projection-spec.md §3.1).
// Only two reference forms exist: "self.<viewId>" (own rail view) | {contract, range} (contract address).
// The `<pluginId>.<viewId>` name-pin is forbidden (C3 L1) — cross-plugin references use the contract
// address only, and the core resolves it to the active implementation. instance is the instance
// axis (A9): shared | per-view.

export type SidebarInstance = "shared" | "per-view";
export type SidebarTemplate = "stack" | "tabs";

export interface SidebarSlot {
  ref?: string; // "self.<viewId>" — a rail view of this plugin
  contract?: string; // contract id (cross-plugin reference)
  range?: string; // semver range — required together with contract
  // View id to open in the implementation — required together with contract. Same pattern as the
  // program viewContract+view pairing: the view id is part of the contract convention and the
  // consumer declares it (the core does not hardcode view ids).
  view?: string;
  instance: SidebarInstance;
}

export interface ContributedSidebar {
  left: SidebarSlot[]; // at least one (A1 — left is required)
  right: SidebarSlot[]; // parse default []
  template: SidebarTemplate; // parse default "stack" — the core owns the vocabulary (A5)
}

const SIDEBAR_SELF_REF_RE = /^self\.[a-z0-9][a-z0-9-]*$/;
const SIDEBAR_INSTANCES: readonly SidebarInstance[] = ["shared", "per-view"];
const SIDEBAR_TEMPLATES: readonly SidebarTemplate[] = ["stack", "tabs"];

function parseSidebarSlot(
  raw: unknown,
  label: string,
  errors: string[],
): SidebarSlot | null {
  if (!isRecord(raw)) {
    errors.push(`${label}: object required`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (!["ref", "contract", "range", "view", "instance"].includes(k)) {
      errors.push(`${label}: unknown key "${k}"`);
      return null;
    }
  }
  const hasRef = raw.ref !== undefined;
  const hasContract =
    raw.contract !== undefined || raw.range !== undefined || raw.view !== undefined;
  if (hasRef === hasContract) {
    errors.push(
      `${label}: exactly one of ref("self.<viewId>") or {contract, range}`,
    );
    return null;
  }
  if (
    typeof raw.instance !== "string" ||
    !SIDEBAR_INSTANCES.includes(raw.instance as SidebarInstance)
  ) {
    errors.push(`${label}: instance must be ${SIDEBAR_INSTANCES.join("|")}`);
    return null;
  }
  const instance = raw.instance as SidebarInstance;
  if (hasRef) {
    if (typeof raw.ref !== "string" || !SIDEBAR_SELF_REF_RE.test(raw.ref)) {
      errors.push(
        `${label}: ref must be "self.<viewId>" — no name-pin to another plugin, cross-plugin reference uses the contract address ({contract, range})`,
      );
      return null;
    }
    return { ref: raw.ref, instance };
  }
  // Contract address — same grammar as consumes (single source = contracts.ts parseContractRequirement).
  const req = parseContractRequirement(
    { id: raw.contract, range: raw.range },
    label,
    errors,
  );
  if (!req) return null;
  if (typeof raw.view !== "string" || !VIEW_ID_RE.test(raw.view)) {
    errors.push(
      `${label}: view must be the view id to open in the implementation (^[a-z0-9][a-z0-9-]*$) — required together with contract`,
    );
    return null;
  }
  return { contract: req.id, range: req.range, view: raw.view, instance };
}

function parseSidebarDecl(
  raw: unknown,
  label: string,
  errors: string[],
): ContributedSidebar | null {
  if (!isRecord(raw)) {
    errors.push(`${label}: object required`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (!["left", "right", "template"].includes(k)) {
      errors.push(`${label}: unknown key "${k}"`);
      return null;
    }
  }
  if (!Array.isArray(raw.left) || raw.left.length === 0) {
    errors.push(`${label}.left: array of at least one slot (left sidebar required — A1)`);
    return null;
  }
  const parseSide = (arr: unknown[], side: string): SidebarSlot[] | null => {
    const out: SidebarSlot[] = [];
    for (let i = 0; i < arr.length; i++) {
      const s = parseSidebarSlot(arr[i], `${label}.${side}[${i}]`, errors);
      if (!s) return null;
      out.push(s);
    }
    return out;
  };
  const left = parseSide(raw.left, "left");
  if (!left) return null;
  let right: SidebarSlot[] = [];
  if (raw.right !== undefined) {
    if (!Array.isArray(raw.right)) {
      errors.push(`${label}.right: array required`);
      return null;
    }
    const r = parseSide(raw.right, "right");
    if (!r) return null;
    right = r;
  }
  let template: SidebarTemplate = "stack";
  if (raw.template !== undefined) {
    if (
      typeof raw.template !== "string" ||
      !SIDEBAR_TEMPLATES.includes(raw.template as SidebarTemplate)
    ) {
      errors.push(`${label}.template: ${SIDEBAR_TEMPLATES.join("|")}`);
      return null;
    }
    template = raw.template as SidebarTemplate;
  }
  return { left, right, template };
}

export interface ContributedView {
  id: string; // unique within the plugin. Global key is "<pluginId>.<id>"
  title: LocalizedText;
  icon: string; // short glyph for the icon rail (1-2 characters or an emoji). v1 has no SVG support
  placements: ViewPlacement[]; // parse default ["rail"]
  defaultPlacement: ViewPlacement; // parse default placements[0]
  // A native layer under the content view (embedded webview etc.) must show through — the core
  // treats that cell as a transparent hole. Declared by browser-like views (child webview embed);
  // no hard check in the core — data-driven. Default false.
  transparent: boolean; // parse default false
  // This view owns a core-hosted native child surface (child webview of app.webview) — a "lifecycle"
  // declaration. Separate axis from transparent (compositing — punches the cell into a hole). Core
  // webviewGc derives its reclaim targets from this declaration (no plugin id hardcoded in the
  // core — data-driven). Default false.
  nativeSurface: boolean; // parse default false
  // Status codes this view reports through setStatus (declaration of the ViewStatus.code
  // vocabulary — C2 status axis). Content-placement views must declare it; a stateless view states
  // an empty array (silence is not allowed — explicit is the law). Absence (undefined) is not a
  // parse rejection but a C2 content-view-status violation (transparency.ts) — migrating existing
  // manifests goes through the gate ratchet (warn -> blocking re-legislation).
  status?: string[];
  // A1 exception flag (machine-checked axis) — explicit declaration of a decoration view with no
  // sidebar obligation. transparent/nativeSurface are not exception grounds (a browser content view
  // is subject to A1). Default false.
  decoration: boolean; // parse default false
  // Resident marker (R4) — a rail view the user can pin to the rail. An undeclared rail view is
  // declaration-projection only (the sidebar is subordinate to content function — arbitrary
  // mounting restricted). Allowed on rail-family placements only.
  resident: boolean; // parse default false
  // Sidebar projection declaration (§2.5) — content placement views only. A1 enforcement (reject on
  // absence) turns on at migration step 4; until then absence is tolerated as runtime downgrade (R5).
  sidebar?: ContributedSidebar;
}

export interface ContributedCommand extends ServiceCommandFields {
  name: string; // registered as plugin.<pluginId>.<name> — an undeclared registration is rejected
  title: LocalizedText;
  // Danger class (visible at install/consent time). "destructive" = close/remove, "inject" =
  // term.send/browser.eval and the like. The manifest declaration is authoritative — it exact-matches
  // the runtime module commands map, and the consent summary exposes it.
  danger?: "destructive" | "inject";
  // A bind:"service" command declares the full spec (description/params/returns/triggers) as
  // manifest data (PS3 — ServiceCommandFields). Spec data on a JS command is rejected.
}

export interface ContributedIconSet {
  id: string; // unique within the plugin. Global key is "<pluginId>.<id>"
  title: LocalizedText; // display name in the settings dropdown
}

// File viewer — the renderer routed by extension when a file opens as content (editor = code/text,
// media = image/video…). Engine-neutral (A13): the core does matching and hosting only; the render
// engine is owned by the plugin. The runtime module fileViewers map
// exact-matches the declared ids (both undeclared and missing are rejected, §0-3).

// DOM exposed node — declaration of the element "kinds" a plugin exposes inside its own view to the
// outside (address click/measure). Same pattern as command exposure: declaring it prints it on the
// consent screen (honest notice §0-2). Actual DOM elements take an instance through the data-node
// attribute (dynamic lists use "<id>/<key>"). Only declared ids are valid — undeclared ones warn
// (no silence).
export interface ContributedNode {
  id: string; // node kind, unique within the view. Global address is ".../view/<pluginId.viewId>/node/<id>[/<key>]"
  description?: LocalizedText; // consent screen description (what it exposes)
  danger?: true; // sensitive exposure (⚠ marked on the consent screen)
}

// Domain skill bundled with this plugin (declarative, single). Presence = self-description that
// "there is system procedure knowledge a per-command description cannot teach" (docs/I18N.md §5).
// `sok skill install` installs the SKILL.md of a plugin holding this declaration uniformly into
// .claude/skills/<id> and .agents/skills/<id> — the core holds no hardcoded plugin list (same
// manifest declaration pattern as contributes.commands/views/nodes). The plugin repo is the single
// source of the skill content.
export interface ContributedSkill {
  path: string; // SKILL.md path relative to the plugin directory (e.g. "skill/SKILL.md"). Directory escape (..) forbidden.
}

// ── §2.6 Programs ────────────────────────────────────────────────────────────
// A program = one entry in the new-tab (+) menu = a way to open a new view. There are no built-in
// programs — terminals and agents are all contributed by plugins (no hardcoded entry in the menu or
// the list). The core owns the terminal view capability (terminal kind) only. Program ids are
// globally flat (a user-facing interface — used as is in command parameters and settings values).
// A collision is an error at registration time (§0-3 no silent failure). For an unregistered id the
// core falls back to the terminal view (guarantees state and core command behavior — unrelated to
// menu entries).
//
// Programs are fully declarative (same shape as languages — no code binding, applied automatically).
// The whole behavior (run command, install command) must be in the manifest so the consent screen
// can show the plugin role as the commands themselves (§0-2 honest notice): whether it is "wires up
// core features only", "runs a command", or "installs when missing" comes out as a machine-verified
// declaration.

export type ProgramPlatform = "darwin" | "linux" | "win32";
export const PROGRAM_PLATFORMS: readonly ProgramPlatform[] = [
  "darwin",
  "linux",
  "win32",
];

export interface ContributedProgram {
  id: string; // globally flat program id. ^[a-z0-9][a-z0-9-]*$
  title: LocalizedText; // menu display name
  // Menu category path — depth separated by "/" (e.g. "Agents", "Agents/Experimental").
  // Same-path entries group into a submenu (merged across plugins, by display language).
  path?: LocalizedText;
  // Behavior: view = opens a view as a content tab (+view). The core does not own the terminal view —
  // a terminal is a plugin view too. So kind collapses to view alone.
  kind: "view";
  view: string; // view id to open (contributes.views[].id). Without viewPlugin it is a view of this plugin.
  // View-owning plugin (cross-plugin reference) — set when opening another plugin's view (e.g. an
  // agent program opens another plugin's content view). Unset = this plugin.
  viewPlugin?: string;
  // Reference the view by contract (contract alternative to viewPlugin, C3 L2) — discover the
  // implementation by contract id instead of pinning a plugin id (implementation-agnostic). The core
  // picks one implementation from user settings and opens that plugin's view (the view id above,
  // content by convention). Mutually exclusive with viewPlugin (name-pin) — declaring both is forbidden.
  viewContract?: ContractRequirement;
  // Autorun command passed to the opened view (agent program: the terminal view runs it once on the
  // PTY at mount). A generic channel independent of view kind (PluginViewContext.command) — only the
  // terminal view autoruns it.
  command?: string;
  // Prerequisite binary guarantee: check bin on the user shell PATH and, when it is missing, run the
  // official install command visibly at activation time (no hiding). Independent of view kind — it
  // runs at activation time.
  ensure?: {
    bin: string;
    install: Partial<Record<ProgramPlatform, string>>;
  };
}

// path → segments (validation rejects empty segments). "a/b" → ["a","b"].
export function programPathSegments(path: string): string[] {
  return path.split("/").map((s) => s.trim());
}

// ── §3 Manifest ──────────────────────────────────────────────────────────────

export const SPEC_VERSION = UNIT_SPEC_BY_KIND.plugin;
export const DEFAULT_ENTRY = "main.js";

// External CLI/library dependency — an external tool the plugin runs as a process (npm global CLI
// etc.). A separate axis from plugin↔plugin dependencies. After consent, a missing one is force
// installed (the install command text is disclosed).
// Supply (reach) strategy — how to bring the external tool to the target state. Exactly one variant.
//   vendor = author-bundled bytes + sha256 integrity pin, fetch = core download + per-platform sha256,
//   command = legacy install command (unverifiable). Unset falls back to install (legacy).
export type ReachStrategy =
  | { vendor: { path: string; sha256: string } }
  | {
      fetch: {
        url: Partial<Record<ProgramPlatform, string>>;
        sha256: Partial<Record<ProgramPlatform, string>>;
      };
    }
  | { command: Partial<Record<ProgramPlatform, string>> };

// External runtime dependency = 4-tuple: identity (name, bin) + observe (working observation) +
// accept (acceptance predicate) + reach (supply). observe/accept/reach are optional — unset gives
// legacy behavior (presence = acceptance, install = supply). The reconcile engine (M3) runs it.
// Sidecar (engine model) dependency declaration — a shared native module the plugin opens. name is
// the sidecar name (the <name> in soksak-sidecar-<name>), interface is the contract requirement
// `{ id, range }`. Checked at load against the binary self-report (soksak_sidecar_abi) — a mismatch
// is rejected (declaration ≡ reality). Canonical docs/SIDECARS.md.
export interface SidecarDep {
  name: string; // ^[a-z0-9][a-z0-9-]*$
  interface: ContractRequirement;
}

export interface LibraryDep {
  name: string; // identity — package/tool identifier (e.g. "@google/gemini-cli")
  bin: string; // executable bin for PATH lookup and probe
  install: Partial<Record<ProgramPlatform, string>>; // legacy supply (equivalent to reach.command). Used when reach is unset.
  label?: LocalizedText; // consent screen display name (name when omitted)
  observe?: { probe: string[]; versionRe?: string }; // working observation: probe argv (exit 0 = working) + version extraction regex
  accept?: { minVersion?: string }; // acceptance predicate: minimum SemVer (unset = probe success alone)
  reach?: ReachStrategy; // supply strategy (unset falls back to install)
}

// Plugin configuration schema — single source of truth for user configuration options. UI (auto
// controls), stored defaults, validation, CLI/MCP, and docs all derive from this declaration
// (declarative configuration schema). Harmless (declarative) → no permission needed. Storage has
// two layers, global (app-wide) and per-workspace override (effective = workspace ?? global ?? default).
// list = string list, map = key-value pair list (a two-column mapping table such as source→mirror).
// The settings modal renders both with per-row add/delete — for variable lists/mappings the four
// scalar types cannot draw.
export type ConfigType = "boolean" | "number" | "string" | "enum" | "list" | "map";
export const CONFIG_TYPES: readonly ConfigType[] = ["boolean", "number", "string", "enum", "list", "map"];
// A map value is an array of {key,value} pairs (insertion order and empty rows preserved —
// Record keeps neither order nor duplicate keys).
export interface MapEntry {
  key: string;
  value: string;
}
export type ConfigValue = boolean | number | string | string[] | MapEntry[];
export interface ConfigSetting {
  key: string; // ^[a-zA-Z][a-zA-Z0-9]*$ — unique within the plugin namespace
  type: ConfigType;
  default: ConfigValue;
  title: LocalizedText;
  description?: LocalizedText;
  enum?: string[]; // required for type=enum
  enumLabels?: LocalizedText[]; // optional — when present, same length as enum (display names)
  min?: number; // optional for type=number
  max?: number; // optional for type=number
}
export const CONFIG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

export interface PluginManifest {
  spec: typeof SPEC_VERSION; // required — a mismatch is rejected
  id: string; // ^[a-z0-9][a-z0-9-]*$ + must equal the install directory name
  name: LocalizedText;
  version: string; // semver(major.minor.patch)
  description: LocalizedText;
  author?: string;
  // Guard for a destructive id rename — the previous plugin id. Data ns = pluginId, so after a
  // rename the old history is invisible under the new id. With this declared, the core loader
  // migrates data from the old ns to the new id once at activation (idempotent, explicit error on
  // conflict). The value uses plugin id grammar (^[a-z0-9][a-z0-9-]*$). Generic — the core holds no
  // specific name (C1). Unset when there is no rename.
  renamedFrom?: string;
  // Filled with main.js at parse time. Relative path inside the directory only. null = pure contract
  // plugin with no entry (PS4 — legal only with a service declaration ∧ every command bind:"service"
  // ∧ zero code-requiring contributions).
  entry: string | null;
  // Behavior that extends outside the opaque frame is declared explicitly, not guessed from code
  // smell. Local srcdoc/data/blob iframes are allowed by default; only remote iframe, navigation,
  // and WebRTC are opened by this policy.
  runtime: PluginRuntimePolicy;
  minAppVersion?: string;
  template?: boolean; // true = development template (read-only). Not an activation target — listed and detailed only, with no toggle.
  // Plugin↔plugin dependency (library plugin). pluginId → semver range (e.g. "^0.1.0"). Install
  // pulls missing dependencies in transitively (consent gate); delete cascades to dependents
  // (prevents dangling references). A separate axis from core permissions — this is dependency on
  // another plugin. Generic (any plugin↔plugin).
  dependencies?: Record<string, string>;
  // External CLI/library dependency — force installed after consent when missing. A separate axis
  // from dependencies (plugin↔plugin).
  libraries?: LibraryDep[];
  // Sidecar (engine module) dependency — only declared ones allow app.sidecar.open. Requires the
  // "sidecar" permission.
  sidecars?: SidecarDep[];
  // What this surface requires of the render engine (engineNeeds.ts). It names neither framework
  // (Tauri, Electron) nor platform (OS) — the requirement is a grade, and the combination determines
  // whether it is met.
  requiresEngine?: EngineGrade;
  requiresNativeChildWebview?: boolean;
  requiresEngineModules?: boolean;
  // plugin service declaration (third execution form — norm docs/PLUGIN-SERVICE.md). sidecar
  // references a resident binary in sidecars[], interface is the wire contract id (PS5, PS6).
  // Requires the "service" permission.
  service?: ServiceDecl;
  // Contracts this plugin implements (C3 L2 contract-pin) — each entry is an exact
  // `{ id, version }` provider. Declaration = discovery target: consumers discover by contract id
  // only (implementation-agnostic). Do not pin the implementing pluginId (L1 name-pin — forbidden
  // for new coupling). A version bump takes a per-major id — @2 does not replace @1 (C4).
  // Canonical grammar and meaning = contracts.ts + NAMING §8.
  implements?: ContractProviderRef[];
  // Contracts this plugin calls (consumer axis of the C3 L2 contract-pin). Symmetric to implements —
  // what is declared is the contract, not the implementation. The core cross-plugin call boundary is
  // enforced from this: declaring a contract permits calling any implementation of it
  // (implementation-agnostic), and everything outside is rejected. Pinning an implementation id
  // through dependencies is the L1 name-pin, forbidden for new coupling.
  consumes?: ContractRequirement[];
  // User configuration schema (optional). Global + per-workspace override. Harmless (declarative) →
  // no permission needed.
  configuration?: ConfigSetting[];
  permissions: PluginPermission[];
  contributes: {
    views: ContributedView[]; // requires the "ui" permission
    commands: ContributedCommand[]; // requires the "commands" permission
    overlays: ContributedOverlay[]; // requires ui:overlay:* per scope, static provider binding
    headerActions: ContributedHeaderAction[]; // ui:titlebar + commands, host-declarative command binding
    statusItems: ContributedStatusItem[]; // ui:statusbar + commands, host-declarative command binding
    iconSets: ContributedIconSet[]; // requires the "ui" permission
    programs: ContributedProgram[]; // requires the "programs" permission
    // Event topics this plugin publishes (informational — discoverability). No runtime enforcement
    // (bus/events work unchanged). An open catalog so other plugin authors can see subscribable
    // topics in the manager.
    events: string[];
    // DOM exposed node kinds (declaration). Printed on the consent screen — the user sees what is
    // externally clickable before consenting. Requires the "ui" permission.
    nodes: ContributedNode[];
    // Bundled domain skill (optional, single). Declaration = self-description that a dedicated skill
    // is needed (docs/I18N.md §5). No permission needed (harmless, declarative).
    skill?: ContributedSkill;
    // Schedule data declaration (PS14) — requires a service declaration. The core does owner
    // stamping, bind registration, poke, and unbind cancellation.
    schedules?: ContributedSchedule[];
  };
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[]; // rejection reasons (§0-3: no partial acceptance)
  warnings: string[];
}

// Global key rules — the function is the single source of truth, not prose.
export function qualifiedViewId(pluginId: string, viewId: string): string {
  return `${pluginId}.${viewId}`;
}
export function pluginCommandName(pluginId: string, name: string): string {
  return `plugin.${pluginId}.${name}`;
}

// Config schema → default map (key → default). Floor value for storage/effective resolution
// (the schema is the single source of truth).
export function configDefaults(
  manifest: PluginManifest,
): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const c of manifest.configuration ?? []) out[c.key] = c.default;
  return out;
}

// Look up the schema entry of a config key (for validation/control generation). undefined when absent.
export function configSettingOf(
  manifest: PluginManifest,
  key: string,
): ConfigSetting | undefined {
  return (manifest.configuration ?? []).find((c) => c.key === key);
}

// Validate a setting value against the schema — type match, enum membership, min/max.
// The gate on the set path (before storing).
export function validateSettingValue(
  setting: ConfigSetting,
  value: unknown,
): { ok: true; value: ConfigValue } | { ok: false; error: string } {
  const k = setting.key;
  switch (setting.type) {
    case "list":
      return Array.isArray(value) && value.every((x) => typeof x === "string")
        ? { ok: true, value: value as string[] }
        : { ok: false, error: `${k}: string array required` };
    case "map":
      return Array.isArray(value) &&
        value.every(
          (x) =>
            !!x &&
            typeof x === "object" &&
            typeof (x as MapEntry).key === "string" &&
            typeof (x as MapEntry).value === "string",
        )
        ? { ok: true, value: value as MapEntry[] }
        : { ok: false, error: `${k}: {key,value} array required` };
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, error: `${k}: boolean required` };
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return { ok: false, error: `${k}: number required` };
      }
      if (setting.min !== undefined && value < setting.min) {
        return { ok: false, error: `${k}: minimum ${setting.min}` };
      }
      if (setting.max !== undefined && value > setting.max) {
        return { ok: false, error: `${k}: maximum ${setting.max}` };
      }
      return { ok: true, value };
    case "string":
      return typeof value === "string"
        ? { ok: true, value }
        : { ok: false, error: `${k}: string required` };
    case "enum":
      return typeof value === "string" && (setting.enum ?? []).includes(value)
        ? { ok: true, value }
        : { ok: false, error: `${k}: one of ${(setting.enum ?? []).join("|")}` };
  }
}

export const PLUGIN_ID_RE = UNIT_ID_RE;
const VIEW_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// View status code (ViewStatus.code — machine identifier) — same lexical family as id.
const STATUS_CODE_RE = /^[a-z0-9][a-z0-9-]*$/;
// Sidecar name (the <name> in soksak-sidecar-<name>) — used in path assembly, so traversal-safe form.
const SIDECAR_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// A sidecar interface is a contract requirement `{ id, range }` as well — validated with
// CONTRACT_ID_RE, no separate regex. The wire axis collapses to one contract id grammar (NAMING §8).
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
// SEMVER_RE, semverGte, semverSatisfies moved to semver.ts (re-exported above) — single source moved.
// ── §4 Validation ────────────────────────────────────────────────────────────
// isRecord, isNonEmptyString, checkKnownKeys, checkDuplicates moved to util.ts (internal shared).

// Per-platform value map validation (shared by reach.command and fetch.url/sha256) — keys from
// PROGRAM_PLATFORMS, non-blank values, at least one. Returns true = error (caller returns).
function validatePlatformMap(m: unknown, label: string, errors: string[]): boolean {
  if (!isRecord(m)) {
    errors.push(`${label}: per-platform object required`);
    return true;
  }
  let count = 0;
  for (const [k, val] of Object.entries(m)) {
    if (!PROGRAM_PLATFORMS.includes(k as ProgramPlatform)) {
      errors.push(`${label}: platform key must be ${PROGRAM_PLATFORMS.join("|")}`);
      return true;
    }
    if (!isNonEmptyString(val)) {
      errors.push(`${label}.${k}: non-blank string required`);
      return true;
    }
    count++;
  }
  if (count === 0) {
    errors.push(`${label}: at least one platform required`);
    return true;
  }
  return false;
}

// reach strategy validation — exactly one of vendor|fetch|command; vendor/fetch require the sha256
// integrity pin. true = error.
function validateReach(reach: unknown, label: string, errors: string[]): boolean {
  if (!isRecord(reach)) {
    errors.push(`${label}: object (vendor|fetch|command) required`);
    return true;
  }
  const variants = (["vendor", "fetch", "command"] as const).filter((k) => k in reach);
  if (variants.length !== 1) {
    errors.push(`${label}: exactly one of vendor|fetch|command`);
    return true;
  }
  const v = variants[0];
  if (v === "vendor") {
    const o = reach.vendor;
    if (!isRecord(o) || !isNonEmptyString(o.path) || !isNonEmptyString(o.sha256)) {
      errors.push(`${label}.vendor: { path, sha256 } non-blank strings required`);
      return true;
    }
    return false;
  }
  if (v === "fetch") {
    const o = reach.fetch;
    if (!isRecord(o)) {
      errors.push(`${label}.fetch: { url, sha256 } object required`);
      return true;
    }
    return (
      validatePlatformMap(o.url, `${label}.fetch.url`, errors) ||
      validatePlatformMap(o.sha256, `${label}.fetch.sha256`, errors)
    );
  }
  return validatePlatformMap(reach.command, `${label}.command`, errors);
}

interface EntryRule<T> {
  label: string;
  required: readonly string[];
  optional?: readonly string[];
  parse: (v: Record<string, unknown>, errors: string[]) => T | null;
}

// Shared array entry validation: object + key allowlist + entry parser.
function parseEntries<T>(
  raw: unknown,
  rule: EntryRule<T>,
  errors: string[],
): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${rule.label}: array required`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((item, i) => {
    const label = `${rule.label}[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${label}: not an object`);
      return;
    }
    checkKnownKeys(item, [...rule.required, ...(rule.optional ?? [])], label, errors);
    for (const key of rule.required) {
      if (item[key] === undefined) errors.push(`${label}.${key}: required`);
    }
    const parsed = rule.parse(item, errors);
    if (parsed !== null) out.push(parsed);
  });
  return out;
}

// External JSON (unknown) → validated PluginManifest. On failure, errors holds every reason (§0-3).
// dirName = install directory name — rejected when it differs from id (single source for the
// scan/install path).
export function parseManifest(
  raw: unknown,
  dirName: string,
): { manifest: PluginManifest | null; validation: ManifestValidation } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reject = () => ({
    manifest: null,
    validation: { ok: false, errors, warnings },
  });

  if (!isRecord(raw)) {
    errors.push("manifest is not a JSON object");
    return reject();
  }

  checkKnownKeys(
    raw,
    [
      "spec",
      "id",
      "name",
      "version",
      "description",
      "author",
      "renamedFrom",
      "entry",
      "runtime",
      "minAppVersion",
      "template",
      "dependencies",
      "libraries",
      "sidecars",
      "requiresEngine",
      "requiresNativeChildWebview",
      "requiresEngineModules",
      "service",
      "implements",
      "consumes",
      "configuration",
      "permissions",
      "contributes",
    ],
    "manifest",
    errors,
  );

  if (raw.spec !== SPEC_VERSION) {
    errors.push(`spec: "${SPEC_VERSION}" required (the only spec this app version accepts)`);
  }
  if (!isNonEmptyString(raw.id) || !PLUGIN_ID_RE.test(raw.id)) {
    errors.push("id: ^[a-z0-9][a-z0-9-]*$ required");
  } else if (raw.id !== dirName) {
    errors.push(`id: must equal the install directory name ("${dirName}")`);
  }
  validateLocalizedText(raw.name, "name", errors);
  if (!isNonEmptyString(raw.version) || !SEMVER_RE.test(raw.version)) {
    errors.push("version: semver (major.minor.patch) required");
  }
  validateLocalizedText(raw.description, "description", errors);
  if (raw.author !== undefined && !isNonEmptyString(raw.author)) {
    errors.push("author: string required");
  }
  // renamedFrom: previous plugin id (for migrating the renamed data ns). plugin id grammar, no self-reference.
  if (raw.renamedFrom !== undefined) {
    if (!isNonEmptyString(raw.renamedFrom) || !PLUGIN_ID_RE.test(raw.renamedFrom)) {
      errors.push("renamedFrom: ^[a-z0-9][a-z0-9-]*$ (the previous plugin id) required");
    } else if (raw.renamedFrom === raw.id) {
      errors.push("renamedFrom: must differ from id (not a rename)");
    }
  }
  if (
    raw.minAppVersion !== undefined &&
    (!isNonEmptyString(raw.minAppVersion) || !SEMVER_RE.test(raw.minAppVersion))
  ) {
    errors.push("minAppVersion: semver format required");
  }
  if (raw.template !== undefined && typeof raw.template !== "boolean") {
    errors.push("template: true/false required");
  }

  // dependencies: runtime plugin relation/call permission (pluginId → semver range). Not a locator
  // and not an install source. Must equal the kind:plugin dependency projection of the owner release
  // exactly, and only the release manifest owns the install closure. Optional. No self-dependency;
  // an empty object is harmless.
  const dependencies: Record<string, string> = {};
  if (raw.dependencies !== undefined) {
    if (!isRecord(raw.dependencies)) {
      errors.push("dependencies: object (pluginId → semver range) required");
    } else {
      for (const [depId, range] of Object.entries(raw.dependencies)) {
        if (!PLUGIN_ID_RE.test(depId)) {
          errors.push(`dependencies: key "${depId}" must be plugin id format (^[a-z0-9][a-z0-9-]*$)`);
        } else if (isNonEmptyString(raw.id) && depId === raw.id) {
          errors.push(`dependencies: self-dependency ("${depId}") forbidden`);
        } else if (typeof range !== "string" || !isUnitDependencyRange(range)) {
          errors.push(
            `dependencies["${depId}"]: common unit semver range required (e.g. ^0.1.0, >=1.0.0 <2.0.0, 1.2.3, *)`,
          );
        } else {
          dependencies[depId] = range;
        }
      }
    }
  }

  // libraries: external CLI/library dependency (name, bin, install). Optional. Force installed after
  // consent when missing. A separate axis from dependencies (plugin↔plugin) — dependency on an
  // external tool (npm global CLI etc.).
  const libraries: LibraryDep[] = [];
  if (raw.libraries !== undefined) {
    if (!Array.isArray(raw.libraries)) {
      errors.push("libraries: array (external CLI dependencies) required");
    } else {
      raw.libraries.forEach((item, i) => {
        if (!isRecord(item)) {
          errors.push(`libraries[${i}]: object required`);
          return;
        }
        checkKnownKeys(
          item,
          ["name", "bin", "install", "label", "observe", "accept", "reach"],
          `libraries[${i}]`,
          errors,
        );
        if (!isNonEmptyString(item.name)) {
          errors.push(`libraries[${i}].name: non-blank string required`);
          return;
        }
        if (!isNonEmptyString(item.bin)) {
          errors.push(`libraries[${i}].bin: non-blank string required`);
          return;
        }
        if (!isRecord(item.install)) {
          errors.push(`libraries[${i}].install: object (per-platform install command) required`);
          return;
        }
        const install: Partial<Record<ProgramPlatform, string>> = {};
        let installBad = false;
        for (const [k, val] of Object.entries(item.install)) {
          if (!PROGRAM_PLATFORMS.includes(k as ProgramPlatform)) {
            errors.push(`libraries[${i}].install: platform key must be ${PROGRAM_PLATFORMS.join("|")}`);
            installBad = true;
            break;
          }
          if (!isNonEmptyString(val)) {
            errors.push(`libraries[${i}].install.${k}: non-blank string required`);
            installBad = true;
            break;
          }
          install[k as ProgramPlatform] = val.trim();
        }
        if (installBad) return;
        if (Object.keys(install).length === 0) {
          errors.push(`libraries[${i}].install: at least one platform command required`);
          return;
        }
        if (item.label !== undefined && typeof item.label !== "string" && !isRecord(item.label)) {
          errors.push(`libraries[${i}].label: string or {lang: string} required`);
          return;
        }
        // [4-tuple] observe/accept/reach — optional. Format-validated when declared (unset = legacy behavior).
        if (item.observe !== undefined) {
          const o = item.observe as Record<string, unknown>;
          if (
            !isRecord(o) ||
            !Array.isArray(o.probe) ||
            o.probe.length === 0 ||
            !(o.probe as unknown[]).every((s) => isNonEmptyString(s))
          ) {
            errors.push(`libraries[${i}].observe.probe: non-blank string array (argv) required`);
            return;
          }
          if (o.versionRe !== undefined && !isNonEmptyString(o.versionRe)) {
            errors.push(`libraries[${i}].observe.versionRe: string required`);
            return;
          }
        }
        if (item.accept !== undefined) {
          const a = item.accept as Record<string, unknown>;
          if (
            !isRecord(a) ||
            (a.minVersion !== undefined &&
              (!isNonEmptyString(a.minVersion) || !SEMVER_RE.test(a.minVersion as string)))
          ) {
            errors.push(`libraries[${i}].accept.minVersion: semver format required`);
            return;
          }
        }
        if (
          item.reach !== undefined &&
          validateReach(item.reach, `libraries[${i}].reach`, errors)
        ) {
          return;
        }
        const lib: LibraryDep = { name: item.name.trim(), bin: item.bin.trim(), install };
        if (item.label !== undefined) lib.label = normalizeText(item.label as LocalizedText);
        if (item.observe !== undefined) lib.observe = item.observe as LibraryDep["observe"];
        if (item.accept !== undefined) lib.accept = item.accept as LibraryDep["accept"];
        if (item.reach !== undefined) lib.reach = item.reach as ReachStrategy;
        libraries.push(lib);
      });
      checkDuplicates(libraries.map((l) => l.bin), "libraries[].bin", errors);
    }
  }

  // sidecars: sidecar (engine module) dependency declaration (optional). Only declared ones allow
  // app.sidecar.open (the core checks interface against the binary self-report at load). Requires
  // the "sidecar" permission. Canonical docs/SIDECARS.md.
  // Surface × engine grade — accepts known values only (engineNeeds.ts). A typo that passes becomes
  // the same value as "no requirement", so a surface needing promotion just opens on an insufficient
  // engine — a broken render, not a rejection.
  if (raw.requiresEngine !== undefined && raw.requiresEngine !== "chromium") {
    errors.push(
      `requiresEngine: unknown engine grade ${JSON.stringify(raw.requiresEngine)} (chromium)`,
    );
  }
  if (
    raw.requiresNativeChildWebview !== undefined &&
    typeof raw.requiresNativeChildWebview !== "boolean"
  ) {
    errors.push("requiresNativeChildWebview: boolean required");
  }

  const sidecars: SidecarDep[] = [];
  if (raw.sidecars !== undefined) {
    if (!Array.isArray(raw.sidecars)) {
      errors.push("sidecars: array (sidecar dependency declarations) required");
    } else {
      raw.sidecars.forEach((item, i) => {
        if (!isRecord(item)) {
          errors.push(`sidecars[${i}]: object required`);
          return;
        }
        checkKnownKeys(item, ["name", "interface"], `sidecars[${i}]`, errors);
        if (!isNonEmptyString(item.name) || !SIDECAR_NAME_RE.test(item.name)) {
          errors.push(`sidecars[${i}].name: ^[a-z0-9][a-z0-9-]*$ required`);
          return;
        }
        const interfaceRef = parseContractRequirement(
          item.interface,
          `sidecars[${i}].interface`,
          errors,
          SIDECAR_CONTRACT_ID_RE,
        );
        if (!interfaceRef) return;
        sidecars.push({ name: item.name.trim(), interface: interfaceRef });
      });
      checkDuplicates(sidecars.map((s) => s.name), "sidecars[].name", errors);
      // A sidecar is consumed by two models (SIDECARS.md §1): the engine model dlopens into the app
      // process (app.sidecar → "sidecar" permission), the service model spawns a separate process
      // (app.process → "process" permission, e.g. soksak-sidecar-terminal). A sidecars[] declaration
      // is consistent with either consumption permission — the actual channel gate is applied
      // separately by app.sidecar/app.process with their own permissions.
      const perms = (raw.permissions as unknown[] | undefined) ?? [];
      if (sidecars.length > 0 && !perms.includes("sidecar") && !perms.includes("process")) {
        errors.push('sidecars: declare the "sidecar" (engine model) or "process" (service model) permission');
      }
    }
  }

  // service: plugin service declaration (optional) — format in service.ts, cross-checks after contributes parsing.
  const service = parseServiceDecl(raw.service, errors);

  // implements: contract implementation declaration (optional) — L2 contract-pin. contracts.ts is
  // the single source for grammar and duplicate validation.
  const implementsIds = validateImplements(raw.implements, errors);
  // consumes: contract consumption declaration (optional) — the contract-pin axis of the call
  // boundary. Unlike dependencies, which writes an implementation id, it writes contract ids only
  // (implementation-agnostic).
  const consumesIds = validateConsumes(raw.consumes, errors);

  // configuration: user settings schema (optional). key/type/default consistency + enum/enumLabels/
  // min/max validation. Single source of truth — UI, stored defaults, and CLI/MCP all derive from it.
  const configuration: ConfigSetting[] = [];
  if (raw.configuration !== undefined) {
    if (!Array.isArray(raw.configuration)) {
      errors.push("configuration: array (settings schema) required");
    } else {
      raw.configuration.forEach((item, i) => {
        if (!isRecord(item)) {
          errors.push(`configuration[${i}]: object required`);
          return;
        }
        checkKnownKeys(
          item,
          ["key", "type", "default", "title", "description", "enum", "enumLabels", "min", "max"],
          `configuration[${i}]`,
          errors,
        );
        if (!isNonEmptyString(item.key) || !CONFIG_KEY_RE.test(item.key)) {
          errors.push(`configuration[${i}].key: ^[a-zA-Z][a-zA-Z0-9]*$ required`);
          return;
        }
        if (typeof item.type !== "string" || !CONFIG_TYPES.includes(item.type as ConfigType)) {
          errors.push(`configuration[${i}].type: ${CONFIG_TYPES.join("|")}`);
          return;
        }
        const type = item.type as ConfigType;
        if (item.title === undefined || (typeof item.title !== "string" && !isRecord(item.title))) {
          errors.push(`configuration[${i}].title: string or {lang: string} required`);
          return;
        }
        let enumVals: string[] | undefined;
        if (type === "enum") {
          if (
            !Array.isArray(item.enum) ||
            item.enum.length === 0 ||
            !item.enum.every((x) => isNonEmptyString(x))
          ) {
            errors.push(`configuration[${i}].enum: type=enum requires a non-blank string array`);
            return;
          }
          enumVals = (item.enum as string[]).map((x) => x.trim());
        } else if (item.enum !== undefined) {
          errors.push(`configuration[${i}].enum: allowed on type=enum only`);
          return;
        }
        if (item.enumLabels !== undefined) {
          if (
            type !== "enum" ||
            !Array.isArray(item.enumLabels) ||
            item.enumLabels.length !== (enumVals?.length ?? -1)
          ) {
            errors.push(`configuration[${i}].enumLabels: same length as enum required`);
            return;
          }
        }
        const d = item.default;
        const defOk =
          (type === "boolean" && typeof d === "boolean") ||
          (type === "number" && typeof d === "number") ||
          (type === "string" && typeof d === "string") ||
          (type === "enum" && typeof d === "string" && enumVals!.includes(d)) ||
          (type === "list" && Array.isArray(d) && d.every((x) => typeof x === "string")) ||
          (type === "map" &&
            Array.isArray(d) &&
            d.every(
              (x) =>
                !!x &&
                typeof x === "object" &&
                typeof (x as MapEntry).key === "string" &&
                typeof (x as MapEntry).value === "string",
            ));
        if (!defOk) {
          errors.push(
            `configuration[${i}].default: must match type(${type})${type === "enum" ? " (one of the enum values)" : ""}`,
          );
          return;
        }
        if (type === "number") {
          if (item.min !== undefined && typeof item.min !== "number") {
            errors.push(`configuration[${i}].min: number required`);
            return;
          }
          if (item.max !== undefined && typeof item.max !== "number") {
            errors.push(`configuration[${i}].max: number required`);
            return;
          }
          if (typeof item.min === "number" && typeof item.max === "number" && item.min > item.max) {
            errors.push(`configuration[${i}]: min > max`);
            return;
          }
        } else if (item.min !== undefined || item.max !== undefined) {
          errors.push(`configuration[${i}]: min/max on type=number only`);
          return;
        }
        const setting: ConfigSetting = {
          key: item.key.trim(),
          type,
          default: d as ConfigValue,
          title: normalizeText(item.title as LocalizedText),
        };
        if (item.description !== undefined) {
          setting.description = normalizeText(item.description as LocalizedText);
        }
        if (enumVals) setting.enum = enumVals;
        if (item.enumLabels !== undefined) {
          setting.enumLabels = (item.enumLabels as LocalizedText[]).map((x) => normalizeText(x));
        }
        if (typeof item.min === "number") setting.min = item.min;
        if (typeof item.max === "number") setting.max = item.max;
        configuration.push(setting);
      });
      checkDuplicates(configuration.map((c) => c.key), "configuration[].key", errors);
    }
  }

  // entry: relative path inside the directory only (no escape), single ESM bundle.
  // null = pure contract plugin with no entry (PS4) — validateServiceRules checks legality.
  let entry: string | null = DEFAULT_ENTRY;
  if (raw.entry === null) {
    entry = null;
  } else if (raw.entry !== undefined) {
    if (!isNonEmptyString(raw.entry)) {
      errors.push("entry: string required (a service plugin with no entry uses null — PS4)");
    } else {
      const e = raw.entry.trim();
      if (e.startsWith("/") || e.startsWith("\\") || /^[a-zA-Z]:/.test(e)) {
        errors.push("entry: absolute path forbidden (relative inside the directory only)");
      } else if (e.split(/[\\/]/).includes("..")) {
        errors.push('entry: ".." forbidden (directory escape)');
      } else if (!e.endsWith(".js") && !e.endsWith(".mjs")) {
        errors.push("entry: single .js/.mjs ESM bundle required");
      } else {
        entry = e;
      }
    }
  }

  const runtimeResult = parsePluginRuntimePolicy(raw.runtime);
  if (!runtimeResult.ok) errors.push(...runtimeResult.errors);
  const runtime = runtimeResult.ok ? runtimeResult.value : DEFAULT_PLUGIN_RUNTIME_POLICY;

  // permissions: required array (empty array allowed — a plugin that uses no API).
  const permissions: PluginPermission[] = [];
  if (!Array.isArray(raw.permissions)) {
    errors.push("permissions: array required (use [] when none)");
  } else {
    for (const p of raw.permissions) {
      if (typeof p !== "string" || !PERMISSIONS.includes(p as PluginPermission)) {
        errors.push(`permissions: unknown permission "${String(p)}"`);
      } else {
        permissions.push(p as PluginPermission);
      }
    }
    checkDuplicates(permissions, "permissions", errors);
  }
  const has = (p: PluginPermission) => permissions.includes(p);

  // contributes — permission/contribution consistency: a contribution's required permission must be declared.
  let views: ContributedView[] = [];
  let commands: ContributedCommand[] = [];
  let overlays: ContributedOverlay[] = [];
  let headerActions: ContributedHeaderAction[] = [];
  let statusItems: ContributedStatusItem[] = [];
  let iconSets: ContributedIconSet[] = [];
  let nodes: ContributedNode[] = [];
  let programs: ContributedProgram[] = [];
  let events: string[] = [];
  let skill: ContributedSkill | undefined;
  let schedules: ContributedSchedule[] = [];
  if (raw.contributes !== undefined) {
    if (!isRecord(raw.contributes)) {
      errors.push("contributes: object required");
    } else {
      const c = raw.contributes;
      checkKnownKeys(
        c,
        [
          "views", "commands", "overlays", "headerActions", "statusItems", "iconSets",
          "nodes", "programs", "events", "skill", "schedules",
        ],
        "contributes",
        errors,
      );

      views = parseEntries(c.views, {
        label: "contributes.views",
        required: ["id", "title", "icon"],
        optional: ["placements", "defaultPlacement", "transparent", "nativeSurface", "status", "decoration", "resident", "sidebar"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.views: id must be ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (!validateLocalizedText(v.title, "contributes.views.title", errs)) return null;
          if (!isNonEmptyString(v.icon)) return null;
          let placements: ViewPlacement[] = ["rail"];
          if (v.placements !== undefined) {
            if (
              !Array.isArray(v.placements) ||
              v.placements.length === 0 ||
              v.placements.some(
                (p) => !VIEW_PLACEMENTS.includes(p as ViewPlacement),
              )
            ) {
              errs.push(
                `contributes.views["${v.id}"].placements: non-empty array of ${VIEW_PLACEMENTS.join("|")}`,
              );
              return null;
            }
            placements = v.placements as ViewPlacement[];
          }
          let defaultPlacement = placements[0];
          if (v.defaultPlacement !== undefined) {
            if (!placements.includes(v.defaultPlacement as ViewPlacement)) {
              errs.push(
                `contributes.views["${v.id}"].defaultPlacement: must be one of placements`,
              );
              return null;
            }
            defaultPlacement = v.defaultPlacement as ViewPlacement;
          }
          let transparent = false;
          if (v.transparent !== undefined) {
            if (typeof v.transparent !== "boolean") {
              errs.push(`contributes.views["${v.id}"].transparent: boolean`);
              return null;
            }
            transparent = v.transparent;
          }
          let nativeSurface = false;
          if (v.nativeSurface !== undefined) {
            if (typeof v.nativeSurface !== "boolean") {
              errs.push(`contributes.views["${v.id}"].nativeSurface: boolean`);
              return null;
            }
            nativeSurface = v.nativeSurface;
          }
          // status — list of reported status codes. Empty array = explicit statelessness (kept
          // distinct from an absent declaration). Absence is not rejected here — the verdict is C2
          // content-view-status (transparency.ts). Bad entries do not stop the duplicate check on
          // the good ones (zero hiding — same shape as the implements check).
          let status: string[] | undefined;
          if (v.status !== undefined) {
            if (!Array.isArray(v.status)) {
              errs.push(
                `contributes.views["${v.id}"].status: string array of status codes (^[a-z0-9][a-z0-9-]*$), [] when stateless`,
              );
              return null;
            }
            const offCode = v.status.filter(
              (s) => !isNonEmptyString(s) || !STATUS_CODE_RE.test(s.trim()),
            );
            if (offCode.length > 0) {
              errs.push(
                `contributes.views["${v.id}"].status: ${offCode.length} codes violate the status code format (^[a-z0-9][a-z0-9-]*$)`,
              );
            }
            status = v.status
              .filter((s): s is string => isNonEmptyString(s) && STATUS_CODE_RE.test(s.trim()))
              .map((s) => s.trim());
            checkDuplicates(status, `contributes.views["${v.id}"].status`, errs);
            if (offCode.length > 0) return null;
          }
          let resident = false;
          if (v.resident !== undefined) {
            if (typeof v.resident !== "boolean") {
              errs.push(`contributes.views["${v.id}"].resident: boolean`);
              return null;
            }
            if (
              v.resident === true &&
              !placements.some((pl) => pl === "rail" || pl === "rail-footer")
            ) {
              errs.push(
                `contributes.views["${v.id}"].resident: declarable on rail-family placement views only`,
              );
              return null;
            }
            resident = v.resident;
          }
          let decoration = false;
          if (v.decoration !== undefined) {
            if (typeof v.decoration !== "boolean") {
              errs.push(`contributes.views["${v.id}"].decoration: boolean`);
              return null;
            }
            decoration = v.decoration;
          }
          let sidebar: ContributedSidebar | undefined;
          if (v.sidebar !== undefined) {
            if (!placements.includes("content")) {
              errs.push(
                `contributes.views["${v.id}"].sidebar: declarable on content placement views only`,
              );
              return null;
            }
            const sb = parseSidebarDecl(
              v.sidebar,
              `contributes.views["${v.id}"].sidebar`,
              errs,
            );
            if (!sb) return null;
            sidebar = sb;
          }
          // A1 enforcement (spec §3.1 — every content view has a left sidebar declaration). The only
          // exception is an explicit decoration. transparent/nativeSurface are not exception grounds.
          if (placements.includes("content") && sidebar === undefined && !decoration) {
            errs.push(
              `contributes.views["${v.id}"]: a content view requires a sidebar.left declaration (A1) — mark a decoration view with decoration: true`,
            );
            return null;
          }
          return {
            id: v.id.trim(),
            title: normalizeText(v.title as LocalizedText),
            icon: (v.icon as string).trim(),
            placements,
            defaultPlacement,
            transparent,
            nativeSurface,
            ...(status !== undefined ? { status } : {}),
            decoration,
            resident,
            ...(sidebar !== undefined ? { sidebar } : {}),
          };
        },
      }, errors);
      checkDuplicates(views.map((v) => v.id), "contributes.views.id", errors);
      if (views.length > 0 && !has("ui")) {
        errors.push('contributes.views: declare the "ui" permission');
      }

      commands = parseEntries(c.commands, {
        label: "contributes.commands",
        required: ["name", "title"],
        optional: ["danger", ...SERVICE_COMMAND_KEYS],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.name) || !COMMAND_NAME_RE.test(v.name)) {
            errs.push(
              "contributes.commands: name must be ^[a-z0-9][a-z0-9-]*(.[a-z0-9][a-z0-9-]*)*$",
            );
            return null;
          }
          if (!validateLocalizedText(v.title, "contributes.commands.title", errs))
            return null;
          let danger: "destructive" | "inject" | undefined;
          if (v.danger !== undefined) {
            if (v.danger !== "destructive" && v.danger !== "inject") {
              errs.push('contributes.commands.danger: "destructive" | "inject"');
              return null;
            }
            danger = v.danger;
          }
          // bind:"service" spec fields (PS3) — service.ts is the single source of truth.
          const svc = parseCommandServiceFields(v, `contributes.commands["${v.name}"]`, errs);
          if (svc === null) return null;
          return {
            name: v.name.trim(),
            title: normalizeText(v.title as LocalizedText),
            ...(danger ? { danger } : {}),
            ...svc,
          };
        },
      }, errors);
      checkDuplicates(commands.map((v) => v.name), "contributes.commands.name", errors);
      // No naming restatement (NAMING §1) — the first command segment must not restate the plugin id
      // domain. Dotted namespace: an exact match with an id token, or (first segment length >= 3 AND
      // a truncation/extension containment with a token) is stutter (clip ⊂ clipboard, folder ⊂
      // folderpop). A namespace names the manipulated object, not the plugin itself. Bare name (no
      // dot): only an exact match with an id token is rejected (a verb alone is legal). The
      // abbreviated-namespace exception was removed.
      if (isNonEmptyString(raw.id)) {
        const idTokens = raw.id.replace(/^soksak-plugin-/, "").split("-");
        for (const v of commands) {
          const first = v.name.split(".")[0];
          const dotted = v.name.includes(".");
          const stutter = idTokens.some((tok) =>
            first === tok ||
            (dotted && first.length >= 3 && (tok.startsWith(first) || first.startsWith(tok))),
          );
          if (stutter) {
            errors.push(`contributes.commands.name "${v.name}": first segment restates the plugin id domain (NAMING §1)`);
          }
        }
      }
      if (commands.length > 0 && !has("commands")) {
        errors.push('contributes.commands: declare the "commands" permission');
      }

      ({ overlays, headerActions, statusItems } = parseUiSurfaces(
        c,
        {
          commandNames: new Set(commands.map((command) => command.name)),
          permissions,
          text: { validate: validateLocalizedText, normalize: normalizeText },
        },
        errors,
      ));

      iconSets = parseEntries(c.iconSets, {
        label: "contributes.iconSets",
        required: ["id", "title"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.iconSets: id must be ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (!validateLocalizedText(v.title, "contributes.iconSets.title", errs))
            return null;
          return {
            id: v.id.trim(),
            title: normalizeText(v.title as LocalizedText),
          };
        },
      }, errors);
      checkDuplicates(iconSets.map((v) => v.id), "contributes.iconSets.id", errors);
      if (iconSets.length > 0 && !has("ui")) {
        errors.push('contributes.iconSets: declare the "ui" permission');
      }

      // sidebar self-reference consistency (§3.1) — the target view must be declared and must
      // support rail placement.
      {
        const declaredViews = new Map(views.map((v) => [v.id, v] as const));
        const checkSelfRefs = (
          sb: ContributedSidebar | undefined,
          label: string,
        ) => {
          if (!sb) return;
          for (const slot of [...sb.left, ...sb.right]) {
            if (slot.ref === undefined) continue;
            const target = slot.ref.slice("self.".length);
            const tv = declaredViews.get(target);
            if (!tv) {
              errors.push(`${label}: self reference target view "${target}" is not declared`);
            } else if (!tv.placements.includes("rail")) {
              errors.push(
                `${label}: self reference target view "${target}" requires "rail" in placements`,
              );
            }
          }
        };
        for (const v of views) {
          checkSelfRefs(v.sidebar, `contributes.views["${v.id}"].sidebar`);
        }
      }

      // DOM exposed nodes (declaration) — mirrors the command/view pattern. id regex and duplicate
      // rejection, "ui" permission required.
      nodes = parseEntries(c.nodes, {
        label: "contributes.nodes",
        required: ["id"],
        optional: ["description", "danger"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.nodes: id must be ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (v.description !== undefined &&
              !validateLocalizedText(v.description, "contributes.nodes.description", errs)) {
            return null;
          }
          if (v.danger !== undefined && v.danger !== true) {
            errs.push("contributes.nodes.danger: true only");
            return null;
          }
          return {
            id: v.id.trim(),
            ...(v.description !== undefined
              ? { description: normalizeText(v.description as LocalizedText) }
              : {}),
            ...(v.danger === true ? { danger: true as const } : {}),
          };
        },
      }, errors);
      checkDuplicates(nodes.map((v) => v.id), "contributes.nodes.id", errors);
      if (nodes.length > 0 && !has("ui")) {
        errors.push('contributes.nodes: declare the "ui" permission');
      }

      // Bundled skill (single object, declarative). path = SKILL.md relative to the directory.
      // Escape (..) and absolute paths are rejected.
      if (c.skill !== undefined) {
        if (!isRecord(c.skill) || !isNonEmptyString((c.skill as { path?: unknown }).path)) {
          errors.push("contributes.skill: { path: string } required");
        } else {
          const p = ((c.skill as { path: string }).path).trim();
          if (p.startsWith("/") || p.split("/").includes("..")) {
            errors.push("contributes.skill.path: relative path inside the plugin directory only (no absolute path, no ..)");
          } else {
            skill = { path: p };
          }
        }
      }

      programs = parseEntries(c.programs, {
        label: "contributes.programs",
        required: ["id", "title", "kind"],
        optional: ["path", "command", "view", "viewPlugin", "viewContract", "ensure"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.programs: id must be ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          const id = v.id.trim();
          if (
            !validateLocalizedText(
              v.title,
              `contributes.programs["${id}"].title`,
              errs,
            )
          ) {
            return null;
          }
          // kind collapses to view alone (core terminal removed — a terminal is a plugin view too).
          if (v.kind !== "view") {
            errs.push(`contributes.programs["${id}"].kind: "view"`);
            return null;
          }
          let path: LocalizedText | undefined;
          if (v.path !== undefined) {
            if (
              !validateLocalizedText(
                v.path,
                `contributes.programs["${id}"].path`,
                errs,
              )
            ) {
              return null;
            }
            const pathText = v.path as LocalizedText;
            const values =
              typeof pathText === "string" ? [pathText] : Object.values(pathText);
            if (values.some((p) => programPathSegments(p).some((seg) => !seg))) {
              errs.push(
                `contributes.programs["${id}"].path: "/"-separated category path (no empty segment)`,
              );
              return null;
            }
            path =
              typeof pathText === "string"
                ? programPathSegments(pathText).join("/")
                : Object.fromEntries(
                    Object.entries(pathText).map(([k, val]) => [
                      k,
                      programPathSegments(val).join("/"),
                    ]),
                  );
          }
          // view (view id) required — after the core terminal removal every program opens a view.
          if (!isNonEmptyString(v.view)) {
            errs.push(
              `contributes.programs["${id}"].view: view id to open (contributes.views[].id) required`,
            );
            return null;
          }
          // viewPlugin (cross-plugin view owner) — optional, plugin id format.
          if (v.viewPlugin !== undefined && (!isNonEmptyString(v.viewPlugin) || !PLUGIN_ID_RE.test(v.viewPlugin))) {
            errs.push(
              `contributes.programs["${id}"].viewPlugin: plugin id format (^[a-z0-9][a-z0-9-]*$) required`,
            );
            return null;
          }
          // viewContract (contract-pin view reference, C3 L2) — optional, contract id format
          // (NAMING §8). viewPlugin pins a plugin id (name-pin) while viewContract discovers by
          // contract — the two are mutually exclusive.
          let viewContract: ContractRequirement | undefined;
          if (v.viewContract !== undefined) {
            const parsed = parseContractRequirement(
              v.viewContract,
              `contributes.programs["${id}"].viewContract`,
              errs,
            );
            if (!parsed) return null;
            viewContract = parsed;
          }
          if (v.viewPlugin !== undefined && v.viewContract !== undefined) {
            errs.push(
              `contributes.programs["${id}"]: viewPlugin (name-pin) and viewContract (contract-pin) are mutually exclusive — declare one`,
            );
            return null;
          }
          // command (autorun, optional) — non-blank string. The terminal view runs it once at mount.
          if (v.command !== undefined && !isNonEmptyString(v.command)) {
            errs.push(
              `contributes.programs["${id}"].command: non-blank string required`,
            );
            return null;
          }
          let ensure: ContributedProgram["ensure"];
          if (v.ensure !== undefined) {
            if (!isRecord(v.ensure)) {
              errs.push(
                `contributes.programs["${id}"].ensure: object (bin/install) required`,
              );
              return null;
            }
            const e = v.ensure;
            checkKnownKeys(
              e,
              ["bin", "install"],
              `contributes.programs["${id}"].ensure`,
              errs,
            );
            if (!isNonEmptyString(e.bin)) {
              errs.push(`contributes.programs["${id}"].ensure.bin: required`);
              return null;
            }
            if (!isRecord(e.install)) {
              errs.push(`contributes.programs["${id}"].ensure.install: object required`);
              return null;
            }
            const install: Partial<Record<ProgramPlatform, string>> = {};
            for (const [k, val] of Object.entries(e.install)) {
              if (!PROGRAM_PLATFORMS.includes(k as ProgramPlatform)) {
                errs.push(
                  `contributes.programs["${id}"].ensure.install: platform key must be ${PROGRAM_PLATFORMS.join("|")}`,
                );
                return null;
              }
              if (!isNonEmptyString(val)) {
                errs.push(
                  `contributes.programs["${id}"].ensure.install.${k}: non-blank string required`,
                );
                return null;
              }
              install[k as ProgramPlatform] = val.trim();
            }
            if (Object.keys(install).length === 0) {
              errs.push(
                `contributes.programs["${id}"].ensure.install: at least one platform command required`,
              );
              return null;
            }
            ensure = { bin: e.bin.trim(), install };
          }
          return {
            id,
            title: normalizeText(v.title as LocalizedText),
            kind: "view" as const,
            view: (v.view as string).trim(),
            ...(path !== undefined ? { path } : {}),
            ...(v.viewPlugin !== undefined ? { viewPlugin: (v.viewPlugin as string).trim() } : {}),
            ...(viewContract !== undefined ? { viewContract } : {}),
            ...(v.command !== undefined ? { command: (v.command as string).trim() } : {}),
            ...(ensure !== undefined ? { ensure } : {}),
          };
        },
      }, errors);
      checkDuplicates(programs.map((v) => v.id), "contributes.programs.id", errors);

      // events — array of published topic strings (informational). Format validation only, no
      // permission needed. §0-3: reject when bad.
      if (c.events !== undefined) {
        if (
          !Array.isArray(c.events) ||
          !c.events.every(
            (e) => isNonEmptyString(e) && COMMAND_NAME_RE.test(e),
          )
        ) {
          errors.push(
            "contributes.events: string array of published topics (^[a-z0-9][a-z0-9-]*(.[a-z0-9][a-z0-9-]*)*$)",
          );
        } else {
          events = c.events.map((e) => (e as string).trim());
          checkDuplicates(events, "contributes.events", errors);
        }
      }
      if (programs.length > 0 && !has("programs")) {
        errors.push('contributes.programs: declare the "programs" permission');
      }

      // schedules — data schedule declaration (PS14). Format in service.ts, reference consistency
      // in the cross-check below.
      schedules = parseSchedules(c.schedules, errors);
    }
  }

  // plugin service cross-consistency (PS3, PS4, PS9, PS14) — service.ts is the single source of truth.
  validateServiceRules(
    {
      service,
      commands,
      schedules,
      codeBoundCounts: {
        views: views.length,
        overlays: overlays.length,
        nodes: nodes.length,
        iconSets: iconSets.length,
      },
      sidecarNames: sidecars.map((s) => s.name),
      permissions,
      entryIsNull: entry === null,
    },
    errors,
  );

  if (errors.length > 0) return reject();
  return {
    manifest: {
      spec: SPEC_VERSION,
      id: (raw.id as string).trim(),
      name: normalizeText(raw.name as LocalizedText),
      version: (raw.version as string).trim(),
      description: normalizeText(raw.description as LocalizedText),
      author: raw.author !== undefined ? (raw.author as string).trim() : undefined,
      ...(raw.renamedFrom !== undefined ? { renamedFrom: (raw.renamedFrom as string).trim() } : {}),
      entry,
      runtime,
      minAppVersion:
        raw.minAppVersion !== undefined
          ? (raw.minAppVersion as string).trim()
          : undefined,
      ...(raw.template === true ? { template: true } : {}),
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      ...(libraries.length > 0 ? { libraries } : {}),
      ...(sidecars.length > 0 ? { sidecars } : {}),
      ...(raw.requiresEngine === "chromium" ? { requiresEngine: "chromium" as const } : {}),
      ...(raw.requiresNativeChildWebview === true ? { requiresNativeChildWebview: true } : {}),
      ...(service !== undefined ? { service } : {}),
      ...(implementsIds.length > 0 ? { implements: implementsIds } : {}),
      ...(consumesIds.length > 0 ? { consumes: consumesIds } : {}),
      ...(configuration.length > 0 ? { configuration } : {}),
      permissions,
      contributes: {
        views, commands, overlays, headerActions, statusItems,
        iconSets, nodes, programs, events,
        ...(skill ? { skill } : {}),
        ...(schedules.length > 0 ? { schedules } : {}),
      },
    },
    validation: { ok: true, errors, warnings },
  };
}

// ── § Chrome standard gate (moved) ───────────────────────────────────────────
// hostChrome.ts is the single source for host chrome tokens and the entry static scan
// (HOST_CHROME_TOKENS, scanHostChromeViolations) — the export * above exposes it as is.
