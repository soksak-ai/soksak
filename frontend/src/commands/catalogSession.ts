// Session commands (session.*) — what the core exposes because a session state can be observed or
// changed, not because a screen wants it.
//
// The core owns the index: which sessions exist, which component owns each, and where each was last
// shown. The index is the core's own record rather than a field on a view — a view goes away with
// the window that held it, and a session outlives both — so every one of these goes to the core,
// and closing goes on from there to the component that owns the session.
import { invoke } from "../framework";
import { register } from "./registry";
import { tmsg, key } from "../i18n";
import { currentWindowLabel } from "../lib/webviewLabels";

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
    returns: "{ session, owner, viewId, windowLabel }",
    message: (d) => tmsg("msg.session.attach", { session: String(d.session) }),
    examples: ['session.attach \'{"session":"7","owner":"pty","view":"tab-aaaaaa"}\''],
    handler: async (p) => {
      const answer = (await invoke("session_attach", {
        session: p.session as string,
        owner: p.owner as string,
        view: p.view as string,
        window: currentWindowLabel(),
      })) as unknown as { session: string; owner: string; viewId: string; windowLabel: string };
      return { ...answer, viewId: answer.viewId };
    },
  });

  register("session.detach", {
    description: key("cmd.session.detach.desc"),
    triggers: { ko: "세션 분리 뷰 해제" },
    params: {
      session: { type: "string", description: key("cmd.session.detach.param.session"), required: true },
    },
    returns: "{ session, detached }",
    message: (d) => tmsg("msg.session.detach", { session: String(d.session) }),
    examples: ['session.detach \'{"session":"7"}\''],
    handler: async (p) =>
      (await invoke("session_detach", { session: p.session as string })) as unknown as Record<
        string,
        unknown
      >,
  });

  register("session.close", {
    description: key("cmd.session.close.desc"),
    triggers: { ko: "세션 종료 기록 제거" },
    params: {
      session: { type: "string", description: key("cmd.session.close.param.session"), required: true },
    },
    returns: "{ session, closed, held } — held states whether the owner was holding it when the close arrived",
    message: (d) => tmsg("msg.session.close", { session: String(d.session) }),
    examples: ['session.close \'{"session":"7"}\''],
    handler: async (p) =>
      (await invoke("session_close", { session: p.session as string })) as unknown as Record<
        string,
        unknown
      >,
  });
}
