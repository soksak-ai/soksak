# soksak

완결된 xterm.js 구성을 따른 독립 Tauri 데스크톱 터미널. 좌측 파일 트리 사이드바
(`@pierre/trees`), 콘텐츠 영역의 터미널/파일 뷰 탭, CodeMirror 파일 뷰어를 갖춘다.
JS 플러그인 시스템(soksak-plugin-spec v1)으로 뷰·포메터·에디터 확장·명령을 확장한다
— [docs/PLUGINS.md](docs/PLUGINS.md).

- 프론트엔드: React + Vite + TypeScript, `@xterm/xterm`(+WebGL/Unicode11/WebLinks/Clipboard)
- 백엔드: Rust + Tauri v2, `portable-pty`(PTY + ACK 플로우 컨트롤)

## 요구사항

- macOS (현재 빌드 타깃: aarch64)
- Rust 툴체인 (`cargo`, `~/.cargo/bin` PATH)
- Node.js + `pnpm`

## 빠른 시작

```bash
make install   # 의존성 설치(멱등)
make dev       # 개발 서버(HMR)
```

## 명령

빌드/실행은 임의 명령이 아니라 **Makefile 타깃**으로 통일한다(멱등·버전관리).

```bash
make help         # 명령 목록
make install      # 의존성 설치
make icons        # dev/debug 아이콘 재생성(기본 아이콘 tint)
make dev          # 개발 서버(HMR) — soksak-dev
make build        # 릴리스 번들 → soksak.app
make build-debug  # 디버그 번들 → soksak-debug.app
make run          # 릴리스 soksak.app 실행(새 인스턴스)
make run-debug    # 디버그 soksak-debug.app 실행(새 인스턴스)
make verify       # tsc + cargo check(커밋 전 검증)
make clean        # 빌드 산출물 제거
make stop         # 실행 중인 개발 서버 종료
```

## 3-정체성 구분 (dev / debug / release)

세 빌드를 macOS 독에서 한눈에 구분하도록 이름·아이콘·identifier 를 분리했다. 기본
설정(`tauri.conf.json`)이 dev 정체성이고, 빌드 시 `--config` 오버라이드로 정확히 푼다.

| | soksak-dev | soksak-debug | soksak |
|---|---|---|---|
| 용도 | HMR 개발 서버 | 디버그 번들(테스트) | 릴리스 번들(상시 사용) |
| 명령 | `make dev` | `make build-debug` | `make build` |
| 독 이름 | `soksak-dev` | `soksak-debug` | `soksak` |
| 아이콘 | 녹색(`icons-dev/`) | 주황(`icons-debug/`) | 기본(`icons/`) |
| identifier | `com.soksak.dev` | `com.soksak.debug` | `com.soksak.app` |
| 표시 | DEV 배지 | — | — |

- HMR(`make dev`)은 **번들이 아니라** 바이너리명(`soksak-dev`)이 독에 그대로 뜬다.
  추가로 앱 안 타이틀바에 녹색 **DEV 배지**(`import.meta.env.DEV`).
- 디버그/릴리스는 번들이라 productName·아이콘·identifier 로 독에서 별개 항목이 된다.

### 병행 사용

```bash
make build && make run      # 릴리스 soksak — 상시 작업용
make build-debug && make run-debug   # 디버그 soksak-debug — 새 기능 테스트용
```

`open -n` 으로 **새 인스턴스**를 띄우므로 세 버전이 동시에 실행된다.

## 산출물

- 릴리스 앱: `src-tauri/target/release/bundle/macos/soksak.app`
- 디버그 앱: `src-tauri/target/debug/bundle/macos/soksak-debug.app`
- 설치 이미지: `src-tauri/target/release/bundle/dmg/soksak_<버전>_aarch64.dmg`

## 플러그인

우측 사이드바(⌥⌘B)가 플러그인 영역이다. 플러그인은 JS 단일 파일로 뷰(우측/좌측
사이드바·콘텐츠 탭)·코드 포메터(⇧⌥F)·에디터 확장(CM6)·명령(sok/MCP 자동 노출)을
추가하며, GitHub 레포에서 설치한다.

```bash
sok plugin.install '{"source":"user/repo"}'   # 설치 후 앱 ⚙ 관리에서 권한 동의·활성화
make example-repos                            # 예제 6종을 독립 git 레포로 생성
```

제작·API·보안 모델: [docs/PLUGINS.md](docs/PLUGINS.md). 예제: [examples/plugins/](examples/plugins/).

## 구조

```
src/
  components/   PaneTree, ViewTabs, LeftSidebarHost, PluginSidebar, FileViewer
  terminal/     createTerminal, paneHosts, shellIntegration, theme
  state/        sessions (프로젝트→뷰 상태), plugins (플러그인 런타임/동의)
  plugins/      spec(매니페스트·원칙), loader, api, hooks, view/editorRegistry
  commands/     registry(단일진실) + catalog(+Plugins/Git)
src-tauri/src/
  pty.rs        PTY 세션 + ACK 플로우 컨트롤
  fs.rs         디렉토리 리스팅 / 파일 읽기(텍스트·base64) / 테마
  plugins.rs    플러그인 설치(git)·전용 저장소
  git.rs        읽기 전용 git 조회(log/show/diff)
  lib.rs        커맨드 등록 + 종료 시 PTY 정리
```
