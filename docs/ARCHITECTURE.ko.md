# soksak 아키텍처 — 뼈대 계약 (v1)

soksak 의 권위 있는 v1 아키텍처 계약이다. 코어(뼈대)와 모든 플러그인을 구속한다. 이 문서와 코드가 어긋나면 코드를 고친다. 이 문서와 단일진실 스키마가 어긋나면, 스키마가 강제할 수 있는 것은 스키마가 이기고 강제할 수 없는 모든 것은 이 문서가 이긴다.

영문 정본: [ARCHITECTURE.md](ARCHITECTURE.md) — 어긋나면 영문이 우선한다.

---

## 1. 정체성과 목적

soksak 은 뼈대다. 공통 인터페이스를 관리하며, 그 외에는 아무것도 하지 않는다.

**뼈대인 것:**
- 콘텐츠에 대한 의견이 없는 콘텐츠 패널의 호스트.
- 레지스트리 substrate: 하나의 커맨드 레지스트리, 하나의 프로그램(+메뉴) 레지스트리, 하나의 뷰-배치 레지스트리, 하나의 capability API, 하나의 이벤트 버스.
- 네이티브 substrate: 창/패널/레이아웃, child-webview 호스팅, PTY spawn, 파일시스템, 데이터 스토어, 시크릿 볼트, 프로세스·네트워크 클라이언트 — 전부 **범용** capability 로 노출.
- CLI·MCP·Skill 표면의 단일 접점 — 커맨드 레지스트리에서 자동 파생.

**뼈대가 아닌 것:**
- 터미널이 아니다. 뼈대는 PTY 를 spawn 하지만 xterm 을 렌더하지 않는다.
- 브라우저가 아니다. 뼈대는 child webview 를 호스팅하지만 주소창을 소유하지 않는다.
- 파일 탐색기나 에디터가 아니다. 뼈대는 파일을 읽고 빈 콘텐츠 슬롯을 내줄 뿐, 파일 보기·편집 경험 — 그리고 에디터 엔진 자체 — 는 교체 가능한 플러그인이다.
- 기능 로직의 자리가 아니다. 터미널·브라우저·파일 탐색기·에디터는 뼈대에 약하게 결합된 독립 플러그인이다.

뼈대는 어떤 콘텐츠도 렌더하지 않는다. 모든 구체 콘텐츠 표면은 4개의 부착 seam(3장)을 통해서만 도착한다. 뼈대로 향하는 사적 경로가 필요한 플러그인은 플러그인의 기능이 아니라 뼈대의 결함이다.

뼈대는 콘텐츠 플러그인 0개로 배포된다. 신선 설치는 빈 프레임으로 열리며, 터미널·에디터·파일·브라우저는 다른 플러그인과 똑같이 필요할 때 설치·활성화된다 — 번들 기본값이나 시드 메커니즘은 없다.

---

## 2. Substrate — 뼈대가 소유하는 것

뼈대는 정확히 아래 공통 인터페이스들을 소유한다. 각 행이 보장을 서술한다. 구체적인 것(xterm, 주소창, 파일타입 분기)은 여기 없다.

