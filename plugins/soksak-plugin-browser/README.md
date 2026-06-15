# soksak-plugin-browser

새 탭(+) 메뉴에 **브라우저**를 추가하는 soksak 플러그인. 선택하면 설정의
시작 URL(homeUrl)로 브라우저 뷰(네이티브 webview)가 열린다.

## 명령으로도 동일

```bash
sok view.open '{"program":"browser","url":"https://example.com"}'
sok program.list
```

## 권한

- `programs` — + 메뉴 프로그램 등록
