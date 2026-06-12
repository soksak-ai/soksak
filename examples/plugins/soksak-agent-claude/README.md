# soksak-agent-claude

새 탭(+) 메뉴의 **에이전트** 카테고리에 **Claude Code** 를 추가하는 soksak
플러그인. 에이전트 하나 = 플러그인 하나(독립 설치/제거) — 같은 path
"에이전트"를 선언한 다른 에이전트 플러그인과 메뉴 카테고리가 자동 병합된다.

## 동작

항목을 선택하면 터미널 뷰가 열리고 `claude` 가 자동 실행된다. **미설치면**
공식 설치 명령이 같은 터미널에서 그대로 실행된다 — 설치 과정이 화면에
가시되고, 끝나면 새 탭에서 다시 열면 된다.

## 공식 설치 명령(멀티플랫폼)

| 플랫폼 | 명령 |
|---|---|
| macOS / Linux / WSL | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |

출처: [Claude Code 공식 설치 문서](https://code.claude.com/docs/en/setup)

바이너리 확인은 사용자 셸의 PATH 기준(`command -v` / `Get-Command`)이라
GUI 앱의 좁은 PATH 문제가 없다.

## 명령으로도 동일

```bash
sok view.open '{"program":"claude"}'
sok program.list
```

## 권한

- `programs` — + 메뉴 프로그램 등록(선택 시 터미널 명령 자동 실행 포함)
