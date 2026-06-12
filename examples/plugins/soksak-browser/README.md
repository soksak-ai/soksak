# soksak-browser

새 탭(+) 메뉴에 **브라우저**를 추가하는 soksak 플러그인.

브라우저 능력(네이티브 webview)은 코어가 소유하고, 이 플러그인은 메뉴
노출만 기여한다(내장 프로그램 없음 — 스펙 §2.6). 선택하면 설정의 시작
URL(homeUrl)로 브라우저 뷰가 열린다.

## 명령으로도 동일

```bash
sok view.open '{"program":"browser","url":"https://example.com"}'
sok program.list
```

## 권한

- `programs` — + 메뉴 프로그램 등록