| 인터페이스 | 소스 | 보장 |
|-----------|------|------|
| **창 / 패널 / 레이아웃** | `src/state/sessions.ts` | 레이아웃 트리(`GroupNode`, `ViewGroup`, `View`, `ContentArea`)를 소유한다. 분할·이동·닫기·최대화·리사이즈. 트리는 플러그인에 불투명 — 노출되지 않고 커맨드로만 변형된다. 그룹은 뷰 0개(빈 탭)를 가질 수 있다; 뼈대는 자기 프로그램을 돌리지 않으므로 새 프로젝트/새 컨텐츠 탭/전부 닫힌 그룹은 빈 패널로 열리고, 단일 그룹의 마지막 뷰도 닫을 수 있다(그룹은 비워진 채 남는다). 뷰는 프로그램(+메뉴) seam 을 통해서만 추가된다. |
| **프로젝트 정체성 & 단일 오픈** | `src/lib/workspace.ts`(헌법 P1–P6), `src-tauri/src/project_registry.rs` | 프로젝트의 정체성은 root 경로다(P4); 한 root 는 앱 전체에서 최대 한 창에만 열린다(P6). Rust 싱글톤 레지스트리가 시행 지점이다 — 모든 열기/닫기 경로가 `src/state/projectRegistry.ts` 를 지난다; 충돌은 중복 창 대신 소유 창을 포커스한다; 창 파괴는 점유를 해제한다. |
| **워크스페이스 영속 & 복원** | `src/state/workspaceBoot.ts`, `src/state/workspacePersistence.ts`, `src/state/hydration.ts` — 원칙은 [RESTORE.md](RESTORE.md) | 재시작은 창(프레임·포커스)·탭·분할·터미널 cwd·재페인트된 명령 블록을 복원한다. 히스토리는 소유권 위임(블록=터미널 플러그인, TUI 전사=TUI 자신, soksak 은 계보 링크만); 복원과 unlock 재수화는 한 경로를 공유한다; 보이는 뷰가 먼저 마운트되고 나머지는 idle 순서로 채워진다. |
| **범용 콘텐츠-패널 호스팅** | `src/components/GroupArea.tsx`, `src/components/PluginViewHost.tsx` | `view.id` 당 하나의 영속·화면밖-파킹 가능 슬롯을 렌더한다. 슬롯은 빈 컨테이너다. 뼈대는 플러그인-provider mount 계약 이상 어떤 렌더러도 붙이지 않는다. |
| **커맨드 레지스트리(단일진실)** | `src/commands/registry.ts` | 레지스트리는 하나다. 모든 명령(코어·플러그인)은 타입드 파라미터 스키마와 danger 게이트로 1회 등록한다. `catalogJson()` 이 같은 집합을 CLI·MCP·docs 에 자동 노출한다. 이 레지스트리 밖의 명령은 존재하지 않는다. |
| **Capability API(`app.*`)** | `src/plugins/api.ts` | 플러그인이 받는 유일한 런타임 표면. 권한 게이트 — 미선언 권한은 부재(undefined) capability 가 된다. 플러그인별 네임스페이스(`data[ns=pluginId]`, `secrets[ns=pluginId]`, `plugin.<id>.<cmd>`). |
| **이벤트 버스** | `src/plugins/hooks.ts`, `src/plugins/bus.ts` | 시스템 이벤트(`project.*`, `file.*`, `command.*`, `turn.ended`, `theme.changed`, `locale.changed`, `app.focus`, `bookmarks.changed`)는 권한 게이트다. `bus.*` 는 코어 상태와 무관한 플러그인 간 pub/sub 다. |
| **프로그램(+메뉴) 레지스트리** | `src/plugins/programRegistry.ts` | 선언적 `contributes.programs[]`. 각 프로그램은 `kind` 를 선언한다. +메뉴와 `view.open` 이 `kind` 로 라우팅한다. 플러그인이 프로그램을 선언하고, 뼈대가 라우팅한다. |
| **뷰 배치·포커스 레지스트리** | `src/plugins/viewRegistry.ts`, `src/plugins/viewFocus.ts` | `registerView(viewId, provider)` + 배치(`content`, `sidebar-left`, `sidebar-right`, `footer`). mount/unmount 는 수명만 소유한다. 선택적 `prepareFocusTransfer` / `focus` 가 유일한 키보드 포커스 경계다. 코어는 목적지와 순서를 소유하고 provider 는 자기 컨테이너만 다룬다. 마운트는 포커스 의도가 아니며 지연 포커스는 전달된 `AbortSignal`을 반드시 지킨다. |
| **네이티브 범용 capability** | `src-tauri/src/*` | PTY spawn/IO/흐름제어(`pty.rs`), child-webview 수명 + 레이어 역전 + hole-punch(`browser.rs`), 미디어 프록시(`mediaproxy.rs`), 데이터 스토어(rusqlite + FTS5), 시크릿 볼트, 프로세스/WebSocket/HTTP 클라이언트, 파일시스템. 전부 범용 — 어떤 것도 구체 기능 소비자의 이름을 갖지 않는다. |

네이티브 계층이 뼈대에 남는 이유는 PTY 커널 객체와 플랫폼 webview(WKWebView / WebView2)가 플러그인 경계를 넘을 수 없기 때문이다. 뼈대는 이를 범용 capability 로 노출하고, 플러그인은 얇은 클라이언트로 소비한다.

