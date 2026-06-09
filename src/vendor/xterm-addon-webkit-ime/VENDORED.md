# Vendored: xterm-addon-webkit-ime

WKWebView(Tauri/Safari) 한글·CJK IME 입력 보정 xterm.js 애드온.

- 출처: https://github.com/yejune/xterm-addon-webkit-ime
- 적용 커밋: `863eb327ac9442ba11093c51994ca180e8812be0` (PR #1 head — WKWebView 조합 경계 버그 4종 가드 포함)
- 라이선스: MIT (author: yejune)

## 벤더링 이유

npm 미배포 + 저장소에 `dist` 빌드 산출물·`prepare` 스크립트가 없어 git 설치로는 빌드되지 않는다. 단일 파일(`index.ts`) TS 소스라 프로젝트에 직접 포함해 Vite가 함께 번들한다.

## 업데이트 방법

upstream `src/index.ts` 의 원하는 ref 를 받아 `index.ts` 를 교체하고, 위 "적용 커밋" 을 갱신한다.
