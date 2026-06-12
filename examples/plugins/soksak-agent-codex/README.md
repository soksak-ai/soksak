# soksak-agent-codex

새 탭(+) 메뉴의 **에이전트** 카테고리에 **Codex CLI** 를 추가하는 soksak
플러그인.

## 동작

항목을 선택하면 터미널 뷰가 열리고 `codex` 가 자동 실행된다. **미설치면**
공식 설치 명령이 같은 터미널에서 그대로 실행된다 — 설치가 끝나면 새 탭에서
다시 열면 된다. 확인은 사용자 셸의 PATH 기준(`command -v`)이다.

## 공식 설치 명령(멀티플랫폼)

| 플랫폼 | 명령 |
|---|---|
| macOS / Linux / WSL | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Windows (PowerShell) | `irm https://chatgpt.com/codex/install.ps1 \| iex` |

출처: [Codex CLI 공식 문서](https://developers.openai.com/codex/cli)

## 명령으로도 동일

```bash
sok view.open '{"program":"codex"}'
sok program.list
```

## 권한

- `programs` — + 메뉴 프로그램 등록(선택 시 터미널 명령 자동 실행 포함)
