// 브라우저 프로그램 — 내장 브라우저 뷰(네이티브 webview)를 새 탭(+) 메뉴에 등록.
// 능력(브라우저 뷰)은 코어 소유, 메뉴 노출은 이 플러그인이 기여한다. url 생략 =
// 설정의 시작 URL(homeUrl).

export default {
  activate(ctx) {
    ctx.subscriptions.push(
      ctx.app.programs.register("browser", { kind: "browser" }),
    );
  },

  deactivate() {
    // 등록물은 ctx.subscriptions/호스트 tracker 가 자동 해제 — 별도 정리 없음.
  },
};
