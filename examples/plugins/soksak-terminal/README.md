# soksak-terminal

새 탭(+) 메뉴에 **터미널**을 추가하는 soksak 플러그인.

soksak 의 + 메뉴에는 내장 항목이 없다(스펙 §2.6) — 터미널조차 플러그인이
기여한다. 이 플러그인이 없으면 메뉴는 비어 있고, 설치+동의+활성화하면
"터미널" 항목이 나타난다.

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
