# soksak-plugin-formatter — JSON 포메터

`.json` 파일을 ⇧⌥F 한 번으로 정리하는 soksak 예제 플러그인입니다.
`JSON.parse` 후 `JSON.stringify(value, null, 2)` + 마지막 개행 1개로 재출력합니다.

## 무엇을 하나

- 매니페스트에 선언한 포매터 `json`("JSON 정리", 대상 확장자 `json`)을
  `app.editor.registerFormatter` 로 바인딩합니다.
- 정상 JSON → 2칸 들여쓰기로 정리된 텍스트 반환.
- 깨진 JSON → 텍스트를 절대 바꾸지 않고 `JSON 파싱 실패: …` 에러를 던집니다.
  엔진이 위치(`at position N`)를 주면 `N행 M열` 로 환산해 보여줍니다.
  `editor.format` 명령이 이 메시지를 INTERNAL 로 그대로 노출합니다(정직한 실패).

## 권한 근거

| 권한 | 이유 |
|------|------|
| `editor` | 포매터 등록(`registerFormatter`)에 필요한 유일한 표면. 그 외 표면(파일/네트워크/명령)은 일절 쓰지 않으므로 선언하지 않음. |

## 설치

```bash
# 로컬 경로에서 설치 (~/.soksak/plugins/soksak-plugin-formatter 로 복사/clone)
sok plugin.install '{"source":"/path/to/examples/plugins/soksak-plugin-formatter"}'

# 활성화는 앱 안에서 사람이 직접 동의(원격 enable 은 CONSENT_REQUIRED 로 거부됨)
```

## 사용법

1. `.json` 파일을 에디터에서 엽니다.
2. ⇧⌥F (또는 `sok editor.format`) 를 누릅니다.
3. 결과:
   - 정상 JSON: 2칸 들여쓰기로 정리 + 파일 끝 개행. 마음에 안 들면 undo(⌘Z) 1회로 원복.
   - `.json` 이 아닌 파일: `editor.format` 이 "포매터 없음" 으로 응답(이 플러그인은 `json` 확장자에만 매칭).
   - 깨진 JSON: `JSON 파싱 실패: 3행 7열 — …` 같은 명확한 에러. 버퍼는 변경되지 않습니다.
