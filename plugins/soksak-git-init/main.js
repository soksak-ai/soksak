// git 자동 초기화 — 새 프로젝트(project.created)의 루트에 .git 이 없으면
// git.init 명령을 실행한다(있으면 명령이 no-op, 멱등). 기존 명령+이벤트만
// 조합 — 자체 백엔드 0줄.

export default {
  activate(ctx) {
    const app = ctx.app;
    ctx.subscriptions.push(
      app.events.on("project.created", (p) => {
        if (!p.root) return; // 루트 없는 프로젝트는 대상 아님
        void app.commands
          .execute("git.init", { path: p.root })
          .then((r) => {
            if (!r.ok) console.error("[soksak-git-init]", r.message);
          });
      }),
    );
  },

  deactivate() {
    // 구독은 ctx.subscriptions/호스트 tracker 가 자동 해제 — 별도 정리 없음.
  },
};
