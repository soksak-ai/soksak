// Public 0.0.1 SDK root. This package exposes only the isolated plugin-runtime
// author surface; private core same-realm APIs are deliberately absent.
import type {
  OverlayScope,
  PluginManifest,
  PluginRuntimeCommandOutcome,
  PluginRuntimeJson,
  PluginRuntimeRole,
} from "@soksak-ai/plugin-spec";

export type {
  PluginManifest,
  PluginRuntimeJson,
  PluginRuntimeRole,
} from "@soksak-ai/plugin-spec";

/** The handler result is exactly the public runtime-wire command outcome. */
export type PluginCommandOutcome = PluginRuntimeCommandOutcome;
export type PluginJsonObject = { [key: string]: PluginRuntimeJson };

declare const opaqueHandle: unique symbol;
/** Host-minted, frame/session-owned handle; author code cannot construct one safely. */
export type PluginHandle<Kind extends string> = string & {
  readonly [opaqueHandle]: Kind;
};

export interface SandboxDisposable {
  dispose(): void;
}

export interface PluginCommandRegistryClient {
  /**
   * Executes one command through the public Command Registry. The host validates
   * the registered params/returns/danger/permission/contract and injects the
   * authenticated principal plus any namespace/path/label/placement authority.
   */
  execute(command: string, params?: PluginJsonObject): Promise<PluginCommandOutcome>;
}

export interface PluginEventRegistryClient {
  subscribe(
    topic: string,
    listener: (value: PluginRuntimeJson) => void,
  ): Promise<SandboxDisposable>;
}

export interface PluginReadableResource {
  readonly handle: PluginHandle<"resource">;
  readonly byteLength: number;
  /** Bounded chunks arrive over the runtime MessagePort as transferable buffers. */
  stream(options?: { readonly offset?: number; readonly length?: number }): AsyncIterable<Uint8Array>;
  release(): Promise<void>;
}

/** Broker surface in controller and non-preview visual roles. */
export interface SandboxedPluginApp {
  readonly appVersion: string;
  readonly pluginId: string;
  readonly windowLabel: string;
  readonly commands: PluginCommandRegistryClient;
  readonly events: PluginEventRegistryClient;
  readonly resources: {
    open(handle: PluginHandle<"resource">): Promise<PluginReadableResource>;
  };
}

/** Preview receives no capability, host-command, event, or resource surface. */
export interface PreviewPluginApp {
  readonly commands?: never;
  readonly events?: never;
  readonly resources?: never;
}

export type PluginColorMode = "light" | "dark" | "system";

export type PluginDeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly PluginDeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: PluginDeepReadonly<T[Key]> }
        : T;