---

## 3. 약한 결합 모델 — 유일한 부착 seam

플러그인은 정확히 4개의 seam 으로만 뼈대에 부착한다. 다른 것은 없다. 사적 채널도, 스토어 직접 import 도, 네이티브 커맨드 뒷문도 없다.

1. **프로그램(+메뉴).** `contributes.programs[]` 가 `kind` 있는 항목을 선언한다. 뼈대가 선택을 맞는 capability 로 라우팅한다. 플러그인이 +메뉴에 나타나는 방법이다.

2. **뷰(배치·포커스).** `contributes.views[]` + `registerView(viewId, provider)` 가 선언된 배치의 범용 슬롯에 provider 를 마운트한다. provider 는 뷰 컨텍스트(4장 A2)만 받는다. 코어는 안정 `viewId`로 포커스 의도를 라우팅한다. 소스 provider 는 `prepareFocusTransfer`에서 일시 입력을 동기 확정하고, 그 다음 대상 provider 가 `focus`에서 자기 canonical input만 포커스한다. 다른 뷰 DOM 조회·포커스는 금지다.

3. **커맨드.** `app.commands.register(name, spec)` 가 타입드 파라미터 스키마와 danger 게이트로 명령 하나를 등록한다. CLI/MCP 에 자동 노출된다. 매니페스트 `contributes.commands` 가 의도를 선언하고, 런타임이 바인딩한다.

4. **Capability.** 선언 권한으로 게이트되는 `app.*` 메서드들 + `app.events.on(...)` + `app.bus.*`. 유일한 런타임 표면이다.

이 4개 seam 으로 표현할 수 없는 것은 플러그인이 해서는 안 되는 것이다. 실제 플러그인이 이 seam 안에서 만들어질 수 없다면 뼈대에 범용 capability 가 빠진 것이다 — capability 를 추가하라(5장). 사적 경로는 절대 만들지 않는다.

---

## 4. 원칙 (A1–A17)

전부 HARD 다. 일부러 절대문으로 서술한다.

### A1. 코어는 구체 콘텐츠를 렌더하지 않는다.
뼈대는 터미널 렌더러도, 브라우저 크롬도, 파일타입 렌더러도 하드코딩하지 않는다. `GroupArea` 는 불투명한 `view.id` 로 빈 슬롯에 디스패치한다. `view.kind` 문자열은 라우팅 라벨이지 구현을 박아 넣을 면허가 아니다. 구체 렌더러(xterm, 주소창, CodeMirror 전략 분기)는 플러그인으로 옮긴다.

### A2. 뷰 컨텍스트가 뷰로 들어가는 유일한 데이터 채널이다.
플러그인 뷰는 `PluginViewContext` 와 `app.*` capability 로만 상태를 받는다. 코어 Zustand 스토어를 import 하거나, `sessions`/`settings`/`ui` 에 손대거나, 레이아웃 트리를 읽어서는 안 된다. 컨텍스트는 정체성(`projectId`, `root`, pane/view 정체성)과 뼈대가 내주기로 한 것만 담는다.

### A3. 범용 capability 만 — 뷰 전용 훅 금지.
뼈대가 노출하는 모든 capability 는 기능 중립이어야 한다. 코어에 박힌 `onBrowserNavigated` 금지 — 범용 webview 이벤트를 노출하라. 코어로 위장한 터미널 전용 spawn 엔드포인트 금지 — 범용 pane/PTY capability 를 노출하라. 한 소비자의 이름을 딴 capability 는 락인이며 금지된다. 기존의 기능명 이벤트(`browser-nav`, `native-mousedown`)는 마이그레이션 부채이지 계약이 아니다 — 5장에 따라 일반화된다. (`browser_*` invoke 계층은 docs/NAMING.md 에 따라 `webview_*` 로 개명 — 파일 `webview.rs`.)

### A4. 코어 락인 금지.
뼈대는 터미널/브라우저/파일이 내장이라고 가정해서는 안 된다. 뷰 kind, 프로그램 kind, 라우팅은 데이터 주도여야 하며 뼈대가 특별 취급하는 고정 enum 이어서는 안 된다. 새 콘텐츠 서브시스템 추가에 뼈대 수정이 0 이어야 한다.

