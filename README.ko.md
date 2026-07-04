# soksak

AI 네이티브 터미널 워크벤치. 터미널·듀얼 엔진 브라우저·에디터·파일 뷰가 프로젝트
창 안의 분할 패널로 살고, 컨트롤 플레인 창이 그것들을 지휘하며, 코어·플러그인의
모든 기능이 레지스트리 명령으로서 `sok` CLI·MCP·스킬을 통해 AI 에이전트에게
열려 있다.

## 무엇인가

- **워크스페이스 창** — 프로젝트 단위의 창. 터미널(OS PTY + xterm.js, WebGL 렌더러,
  셸 통합, 세션 복원), 두 엔진의 브라우저(OS 네이티브 웹뷰 + 번들 Chromium 엔진
  사이드카 — 탭·북마크·DevTools), CodeMirror 에디터, 파일 트리가 분할 패널로 공존한다.
- **컨트롤 플레인** — `main` 창이 오케스트레이터다: 프로젝트맵, 모든 명령 교환
  (요청 → 진행 → 응답)의 라이브 활동 피드, 명령 콘솔. 프로젝트 열기·생성이 여기서
  일어나고, 워크스페이스 창은 불투명 `w-<uuid>` 라벨을 쓴다
  ([docs/NAMING.md](docs/NAMING.md), [docs/RESTORE.ko.md](docs/RESTORE.ko.md)).
- **플러그인 플랫폼** — 플러그인은 레지스트리 카탈로그에서 설치되는 독립 git repo다:
  뷰·명령·에디터·파일 뷰어·포메터·아이콘 셋·오버레이
  ([docs/PLUGINS.md](docs/PLUGINS.md), [docs/PLUGIN-CONTRACT.md](docs/PLUGIN-CONTRACT.md)).
- **AI 제어 표면** — 모든 명령이 `sok` CLI·MCP 서버·에이전트 스킬로 발견·호출된다.
  요청·진행 델타·응답은 하나의 봉투 — `{ok, code, message, data}` — 를 따른다
  ([docs/AI-CONTROL.ko.md](docs/AI-CONTROL.ko.md),
  [docs/MESSAGE-PROTOCOL.ko.md](docs/MESSAGE-PROTOCOL.ko.md),
  [docs/COMMANDS.md](docs/COMMANDS.md)).
- **사이드카** — 무거운 엔진(Chromium 브라우저 엔진, workflow 서비스)은 코어가
  링크 없이 로드·스폰하는 별도 산출물이다 ([docs/SIDECARS.md](docs/SIDECARS.md)).
- **identity 홈** — release·dev·debug 가 각자의 홈(`~/.soksak`, `~/.soksak-dev`,
  `~/.soksak-debug`)을 가진다: 데이터·플러그인·사이드카·소켓.

아키텍처 규칙은 [docs/ARCHITECTURE.ko.md](docs/ARCHITECTURE.ko.md)에 있다.

## 스택

- 프론트엔드: React + Vite + TypeScript, `@xterm/xterm`(+WebGL/Unicode11/WebLinks/Clipboard), CodeMirror
- 백엔드: Rust + Tauri v2, `portable-pty`(PTY + ACK 플로우 컨트롤), rusqlite(`app.data`)

## 요구사항

- macOS(현재 빌드 타깃: aarch64) — OS 웹뷰·PTY 는 네이티브 제공
- Rust 툴체인(`cargo`, `~/.cargo/bin` PATH 등록)
- Node.js + `pnpm`

## 빠른 시작

```bash
make install   # 의존성 설치(멱등)
make dev       # 개발 서버(HMR) — soksak-dev
```

## 명령

모든 빌드·실행은 **Makefile 타깃**을 지난다(멱등, 버전 관리). `make help` 가 전체
목록이고, 핵심은:

```bash
make dev          # 개발 서버(HMR) — soksak-dev
make build        # 릴리스 번들 → soksak.app + sok CLI
make build-debug  # 디버그 번들 → soksak-debug.app + sok-debug
make run          # 릴리스 soksak.app 실행
make run-debug    # 디버그 soksak-debug.app 실행
make verify       # tsc + cargo check(커밋 전 게이트)
make test         # Rust 단위 테스트
make test-front   # 프론트엔드 단위 테스트(vitest)
make docs         # 라이브 카탈로그에서 docs/COMMANDS.md 재생성
```

`sok` CLI 는 실행 중인 앱과 소켓으로 대화한다 — `sok help`, `sok commands`,
그리고 모든 레지스트리 명령(`sok window.list`, `sok term.exec '{"cmd":"ls"}'`).

## 3-identity 구분 (dev / debug / release)

세 빌드는 이름·아이콘·identifier·홈이 분리되어 상태를 공유하지 않고 Dock 에서
서로 구분된다.

| | soksak-dev | soksak-debug | soksak |
|---|---|---|---|
| 용도 | HMR 개발 서버 | 디버그 번들(테스트) | 릴리스 번들(일상 사용) |
| 명령 | `make dev` | `make build-debug` | `make build` |
| 홈 | `~/.soksak-dev` | `~/.soksak-debug` | `~/.soksak` |
| Dock 이름 | `soksak-dev` | `soksak-debug` | `soksak` |
| 아이콘 | 초록(`icons-dev/`) | 주황(`icons-debug/`) | 기본(`icons/`) |
| Identifier | `com.soksak.dev` | `com.soksak.debug` | `com.soksak.app` |

`open -n` 은 새 인스턴스를 띄우므로 셋이 동시에 실행될 수 있다.

## 산출물

- 릴리스 앱: `src-tauri/target/release/bundle/macos/soksak.app`
- 디버그 앱: `src-tauri/target/debug/bundle/macos/soksak-debug.app`
- 설치 이미지: `src-tauri/target/release/bundle/dmg/soksak_<version>_aarch64.dmg`

---

English guide: [README.md](README.md).
