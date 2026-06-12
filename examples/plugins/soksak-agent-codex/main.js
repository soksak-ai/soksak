// Codex CLI 프로그램 — 새 탭(+) 메뉴 "에이전트" 카테고리에 등록.
// 선택하면 터미널 뷰에서 codex 가 자동 실행되고, 미설치면 공식 설치 명령
// (멀티플랫폼)이 같은 터미널에서 가시 실행된다(ensure 래핑은 호스트
// programRegistry 가 소유).
//
// 공식 설치법 출처(2026-06): https://developers.openai.com/codex/cli

export default {
  activate(ctx) {
    ctx.subscriptions.push(
      ctx.app.programs.register("codex", {
        kind: "terminal",
        command: "codex",
        ensure: {
          bin: "codex",
          install: {
            darwin: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            linux: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            win32: "irm https://chatgpt.com/codex/install.ps1 | iex",
          },
        },
      }),
    );
  },

  deactivate() {
    // 등록물은 ctx.subscriptions/호스트 tracker 가 자동 해제 — 별도 정리 없음.
  },
};
