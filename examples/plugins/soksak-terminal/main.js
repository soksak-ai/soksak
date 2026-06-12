// 터미널 프로그램 — 맨 터미널 뷰를 새 탭(+) 메뉴에 등록.

export default {
  activate(ctx) {
    ctx.subscriptions.push(
      ctx.app.programs.register("terminal", { kind: "terminal" }),
    );
  },

  deactivate() {
    // 등록물은 ctx.subscriptions/호스트 tracker 가 자동 해제 — 별도 정리 없음.
  },
};
