# Vendored: xterm-addon-webkit-ime

WKWebView(Tauri/Safari) 한글·CJK IME 입력 보정 xterm.js 애드온.

- 출처: https://github.com/yejune/xterm-addon-webkit-ime
- 적용 커밋: `863eb327ac9442ba11093c51994ca180e8812be0` (PR #1 head — WKWebView 조합 경계 버그 4종 가드 포함)
- 라이선스: MIT (author: yejune)

## 벤더링 이유

npm 미배포 + 저장소에 `dist` 빌드 산출물·`prepare` 스크립트가 없어 git 설치로는 빌드되지 않는다. 단일 파일(`index.ts`) TS 소스라 프로젝트에 직접 포함해 Vite가 함께 번들한다.

## 업데이트 방법

upstream `src/index.ts` 의 원하는 ref 를 받아 `index.ts` 를 교체하고, 위 "적용 커밋" 을 갱신한다.

## 로컬 추가 패치 (upstream PR #1 위에 얹음)

- GUARD 5: 조합 중 터미네이터/제어키(Enter/Tab/Esc/Ctrl+A-Z) 처리 — `_onKeydown` 커밋+전송, `_customKey` companion 으로 xterm 이중 처리 차단. (upstream PR #1 에 `4293c14` 로 푸시 완료)

## 알려진 미해결 버그 (capture 1회 필요)

- **공백 뒤 + 받침 붙는 음절이 받침 없는 형태를 흘림.** 재현: 단어 뒤 공백 후 받침이 추가되는 음절 입력.
  - `있습니다` → `이있습니다` (이 누출)
  - `갔습니다` → `가갔습니다` (가 누출)
  - `했습니다` → `해했습니다` (해 누출)
  - 패턴: 받침 추가 순간(이→있) 중간 완성음절이 xterm onData echo 로 새고 GUARD 1/2 가 못 잡음으로 추정. 정확한 수정엔 실제 WKWebView 이벤트 트레이스(beforeinput/input/onData+skip) 1회 캡처 필요.