### A5. 단일진실은 스키마/스펙이다.
`src/plugins/spec.ts`(매니페스트·권한·기여)와 `src/commands/registry.ts`(커맨드 카탈로그)가 단일진실이다. 이 문서의 산문은 스키마가 강제할 수 없는 조언만 더한다. 스키마가 이미 강제하는 것을 산문으로 되풀이하지 말고, 스키마가 뒷받침하지 않는 제약을 지어내지 마라.

### A6. 멱등.
모든 플러그인 액션은 반복해도 안전해야 한다. 활성화·autorun·뷰 마운트·명령 실행은 한 번이든 여러 번이든 같은 상태로 수렴해야 한다. 세션 중 리로드된 플러그인은 깨끗한 부트를 가정하지 말고 현재 상태에서 reconcile 해야 한다.

### A7. 독립.
각 플러그인은 자체 빌드·테스트·수명주기를 가진 독립 git 저장소다. 플러그인은 선언된 매니페스트 `dependencies` 를 넘어 뼈대나 다른 플러그인의 내부 소스에 의존해서는 안 된다. 전이 의존성 해소와 연쇄 제거는 뼈대가 한다 — 플러그인이 하지 않는다.

### A8. 제거 가능(분리 테스트).
어떤 플러그인을 제거해도 뼈대와 무관한 플러그인들은 완전히 동작해야 한다. 플러그인 비활성화는 그 뷰를 닫고 커맨드/프로그램을 등록 해제하며 고아 네이티브 리소스를 남기지 않는다. 플러그인 제거가 뼈대를 깨면 그 결합은 불법이다.

### A9. 추가에 코어 수정 0(결합 테스트).
새 플러그인 추가에 뼈대 수정이 0 이어야 한다. 새 플러그인이 뼈대 수정을 강요하면 뼈대에 범용 capability 가 빠진 것이다 — substrate 의 그 구멍을 메운 뒤, 코어 diff 0 으로 플러그인을 추가하라.

### A10. 테마는 호스트 CSS 변수로.
플러그인 뷰는 오직 shadow root 로 전파되는 호스트 주입 CSS 커스텀 프로퍼티로만 테마를 상속한다. 플러그인은 테마 스토어를 읽거나, 팔레트 값을 하드코딩하거나, 테마 이름으로 분기해서는 안 된다. 호스트를 다시 칠하면 규격을 따르는 모든 플러그인이 플러그인 수정 없이 다시 칠해진다.

### A11. 에디터는 플러그인이다 — 뼈대는 라우팅만 하고 편집하지 않는다.
경로를 콘텐츠로 여는 것은 범용 뼈대 라우팅 커맨드(`editor.open` — 경로를-콘텐츠로)를 지나, 그 파일 타입의 뷰어를 등록한(`registerFileViewer`) 플러그인으로 디스패치된다. 뼈대는 에디터 인스턴스를 소유하지 않고 에디터 엔진을 공급하지 않는다. 에디터 플러그인이 자기 엔진(기본 CodeMirror, 교체로 Monaco 등)을 소유하고 스스로 번들하며 자기 확장 표면을 노출한다; 포매터·언어 플러그인은 뼈대가 아니라 에디터 플러그인에 매니페스트 `dependencies` 로 의존한다. 활성 파일 읽기/쓰기는 에디터 플러그인의 capability 이며 커맨드/이벤트 표면으로 중개된다 — 뼈대 소유 에디터가 아니다.

### A12. 검증하라, 가정하지 마라.
적합성은 주장이 아니라 증명이다(6장). "분리돼 보인다"는 분리가 아니다. 매치를 돌려주는 grep 은 스타일 노트가 아니라 실패한 분리 테스트다.

