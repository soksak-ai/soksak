// Session commands (session.*) — what the core exposes because a session state can be observed or
// changed, not because a screen wants it.
//
// The core owns the index: which sessions exist, which component owns each, and where each was last
// shown. It does not own the state a session holds. So listing and closing go to the component that
// owns the session, and attaching and detaching write the index itself.
import { invoke } from "../framework";
import { register } from "./registry";
import { tmsg, key } from "../i18n";
import { useSessions } from "../state/sessions";
import { notFound } from "./refuse";

export function registerSessionCatalog(): void {
  register("session.list", {
    description: key("cmd.session.list.desc"),
    triggers: { ko: "세션 목록 상태 소유자 복원" },
    params: {},
    returns:
      "{ sessions[].{ session, owner, state: live|detached|orphaned|lost, windowLabel, viewId, outcome, reason }, lost } — every session in every state, orphaned included; the caller filters",
    message: (d) =>
      tmsg("msg.session.list", { n: ((d.sessions as unknown[]) ?? []).length }),
    examples: ["session.list"],
    handler: async () => (await invoke("session_list", {})) as unknown as Record<string, unknown>,
  });

  register("session.attach", {
    description: key("cmd.session.attach.desc"),
    triggers: { ko: "세션 부착 뷰 연결" },
    params: {
      session: { type: "string", description: key("cmd.session.attach.param.session"), required: true },
      owner: { type: "string", description: key("cmd.session.attach.param.owner"), required: true },
      view: { type: "string", description: key("cmd.session.attach.param.view"), required: true },
    },
    returns: "{ session, owner, viewId }",
    message: (d) => tmsg("msg.session.attach", { session: String(d.session) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['session.attach \'{"session":"7","owner":"pty","view":"tab-aaaaaa"}\''],
    handler: (p) => {
      const view = p.view as string;
      if (!viewExists(view)) return notFound("view.notFound", { viewId: view });
      useSessions
        .getState()
        .bindSession(null, view, { owner: p.owner as string, id: p.session as string });
      return { session: p.session, owner: p.owner, viewId: view };
    },
  });

  register("session.detach", {
    description: key("cmd.session.detach.desc"),
    triggers: { ko: "세션 분리 뷰 해제" },
    params: {
      view: { type: "string", description: key("cmd.session.detach.param.view"), required: true },
    },
    returns: "{ viewId, detached } — detached states whether the view held a session to release",
    message: (d) => tmsg("msg.session.detach", { view: String(d.viewId) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['session.detach \'{"view":"tab-aaaaaa"}\''],
    handler: (p) => {
      const view = p.view as string;
      const held = viewBinding(view);
      if (held === undefined) return notFound("view.notFound", { viewId: view });
      // Detaching releases the view and ends nothing. Closing a window, a workspace or a pane does
      // the same, so a session outlives every one of them and only an explicit close ends it.
      useSessions.getState().bindSession(null, view, null);
      return { viewId: view, detached: held !== null };
    },
  });

  register("session.close", {
    description: key("cmd.session.close.desc"),
    triggers: { ko: "세션 종료 기록 제거" },
    params: {
      session: { type: "string", description: key("cmd.session.close.param.session"), required: true },
    },
    returns: "{ session, closed, held } — held states whether the owner was holding it when the close arrived",
    message: (d) => tmsg("msg.session.close", { session: String(d.session) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['session.close \'{"session":"7"}\''],
    handler: async (p) => {
      const session = p.session as string;
      // The owner performs the close and the core orders it: closing removes the owner's record and
      // the core does not write an owner's store. A close it refused leaves the binding standing,
      // because the session is still running.
      const result = (await invoke("session_close", { session })) as unknown as {
        session: string;
        closed: boolean;
        held: boolean;
      };
      for (const view of viewsBoundTo(session)) {
        useSessions.getState().bindSession(null, view, null);
      }
      return result;
    },
  });
}

function viewExists(viewId: string): boolean {
  return viewBinding(viewId) !== undefined;
}

/** The binding a view holds: null when it holds none, undefined when there is no such view. */
function viewBinding(viewId: string): { owner: string; id: string } | null | undefined {
  for (const workspace of useSessions.getState().workspaces) {
    for (const space of workspace.spaces) {
      for (const tab of tabsIn(space.layout)) {
        if (tab.id === viewId) return tab.session ?? null;
      }
    }
  }
  return undefined;
}

function viewsBoundTo(session: string): string[] {
  const views: string[] = [];
  for (const workspace of useSessions.getState().workspaces) {
    for (const space of workspace.spaces) {
      for (const tab of tabsIn(space.layout)) {
        if (tab.session?.id === session) views.push(tab.id);
      }
    }
  }
  return views;
}

function tabsIn(node: unknown): { id: string; session?: { owner: string; id: string } }[] {
  const branch = node as { type: string; value?: { tabs: unknown[] }; children?: unknown[] };
  if (branch.type === "leaf") return (branch.value?.tabs ?? []) as never;
  return (branch.children ?? []).flatMap(tabsIn);
}