export interface PluginFrameSlot {
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

export interface PluginFrameState {
  readonly revision: number;
  readonly theme: {
    readonly colorMode: PluginColorMode;
    readonly tokens: Readonly<Record<string, string>>;
  };
  readonly locale: string;
  readonly slot: PluginFrameSlot | null;
  readonly visible: boolean;
  readonly interactive: boolean;
  readonly instance: PluginDeepReadonly<PluginRuntimeJson>;
}

interface PluginFrameContextBase<App, Role extends PluginRuntimeRole> {
  readonly app: App;
  readonly role: Role;
  readonly signal: AbortSignal;
  /** Full immutable snapshot selected by monotonic context revision. */
  readonly context: Readonly<PluginFrameState>;
}

export type PluginControllerContext = PluginFrameContextBase<SandboxedPluginApp, "controller">;

/** Controller runtimes are non-visual and never use their document as app UI. */
export interface PluginController {
  activate(context: PluginControllerContext): void | Promise<void>;
  deactivate?(context: PluginControllerContext): void | Promise<void>;
}

export interface PluginCommandInvocation {
  readonly origin: string;
  readonly parent: string | null;
  execute(command: string, params?: PluginJsonObject): Promise<PluginCommandOutcome>;
}

export interface PluginCommandContext extends PluginFrameContextBase<SandboxedPluginApp, "controller"> {
  readonly invocation: PluginCommandInvocation;
}

export type PluginCommandHandler = (
  params: PluginJsonObject,
  context: PluginCommandContext,
) => PluginCommandOutcome | Promise<PluginCommandOutcome>;

interface ActiveVisualContext<Role extends "view" | "file-viewer" | "overlay">
  extends PluginFrameContextBase<SandboxedPluginApp, Role> {
  readonly root: HTMLElement;
  readonly context: Readonly<PluginFrameState & { readonly slot: PluginFrameSlot }>;
}

interface PreviewVisualContext<Target extends "view" | "file-viewer" | "overlay">
  extends PluginFrameContextBase<PreviewPluginApp, "preview"> {
  readonly root: HTMLElement;
  readonly previewTarget: Target;
  readonly previewInput: PluginDeepReadonly<PluginRuntimeJson>;
  readonly context: Readonly<PluginFrameState & {
    readonly slot: PluginFrameSlot;
    readonly interactive: false;
  }>;
}

export type PluginViewInstanceContext =
  | ActiveVisualContext<"view">
  | PreviewVisualContext<"view">;

export interface PluginViewProvider {
  mount(context: PluginViewInstanceContext): void | Promise<void>;
  update?(context: PluginViewInstanceContext): void | Promise<void>;
  unmount?(context: PluginViewInstanceContext): void | Promise<void>;
}

export type PluginFileViewerContext =
  | ActiveVisualContext<"file-viewer">
  | PreviewVisualContext<"file-viewer">;

export interface PluginFileViewerProvider {
  mount(context: PluginFileViewerContext): void | Promise<void>;
  update?(context: PluginFileViewerContext): void | Promise<void>;
  unmount?(context: PluginFileViewerContext): void | Promise<void>;
}

export type PluginOverlayScope = OverlayScope;
export type PluginPreviewTargetKind = "view" | "file-viewer" | "overlay";

export type PluginOverlayContext = (
  | ActiveVisualContext<"overlay">
  | PreviewVisualContext<"overlay">
) & {
  readonly scope: PluginOverlayScope;
};

export interface PluginOverlayProvider {
  mount(context: PluginOverlayContext): void | Promise<void>;
  update?(context: PluginOverlayContext): void | Promise<void>;
  unmount?(context: PluginOverlayContext): void | Promise<void>;
}

/**
 * Static executable providers only. Icon sets are manifest-declared, verified
 * logical data assets and are intentionally absent from the executable module.
 */
export interface SoksakPluginModule {
  readonly controller?: PluginController;
  readonly commands?: Readonly<Record<string, PluginCommandHandler>>;
  readonly views?: Readonly<Record<string, PluginViewProvider>>;
  readonly fileViewers?: Readonly<Record<string, PluginFileViewerProvider>>;
  readonly overlays?: Readonly<Record<string, PluginOverlayProvider>>;
}

export function defineSoksakPlugin(module: SoksakPluginModule): SoksakPluginModule {
  return module;
}

export function pluginModuleInventory(module: SoksakPluginModule): {
  readonly commands: readonly string[];
  readonly views: readonly string[];
  readonly fileViewers: readonly string[];
  readonly overlays: readonly string[];
} {
  const keys = (record: object | undefined): string[] => record ? Object.keys(record).sort() : [];
  return {
    commands: keys(module.commands),
    views: keys(module.views),
    fileViewers: keys(module.fileViewers),
    overlays: keys(module.overlays),
  };
}

/**
 * The real parsed PluginManifest owns the command inventory. Service-bound
 * declarations are implemented by the service bridge, never by JS handlers.
 */
export function derivePluginCommandInventory(
  contributions: Pick<PluginManifest["contributes"], "commands">,
): { readonly runtime: readonly string[]; readonly service: readonly string[] } {
  const seen = new Set<string>();
  const runtime: string[] = [];
  const service: string[] = [];
  for (const command of contributions.commands) {
    if (seen.has(command.name)) throw new TypeError(`duplicate manifest command: ${command.name}`);
    seen.add(command.name);
    (command.bind === "service" ? service : runtime).push(command.name);
  }
  return { runtime: runtime.sort(), service: service.sort() };
}

export function selectSoksakPluginProvider(
  module: SoksakPluginModule,
  selector: {
    readonly role: "view" | "file-viewer" | "overlay" | "preview";
    readonly contributionId: string;
    readonly previewKind?: PluginPreviewTargetKind;
  },
): PluginViewProvider | PluginFileViewerProvider | PluginOverlayProvider {
  const kind = selector.role === "preview" ? selector.previewKind : selector.role;
  if (!kind) throw new Error("preview provider kind is required");
  const table = kind === "view"
    ? module.views
    : kind === "file-viewer"
      ? module.fileViewers
      : module.overlays;
  const provider = table?.[selector.contributionId];
  if (!provider) throw new Error(`declared ${kind} provider not found: ${selector.contributionId}`);
  return provider;
}

export type PreviewViewProvider = PluginViewProvider;
export type PreviewFileViewerProvider = PluginFileViewerProvider;
export type PreviewOverlayProvider = PluginOverlayProvider;
