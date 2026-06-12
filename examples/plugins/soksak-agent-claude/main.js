// Claude Code — 새 탭(+) 메뉴 "에이전트" 카테고리에 등록. 선택하면 터미널에서
// claude 가 자동 실행되고, 미설치면 공식 설치 명령이 같은 터미널에서 실행된다.
//
// 공식 설치법 출처(2026-06): https://code.claude.com/docs/en/setup

export default {
  activate(ctx) {
    ctx.subscriptions.push(
      ctx.app.programs.register("claude", {
        kind: "terminal",
        command: "claude",
        ensure: {
          bin: "claude",
          install: {
            darwin: "curl -fsSL https://claude.ai/install.sh | bash",
            linux: "curl -fsSL https://claude.ai/install.sh | bash",
            win32: "irm https://claude.ai/install.ps1 | iex",
          },
        },
      }),
    );
  },

  deactivate() {
    // 등록물은 ctx.subscriptions/호스트 tracker 가 자동 해제 — 별도 정리 없음.
  },
};
