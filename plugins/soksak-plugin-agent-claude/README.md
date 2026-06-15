# soksak-plugin-agent-claude

새 탭(+) 메뉴의 **에이전트** 카테고리에 **Claude Code** 를 추가하는 soksak
플러그인.

## 동작

**활성화(동의) 시점**에 `claude` 설치 여부를 사용자 셸 PATH 기준으로
확인하고, 미설치면 공식 설치 명령이 새 터미널 탭에서 그대로 실행된다(동의
화면에 고지된 그 명령). 메뉴에서 항목을 선택하면 터미널 뷰가 열리고
`claude` 가 깨끗하게 실행된다.

## 공식 설치 명령(멀티플랫폼)

| 플랫폼 | 명령 |
|---|---|
| macOS / Linux / WSL | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |

출처: [Claude Code 공식 설치 문서](https://code.claude.com/docs/en/setup)

## 명령으로도 동일

```bash
sok view.open '{"program":"claude"}'
sok program.list
```

## 권한

- `programs` — + 메뉴 프로그램 등록(선택 시 터미널 명령 자동 실행 포함)
