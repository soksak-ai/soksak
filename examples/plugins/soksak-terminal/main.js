// 터미널 프로그램 — 맨 터미널 뷰를 새 탭(+) 메뉴에 등록. 능력(터미널 뷰)은
// 코어 소유, 메뉴 노출은 이 플러그인이 기여한다(내장 프로그램 없음 §2.6).

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