### A13. 엔진 중립 프리미티브 — 뼈대는 엔진을 고정하지 않는다.
뼈대는 엔진 중립의 날 것 substrate 만 노출한다: 날 PTY 바이트, 파일 IO, OS-webview 호스팅 프리미티브(가능한 렌더링 접근 중 하나일 뿐), 빈 콘텐츠-패널 표면. 구체 엔진은 고정하지 않는다. 터미널 에뮬레이터(xterm 또는 다른 것), 에디터 엔진(CodeMirror 또는 Monaco), 브라우저 엔진(OS webview 또는 Chromium)은 각각 플러그인의 교체 가능한 선택이다. 한 엔진만 만족할 수 있는 capability — CodeMirror `Extension` 타입, xterm 애드온, WebKit 전용 eval 형태 — 는 뼈대가 아니라 그 엔진을 소유한 플러그인에 속한다. 대안 엔진이 뼈대에 없는 프리미티브를 필요로 하면(예: 외부 Chromium 표면 임베드) 그 플러그인을 만들 때 범용으로 추가한다(A9) — 한 엔진을 특별 취급하지 않는다. 헤드리스 엔진도 엔진이다: 터미널 바이트를 화면 상태로 바꾸는 VT 해석기(alacritty_terminal 기반 미러)는 바이트의 *의미* 를 읽고 엔진 코드를 번들하므로, 코어-프리미티브 테스트의 둘째 다리(NAMING §3(b): 코어는 엔진 코드를 번들하지 않는다)에서 Chromium 과 똑같이 탈락한다 — 코어 밖, 엔진 명명 터미널 사이드카(기본 `soksak-sidecar-terminal-alacritty`)로 산다(`soksak-sidecar-browser-chromium` 의 터미널-도메인 대응). 이 유닛은 엔진 중립 계약 `soksak-spec-sidecar-terminal` 을 구현하고, `-wezterm`·`-vt100`·`-ghostty` 유닛이 같은 계약을 대신 구현한다. 계약 본문·합격시험·벤치마크는 모든 구현체 밖의 `soksak-contract-terminal`(NAMING §4a)에 산다. 런타임 모델은 Chromium 과 다르다 — 표면 결속 in-process 엔진이 아니라 헤드리스 생존 서비스(A14) — 하지만 판정은 동일하다: 해석은 엔진이고, 엔진은 코어가 아니다. 그 아래 날 PTY substrate(스폰·바이트·시퀀스 붙은 링·흐름제어)는 해석이 없어 테스트의 첫째 다리로 코어에 남는다.

### A14. 무거운 플러그인 전용 네이티브 코드는 사이드카다 — 뼈대 의존성이 아니다.
뼈대의 네이티브 의존성은 **뼈대만 제공할 수 있는 호스트 전용 프리미티브** — PTY 할당, `Origin` 없는 WebSocket, UDP, 인메모리-키 시크릿 볼트, 파일 IO, OS-webview 호스트 — 와 그 위의 범용 capability 로 한정된다. **한** 기능만 섬기고 JS 플러그인이 물리적으로 돌릴 수 없는 무거운 네이티브 코드(P2P 전송 스택, 프로토콜 구현, 핑거프린팅 HTTP 포크)는 뼈대 바이너리에 속하지 않는다. 컴파일 타임 의존은 여전히 뼈대에 링크돼 얇은-뼈대 목표를 무너뜨린다; 그래서 그런 코드는 **자기 플러그인 repo 의 사이드카 바이너리**로 살고, `process` capability 로 spawn 되어 소켓으로 뼈대와 대화한다 — **vendored + 해시 핀**. 판정 순서:
1. **JS 플러그인이 기존 capability 로 할 수 있는가?** → JS 플러그인이다(예: `app.process`/`app.data` 위의 clubhouse).
2. **JS 플러그인도 별도 프로세스도 복제할 수 없는 호스트 전용 프리미티브인가**(PTY, `Origin` 없는 소켓, 인메모리-키 볼트, fs, webview)? → **범용 뼈대 capability** 다.
3. **앱 자신의 창에 렌더해야 하는 무거운 네이티브 코드인가**(프로세스-로컬 NSView 부착 — 별도 프로세스는 물리적으로 불가)? → **엔진 사이드카**다: 범용 엔진-호스팅 프리미티브(`app.sidecar` — docs/SIDECARS.md) 뒤의 in-process dylib. 뼈대는 아무것도 링크하지 않고 그 메시지를 이해하지 않는다 — 플러그인 요청에 dlopen 하고, 바이너리의 ABI 자기보고를 플러그인 선언과 대조하고, 표면을 넘기고, 릴레이한다.
4. **무겁고 자기완결적이며 플러그인 전용인 네이티브 코드**인가 — JS 불가, 범용 프리미티브 아님, 표면 비종속? → **자기 repo 의 서비스 사이드카 바이너리**로, `process` capability 로 spawn 된다.
예: 원격 제어 스택(iroh QUIC + Noise)은 서비스 사이드카 `soksak-plugin-remote-iroh` 다 — 뼈대는 `iroh` 를 링크하지 않는다. Chromium 브라우저 엔진은 엔진 사이드카 `soksak-sidecar-browser-chromium` 이다 — 뼈대는 Chromium/CEF 를 링크하지 않는다. 교체 가능한 엔진은 엔진 이름을 갖는다(`remote-iroh`, `browser-chromium` — 플러그인 명명 규약).

