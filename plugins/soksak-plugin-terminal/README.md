# soksak-plugin-terminal

새 탭(+) 메뉴에 **터미널**을 추가하는 soksak 플러그인.

## 등록 내용

| 프로그램 id | 동작 |
|---|---|
| `terminal` | 맨 터미널 뷰(자동 실행 명령 없음) |

## 명령으로도 동일

```bash
sok view.open '{"program":"terminal"}'
sok program.list   # 등록된 프로그램 확인
```

## 권한

- `programs` — + 메뉴 프로그램 등록
