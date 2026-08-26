# CLAUDE.ko.md

부트로더입니다. 절차와 명령을 여기에 중복해 두지 않습니다.

## 적재 순서

1. [`AGENTS.md`](AGENTS.md) — 개발 규율
2. [`docs/README.md`](docs/README.md) — 문서 목록
3. 지금 손대는 영역에 대해 그 목록이 지정하는 정본 문서

## 이 프로젝트가 무엇인가

Wails v3 위에 만든 플러그인 기반 데스크톱 workspace 입니다. pane 은 재귀적인 `leaf | split` 트리
하나이며, leaf 는 터미널이거나 브라우저 표면입니다. 코어는 frame, 명령 registry, 관측 표면을
소유합니다. 코어는 구체적인 내용을 그리지 않습니다 — 터미널, 브라우저, 사이드바 본문은 플러그인에서
옵니다.