### A15. 크레이트가 아니라 인터페이스를 통일하라.
두 백엔드가 진짜로 다르면(순정 HTTP vs 브라우저 위장 HTTP; 안정 클라이언트 vs 핑거프린트 위조 포크) 한 크레이트로 강제 통합하지 마라. 뼈대는 두 구현을 유지하고 **opt-in 모드가 있는 하나의 capability** 를 노출한다(예: `net.http.request` 의 `impersonate?: "off" | "chrome"`). 플러그인은 capability 를 호출한다 — 자기 HTTP/WS/PTY 를 번들하지 않는다. 하나 이상의 플러그인이 쓰는 모든 capability 는 범용 커맨드-레지스트리 capability — 권한 게이트·ns 격리·CLI/MCP 자동 노출 — 다(SQLite 위의 `app.data` 처럼). 바퀴는 한 번만 발명한다. **인터페이스**를 통합하고, 진짜로 다른 구현들은 유지한다(공존해야 한다면 그 이유를 기록한다 — 숨기지 않는다).

### A16. 코어→플러그인 추출은 이동이지 재작성이 아니다.
서브시스템이 뼈대를 떠날 때 코드는 **원문 그대로 이동**한다 — 통합 seam 만 바뀐다(in-process 호출이 소켓/capability 호출이 된다). 검증된 코드와 그 테스트는 온전히 여행한다 — 절대 재구현하지 않는다. 뼈대 쪽 커밋은 **"separated from core"** 라고 말한다 — "ported"·"migrated"·"transplanted"·"realized"·"rewritten" 은 금지. (A8 의 분리 테스트가 제거를 증명하고, 이 규칙은 코드가 여행하는 방식을 다스린다.)


### A17. identity 하나, 홈 하나 — identity 간 공유는 없다.
각 앱 identity(`com.soksak.app` → `~/.soksak`, `com.soksak.dev` → `~/.soksak-dev`, `com.soksak.debug` → `~/.soksak-debug`)는 완전히 독립된 홈을 소유한다: 데이터 DB·플러그인·사이드카·테마·프로젝트·시크릿 금고·백업·소켓이 전부 그 한 루트에서 파생된다(`home.rs soksak_home()` — 단일 진실; 새 identity 는 identifier 마지막 세그먼트에서 자동으로 자기 홈을 얻는다). 무엇이든 공유하면 상태가 identity 경계를 넘는다 — 실측: 공유 크로미움 프로필의 ProcessSingleton 이 두 번째 앱의 엔진 기동을 첫 앱으로 위임했다(그쪽엔 유령 네이티브 창, 이쪽엔 백지 브라우저 뷰). `SOKSAK_HOME` 이 파생을 오버라이드한다(테스트 격리 — `SOKSAK_VAULT_PATH` 와 같은 오픈 테스트 메커니즘). `sok` CLI 는 독립 busybox 바이너리라 같은 계약을 자체 구현한다(`cli/src/main.rs home_for_env`); 이 절이 그 계약의 정본이다. release 홈은 **설치본만** 담는다 — 레지스트리 설치 플러그인(semver 자기기술)과 GitHub 릴리스에서 받은 해시 핀 사이드카 dist. 개발 소스는 어떤 것도 들어가지 않는다. dev 표면은 release 에서 identity 게이트로 봉쇄된다: `plugin.dev.*` 거부, `version=dev|local` 자기기술 폴더는 로드 거부. 어느 identity 에도 상시 env 소스 주입은 없다 — 지정 홈 디렉토리(plugins, sidecars/dist)가 유일한 상시 해석 경로다. 외부 폴더 일회 플러그인 로드는 명시적 `plugin.dev.load` 명령으로, 사이드카 신선 빌드는 `stage.sh` 로 identity 홈에 스테이징한다.

