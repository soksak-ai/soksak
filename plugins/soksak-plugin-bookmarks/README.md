# 즐겨찾기 (soksak-plugin-bookmarks)

브라우저 즐겨찾기 목록을 우측 사이드바 패널(★)로 보여주는 플러그인입니다.
새 백엔드 코드 0줄 — 앱에 이미 있는 명령만 조합합니다.

- 목록: `bookmark.list`
- 행 클릭 → 열기: `browser.open {url}`
- 행의 ✕ → 제거: `bookmark.remove {url}`
- 라이브 갱신: `bookmarks.changed` 이벤트 구독 (추가/제거 즉시 반영)
- 즐겨찾기가 없으면 "즐겨찾기 없음" + 추가 방법 안내 한 줄 표시
- 명령 실패는 패널 상단에 작은 에러 텍스트로 표시(침묵 실패 없음)

## 권한 근거

| 권한 | 사용처 |
|------|--------|
| `ui` | 사이드바 뷰(`soksak-plugin-bookmarks.list`) 등록 |
| `commands` | `bookmark.list`, `browser.open` 실행 |
| `commands:destructive` | `bookmark.remove`(항목 제거 — 파괴적 동작) 실행. 동의 화면에 강조 표시됩니다 |

선언한 권한만 사용하며, 자체 명령 등록·저장소·파일·네트워크 접근은 없습니다.

## 설치

```sh
# git 레포로 배포하는 경우
sok plugin.install '{"url":"https://github.com/<you>/soksak-plugin-bookmarks"}'

# 이 레포의 예제를 직접 쓰는 경우: ~/.soksak/plugins/ 에 복사
cp -r examples/plugins/soksak-plugin-bookmarks ~/.soksak/plugins/soksak-plugin-bookmarks
```

설치 후 앱의 플러그인 설정에서 활성화(동의)합니다. 원격 활성화는 기록된 동의가
없으면 `CONSENT_REQUIRED` 로 거부됩니다(스펙 §0-5 — 활성화 동의는 사람만).

## 사용법

1. 우측 사이드바 아이콘 레일에서 ★ 클릭 → 즐겨찾기 패널이 열립니다.
2. 행을 클릭하면 해당 URL 이 브라우저 패널로 열립니다.
3. 행 오른쪽 ✕ 를 누르면 즐겨찾기에서 제거됩니다(되돌리려면 다시 추가).
4. 다른 곳(브라우저 ★ 버튼, `sok bookmark.add/remove`)에서 즐겨찾기가 바뀌면
   패널이 즉시 갱신됩니다.
