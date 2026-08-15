// The page half of the renderer command bridge.
//
// The catalogue this window serves is registered inside this page and nowhere
// else, so until it is declared the only door that reached it was another
// application instance. This declares those names to the backend; from then
// on they sit on the one registry and `sok ui.tree` resolves without a window.
//
// This page never sends its own name. The framework stamps the sending window
// onto the event, and a page that named itself could name another page and take
// over its commands.

/** Wire names. Spelled the same in frameworks/wails/renderer_commands.go —
 *  a name on a wire has to be written on both sides of a language boundary. */
export const RENDERER_DECLARE_EVENT = "renderer:commands.declare";
export const RENDERER_WITHDRAW_EVENT = "renderer:commands.withdraw";
export const RENDERER_RECEIPT_EVENT = "renderer:commands.declared";

/** One name this window declared and does not hold, and why. */
export interface RendererRefusal {
  name: string;
  reason: string;
}

/** What the backend answers a declaration with. */
export interface RendererDeclaration {
  window: string;
  /** The names this window answers. One entry per name on the whole table —
   *  which window answers is the caller's argument, not part of the name. */
  held: string[];
  refused: RendererRefusal[];
}

export interface RendererDoorOptions {
  /** What this window answers. Read once, after the command host is ready —
   *  read earlier it would miss every command a plugin registers. */
  names: () => string[];
  /** Emit one event to the framework. */
  emit: (event: string, payload: unknown) => Promise<unknown> | void;
  /** Start listening. Resolves when this page is really receiving that event. */
  listen: (
    event: string,
    handler: (declaration: RendererDeclaration) => void,
  ) => Promise<void>;
  /** Where to hang the "this page is going away" handler. A reload arrives here
   *  too, which is what withdraws the old catalogue before the new one lands. */
  onPageHide: (run: () => void) => void;
  /** Where the receipt goes. A refusal nobody records is a refusal nobody sees,
   *  and this page would go on believing every name it sent is reachable. */
  report: (declaration: RendererDeclaration) => void;
}

/**
 * Declare this window's commands and keep the declaration honest for the life
 * of the page.
 */
export async function installRendererDoor(options: RendererDoorOptions): Promise<void> {
  // Listening comes first. The receipt is dispatched to this page as soon as
  // the declaration is read, so a listener installed afterwards is a listener
  // that misses it — measured on this application's own delivery 2026-08-08,
  // where announcing readiness before the listener stood lost the drained
  // envelope and the caller waited out its whole cap.
  await options.listen(RENDERER_RECEIPT_EVENT, options.report);

  // Hung before the declaration, so a page that dies between the two has
  // already said how to clean up after itself.
  options.onPageHide(() => {
    void options.emit(RENDERER_WITHDRAW_EVENT, {});
  });

  await declareRendererCommands(options);
}

/**
 * Sends this window's catalogue again, without installing anything.
 *
 * Called whenever the set of commands changes — a plugin enabled, disabled or reloaded. Repeating
 * installRendererDoor instead would add a second receipt listener and a second pagehide hook every
 * time, and the withdrawal would then be sent as many times as the page had re-declared.
 *
 * The declaration is a whole catalogue and the backend replaces what a window held, so sending it
 * twice with nothing changed costs a rebuild and changes nothing.
 */
export async function declareRendererCommands(
  options: Pick<RendererDoorOptions, "emit" | "names">,
): Promise<void> {
  await options.emit(RENDERER_DECLARE_EVENT, { names: options.names() });
}