---

## 5. 추출 대상

서브시스템별로: 뼈대에 **남는 것**(범용 인터페이스), 플러그인으로 **옮기는 것**(구체 구현), 뼈대가 노출해야 하는 범용 capability. 구멍은 근거 있는 서브시스템 지도에서 인용한다. (개별 판정의 상세는 영문 정본 5장 참조 — 터미널·브라우저·파일/탐색기·에디터는 뼈대 프리미티브 위의 JS 플러그인으로, 원격 전송(iroh)은 서비스 사이드카로, Chromium 엔진은 엔진 사이드카로 각각 추출 판정·완료 상태가 기록돼 있다.)

---

## 6. 적합성

분리와 결합은 주장이 아니라 테스트다.

### 분리 테스트 (A8 — 제거 가능)
- **Grep 게이트:** 뼈대에서 구체 서브시스템에 대한 하드코딩 참조(`GroupArea` 의 xterm import, 마이그레이션 shim 밖의 `browser-nav` 리터럴, 렌더러 로직을 실은 `view.kind === "file"` 전략 분기)를 검색하면 선언된 범용 substrate 밖에서 **0 건**이어야 한다. 0 이 아니면 실패한 테스트다.
- **비활성-생존:** 각 플러그인을 `plugin.disable` 로 끈다; 뼈대와 무관 플러그인은 고아 PTY·webview·잔존 등록 명령 없이 완전히 동작한다.

### 결합 테스트 (A9 — 추가에 코어 수정 0)
- 플러그인 추가는 뼈대 소스에 **diff 0** 을 낳는다. 플러그인은 4개 seam(3장)으로만 부착한다. 뼈대 수정이 필요하면 테스트 실패이며 빠진 범용 capability 의 신호다(5장).

### 빌드·레지스트리 게이트
- `make verify` 그린: 매니페스트 검증(`spec.ts`), 커맨드-레지스트리 일관성(`catalogJson()`), 의존성 그래프 해소 통과.
- 모든 명령은 레지스트리에서 도달 가능하다; 레지스트리 밖의 명령은 없다.

### CLI / E2E 자가 검증
- 모든 플러그인 capability 는 소켓 E2E 하니스(`SOKSAK_SOCKET`)의 커맨드 표면으로 구동된다: 실제 앱을 몰고, 명령을 돌리고, 결과를 읽고, RED→GREEN 을 증명한다. "테스트할 기능이 없다"는 핑계가 아니다 — 범용 표면(`data.*`, `secret.*`, `ui.tree`/`ui.input.click`)과 대칭 오픈 env 격리를 쓴다.

### 시각 검증 (UI)
- UI 적합성은 헤드리스 DOM 단언으로 충족되지 않는다. `window.snapshot` 으로 캡처하고, PNG 를 읽고, 뷰가 호스트 테마 변수를 상속하며(A10) 네이티브-레이어 비침 없이 렌더됨을 확인하고, 맞을 때까지 반복한다.

---

## 7. 결합 법칙 (C1–C5)

이 절은 서술이 아니라 법이다. 1장의 정체성("뼈대가 아닌 것")과 3장의 약한 결합 모델에 시행 조항을 달고, 결합 규율을 플러그인↔뼈대 seam 에서 플러그인↔플러그인 결합으로 확장한다. 여기 명명된 모든 게이트는 도입 즉시 blocking 이다. experimental 게이트를 절대 축적하지 마라 — blocking 하지 못하는 게이트는 게이트가 아니라 백로그다.

> 사용자 입법 원문: "코어는 그 무엇과도 강력결합하지 않는다. 모든 것을 오픈하고 규칙화해서 인터페이스를 통해 플러그인이 서로 교류하여 자신의 역할을 다한다. 반드시 모든 DOM을 노출하고 모든 command를 노출하고 모든 status를 노출해 투명하게 데이터를 연결하고 처리한다. 플러그인끼리도 강력 결합하지 않는다."

