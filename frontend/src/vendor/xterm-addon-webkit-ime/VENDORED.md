# Vendored: xterm-addon-webkit-ime

An xterm.js addon that corrects Hangul and CJK IME input under WKWebView.

- Source: https://github.com/yejune/xterm-addon-webkit-ime
- Commit taken: `863eb327ac9442ba11093c51994ca180e8812be0` (PR #1 head — includes the
  guards for four WKWebView composition boundary defects)
- Licence: MIT (author: yejune)

## Why it is vendored

It is not published to npm, and the repository ships no `dist` build output and no `prepare`
script, so a git install produces nothing to import. The source is a single TypeScript file
(`index.ts`), so it is included directly and Vite bundles it with the rest.

## What to do instead

This copy is temporary. The addon now lives in its own repository beside this one, and the core
consumes it from there. Remove this folder once the terminal plugin is the only consumer.

## Local patches, applied on top of upstream PR #1

- GUARD 5: 조합 중 터미네이터/제어키(Enter/Tab/Esc/Ctrl+A-Z) 처리 — `_onKeydown` 커밋+전송, `_customKey` companion 으로 xterm 이중 처리 차단. (upstream PR #1 에 `4293c14` 로 푸시 완료)

## Known open defects (one capture needed)

- **공백 뒤 + 받침 붙는 음절이 받침 없는 형태를 흘림.** 재현: 단어 뒤 공백 후 받침이 추가되는 음절 입력.
  - `있습니다` → `이있습니다` (이 누출)
  - `갔습니다` → `가갔습니다` (가 누출)
  - `했습니다` → `해했습니다` (해 누출)
  - 패턴: 받침 추가 순간(이→있) 중간 완성음절이 xterm onData echo 로 새고 GUARD 1/2 가 못 잡음으로 추정. 정확한 수정엔 실제 WKWebView 이벤트 트레이스(beforeinput/input/onData+skip) 1회 캡처 필요.
