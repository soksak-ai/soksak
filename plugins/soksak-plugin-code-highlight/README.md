# 코드 하이라이트+ (`soksak-plugin-code-highlight`)

에디터 확장(CM6) 레퍼런스 예제 플러그인.

## 무엇

- 열린 모든 파일에서 `TODO` / `FIXME` / `XXX` 토큰을 강조 표시합니다
  (accent 색 기반 반투명 배경 + 외곽선 — 현재 테마를 따라갑니다).
- 확장자 문법 매핑을 추가합니다: `.mjs`, `.cjs` → `js`(javascript), `.svelte` → html.
  매핑은 `plugin.json` 의 `contributes.languages` 선언만으로 자동 적용됩니다 — 코드 없음.

뷰·명령·포매터는 없습니다. `activate` 에서 전역 CodeMirror 확장 하나를
`app.editor.registerExtension` 으로 등록하는 것이 전부입니다.

## 권한 근거

| 권한 | 근거 |
|------|------|
| `editor` | CM6 확장 등록(`registerExtension`) + `contributes.languages` 문법 매핑에 필수 |

다른 권한은 선언하지 않습니다 — 파일/네트워크/명령 접근 없음.

## 설치

```
sok plugin.install source=<user>/<repo-soksak-plugin-code-highlight>
# 또는 로컬 경로로
sok plugin.install source=/path/to/examples/plugins/soksak-plugin-code-highlight
```

설치 후 앱의 플러그인 화면에서 동의 후 활성화하세요(원격 `plugin.enable` 은
기록된 동의 없이는 `CONSENT_REQUIRED` 로 거부됩니다).

## 사용법

1. 활성화하면 열려 있는 에디터에 즉시 반영됩니다 — `TODO`/`FIXME`/`XXX` 가
   강조되고, `.mjs`/`.cjs` 파일이 javascript 로, `.svelte` 가 html 로 하이라이팅됩니다.
2. 비활성화하면 강조와 문법 매핑이 즉시 제거됩니다(호스트가 등록을 자동 수거).
3. 단어 경계만 매치하므로 `TODOLIST` 같은 식별자 일부는 강조되지 않습니다.
