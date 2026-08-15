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