### C1. 코어는 특정 플러그인도 특정 기능도 모른다.
코어 소스에 플러그인 id 를 절대 쓰지 마라. 기계 게이트는 `src/`·`src-tauri/` 의 실행 경로 코드(핸들러·상수·분기)에서 `soksak-plugin-` 문자열을 스캔해 0 건이어야 한다. 스캔은 명시적 allowlist 를 갖는다 — 커맨드 `examples` 문자열(예시 속 실플러그인 id 는 placeholder `soksak-plugin-<id>` 로 교체), 주석 속 스펙 패키지명, 단일 레지스트리 repo URL 상수 — allowlist 는 C5 절차 없이는 절대 늘지 않는다. 코어 UI 는 기능 데이터를 스스로 계산하지 않는다: 데코레이션·배지·상태 표시는 레지스트리 커맨드·이벤트의 소비자로만 동작한다. 프리미티브를 기능 네임스페이스 밑에 절대 두지 마라. 이 조항은 1장과 A3/A4 에 시행을 더할 뿐, 새 정체성을 더하지 않는다.

### C2. 모든 기능은 세 표면을 노출한다 — 투명성 3종.
- **command** — 뷰가 있는데 커맨드가 0 인 플러그인은 통과하지 못한다(게이트: views > 0 ∧ commands = 0 → 실패).
- **status** — 모든 뷰는 status 축으로 상태를 보고한다; status 축이 볼 수 없는 뷰는 통과하지 못한다.
- **DOM** — 조작 가능한 모든 UI 는 `contributes.nodes` / `ui.tree` 로 노출되고 `ui.input.click` 경로가 보장된다. selector 추측으로만 닿는 요소를 절대 출하하지 마라.

세 표면 중 하나라도 빠진 기능은 미완성이다 — 출하하지 마라. 3종의 doctor/conformance 게이트는 도입 즉시 blocking 이다.

### C3. 플러그인 간 결합은 계약으로만 — 결합 사다리.
3장이 플러그인↔뼈대 seam 을 고정한다; 이 사다리는 플러그인↔플러그인 결합을 고정한다.
- **L0 — 내부 침범: 금지.** 다른 플러그인의 사유 DOM·내부 상태·파일 위치·로딩 순서에 절대 손대지 마라. 런타임 에러 강제는 유지된다.
- **L1 — 이름-핀: 과도기, 격하.** 신규 결합에 pluginId 를 절대 하드코딩하지 마라. 기존 이름-핀은 마이그레이션 부채이며 L2 도입 즉시 이행 목록에 오른다.
- **L1 — 구현체 이름 고정: 금지.** 소비자는 다른 플러그인 id를 capability 경계로 선택하지 않는다.
- **L2 — 계약 고정: 필수.** 공급자는 `implements`에 `{id,version}`, 소비자는 `consumes`에 `{id,range}`를 선언한다. 발견은 계약 지정·구현체 무차별이며 conformance가 선언 ≡ 실제를 증명한다.
- **L3 — 이벤트/데이터: 선언된 스키마로만.** `contributes.events` 는 장식이 아니라 검증 대상이다. 미선언 형태를 절대 발행·소비하지 마라.

### C4. 계약 정체성과 호환성은 명시한다.
계약 id는 `soksak-spec-<kind>-<domain>`을 따른다. 공급자는 전체 SemVer 버전, 소비자는 SemVer 범위를 노출한다. first-party `0.0.1` 기준선에는 호환성 약속이 없으므로 first-party 소비 범위도 정확히 `0.0.1`이다. 호환성 주장은 버전이 붙은 계약과 같은 기준의 conformance 증거가 있을 때만 바뀐다.

### C5. 기준은 무언으로 약해지지 않는다.
구현이 기준을 못 맞춘다고 기준을 낮추지 않는다. 올바른 기준에 테스트가 빨갛다면 구현·fixture·문서·노출 인터페이스를 고친다. 기준 자체가 틀렸다면 충돌 증거를 명시하고, 버전이 붙은 기준 변경과 같은 테스트를 함께 반영한다. 무언 완화와 무언 예외는 금지한다.

---

Version: 0.0.1
Status: AUTHORITATIVE (영문 정본의 번역본)
단일진실: 공개 `soksak-spec` 자산과 공개 Command Registry
이 문서는 그 스키마들이 강제할 수 없는 조언만 더한다.
