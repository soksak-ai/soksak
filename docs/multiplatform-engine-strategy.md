# 멀티플랫폼 엔진 전략 — Tauri 잔류 · CEF-사이드카-온리 (2026-07 조사 기록)

## 1. 질문과 제약

"Rust 메인 언어 + JS/TS/React/Svelte 프론트 자유 + 가장 심플한 멀티플랫폼 데스크탑"의 답을 찾는다. 후보: Tauri 2, Wails 3, webui, Electrobun, raw wry+tao, Dioxus/Slint/egui/iced, Verso/Servo, Electron.

하드 제약 4개:

- C1 — Rust가 앱의 주 백엔드 언어여야 한다.
- C2 — 프론트엔드는 JS/TS 생태계 전체가 자유롭게 가능해야 한다.
- C3 — 콘텐츠 표면은 "브라우저가 하는 모든 것 / 브라우저 JS로 되는 모든 것"을 감당해야 한다.
- C4 — macOS/Linux/Windows를 시작으로 iOS/Android까지 전 플랫폼을 아우른다.

C4 재해석(2026-07-08 합의): 모바일은 저수준 API를 쓰지 않는 패키징 웹앱이 대부분이라는 경험칙에 따라 가중치를 낮춘다. iOS는 프로세스 스폰·PTY·dylib·CEF가 모두 불가하므로 모바일 soksak은 필연적으로 데스크톱/서버 데몬에 붙는 **원격 웹 클라이언트**다 — §7-1의 transport 추상화가 모바일 경로를 겸한다. 따라서 C4의 실질은 "데스크톱 3-OS 네이티브 + 모바일은 transport 위의 웹 클라이언트"이며, 모바일을 엔진 선택의 결정 근거로 쓰지 않는다.

## 2. 조사 방법과 스냅샷 주의

2026-07-08, 병렬 리서치 에이전트 20개 + 결론을 뒤집을 수 있는 핵심 주장별 적대적 검증(1차 소스 반박 시도). verdict 분포: confirmed 7 / partially-true 4 / refuted 1. 이 문서의 프레임워크 사실은 전부 **2026-07-08 스냅샷**이다 — §10의 재평가 트리거 없이 이 스냅샷을 미래 사실로 인용하지 않는다.

## 3. 검증된 지형

| 후보 | 2026-07-08 상태 (검증됨) | 판정 |
|---|---|---|
| **Tauri 2** | 2.11.5 stable (2026-07-01), 1–2주 패치 케이던스. iOS/Android 1급 지원(웹 프론트 프레임워크 중 유일). 단 `add_child`/multiwebview는 여전히 `unstable` 피처 게이트(2.12 마일스톤에 breaking fix #15625 포함), Linux webkitgtk 그래픽 결함은 env-var 워크어라운드가 공식 답 | **승자** |
| Wails 3 | 여전히 알파(v3.0.0-alpha2.116 나이틀리, 2026-07-07). Go 전용 — 비-Go 호스트 메커니즘 부재 확인. 모바일 experimental | C1 탈락 |
| webui | 스테이블 릴리스가 역사상 0회(최신 태그 2.5.0-beta.3, 2025-03). 공식 채널이 나이틀리. Rust 바인딩은 crates.io 부재·git 전용. 브라우저 모드는 창 제어·네이티브 합성 원천 불가 | C3·성숙도 탈락 |
| Electrobun | v1.0 (2026-02-06), TS-on-Bun 메인. **공식 Rust main-process SDK가 2026-07-04 main에 커밋**(2,417줄 + `mainProcess: "rust"` 템플릿) — 단 태그 릴리스 미포함(npm latest 1.18.1은 5월). Win/Linux는 v1에 포함됐으나 3-OS 실사용 파손 이슈 확인. 버스팩터 1. 모바일 없음 | 오늘 탈락 / **관찰 1순위** |
| raw wry+tao | wry 0.55.1 활성. 그러나 typed IPC·권한 체계 부재 — "툴링 뺀 Tauri", 같은 엔진에 더 많은 일 | C-없음, 심플성 탈락 |
| Dioxus / Slint / egui / iced | UI가 Rust/RSX/DSL — React/Svelte 호스팅 불가 | C2 탈락 |
| Verso | **2025-10-08 리포지토리 아카이브(사망)**. `tauri-runtime-verso` 릴리스 0개, 2025-10-03 이후 무활동, GitLab 이주설도 반박됨. 단 Servo 본체는 `servo` crate 0.1.0을 2026-04-13 출시(임베더블 엔진 + LTS) — 셸이 아닌 엔진-as-라이브러리 신호 | 탈락 |
| Electron | Rust가 napi/사이드카로 강등 | C1 탈락 |

벤치마크 각주(Elanis 저장소, 2026-07-05 재생성): Tauri Win x64 빌드 ≈3MB. Tauri Linux CI 시동 30.3s는 미규명 이상치(같은 WebKitGTK의 Wails는 245ms — 실기기 재측정 전 인용 금지). Win 빈-앱 메모리 Tauri ≈313MB > Electron ≈275MB(CI 한정) — "Tauri가 Windows에서 가볍다"를 셀링 포인트로 쓰지 않는다.

## 4. 구조적 사실 (프레임워크 무관)

- **F1 — iOS는 WebKit 강제.** 전 플랫폼 단일 브라우저 엔진은 구조적으로 불가능하다. C4를 유지하는 한 웹 프론트는 엔진 교집합 타깃 + 기능 감지가 강제된다.
- **F2 — 골격은 수렴한다.** 웹뷰 + 플랫폼별 호스트 셸 + IPC + 플러그인 메커니즘은 플랫폼 제약이 결정하는 모양이다. 자작해도 Tauri 형태에 도달한다(Wails=Go판, Electrobun=Zig/TS판). 혁신 예산을 골격에 쓰지 않는다.
- **F3 — 분기는 층별로 다르다.** Rust 비즈니스 로직: 무분기. 웹 프론트: 엔진 교집합 문제(Rust 아님). 네이티브 표면(PTY·웹뷰 합성·dylib 로딩): 어떤 프레임워크를 써도 per-OS 작업.

## 5. 결정

- **D1 — Tauri v2 잔류.** 근거: Rust ~12k LOC 중 8–9k가 프레임워크 무관, 프론트 36.4k LOC는 invoke+events 경계 뒤에 있다. 이탈 = 81-커맨드 IPC 재배관 + 동일한 네이티브 포팅 비용. 생존 대안이 없다(§3).
- **D2 — Windows/Linux의 브라우저 엔진은 CEF 사이드카 온리.** macOS의 layer-inversion / hole-punch / hitTest-swizzle 서브시스템(webview.rs)은 **이식하지 않는다 — 대체만 한다.** Windows WebView2에는 hitTest 심이 없고(CompositionController + DirectComposition 트리 필요), wry의 Linux child webview는 X11 전용(Wayland 불가, 검증됨)이다. 이 결정으로 `unstable` 피처 노출과 Wayland 리스크가 macOS 한정으로 축소된다.
- **D3 — 병치, 교체 금지.** OS 웹뷰 = 앱 UI 셸 / CEF = 콘텐츠 표면. UI 셸의 CEF 전면 교체를 기본 계획으로 삼지 않는다: Windows OS 웹뷰는 이미 Chromium이라 이득이 없고, 모바일 진출 시 앱 UI의 엔진 매트릭스가 갈라지며, Tauri IPC·플러그인 주입을 상실한다. 앱 UI를 OS 웹뷰(WebKit 교집합)에 두는 것 자체가 모바일 대비 규율이다.
- **D4 — tauri 7-crate 포크(WKWebView 릭 픽스)는 per-target 게이트.** 릭은 macOS 전용이다. Win/Linux 빌드는 업스트림을 추적해 포크 리스크를 0으로 만든다. 업스트림 릭 픽스 병합 감시 canary를 리베이스 전에 둔다(이중 해제 위험).
- **D5 — Linux 승격(§7)은 스파이크 실측 후에만 발동한다.** 사전 채택 금지.

## 6. 표면 승격 규칙 — 플러그인 표면의 엔진 라우팅

D3의 병치는 표면 단위 라우팅 규칙으로 일반화된다: **OS 웹뷰의 보장(기능·성능 불변식)을 초과하는 표면은 CEF 표면으로 승격하고, 나머지는 OS 웹뷰에 남긴다.** 판정 단위는 "플러그인 표면 × 플랫폼"이다 — 같은 표면이라도 플랫폼마다 답이 다르다.

첫 실증: **astryx** — macOS WKWebView에서 정상 동작 불가 → Chromium 사이드카 표면으로 승격(2026-07 진행 중).

- **R1 — 기본 배치는 OS 웹뷰.** 승격은 플러그인 매니페스트 선언으로만 일어난다. 코드 분기·수동 배치로 승격하지 않는다.
- **R2 — 승격 사유는 구조적 불능만.** OS 웹뷰에 없는 기능, 또는 문서화된 성능 불변식 위반(예: [PERFORMANCE.md](PERFORMANCE.md) composite-stretch, webkitgtk 침묵 WebGL 폴백)이 사유다. "약간 느림"은 사유가 아니다 — macOS에서 승격은 hole-punch 합성 세계의 표면을 하나 늘리는 비용을 매번 지불한다.
- **R3 — 선언 형태** (플러그인 계약 스케치 — 확정 시 `src/plugins/spec.ts` 스키마가 단일진실이며 이 산문은 폐기):

```ts
engine?: {
  capabilities?: string[]                               // 권장: 요구 능력 선언 ("webgpu", "wasm-threads", ...)
  require?: "chromium-grade"                            // 탈출구: 전 플랫폼 통째 요구
  when?: { platform?: ("linux"|"macos"|"windows")[] }   // 조건부 발동 (예: linux에서만)
  compositing?: "windowed" | "offscreen"                // 호스팅 모드 — SIDECARS.md §8이 규범
}
```

compositing 축 실증(2026-07-08): offscreen 호스팅 모드(공유 텍스처 → 엔진 소유 레이어)가
엔진 프로토콜의 additive 어휘로 구현됨 — **코어 변경 0**(A9 실증). 픽셀·입력(마우스/휠/키/
한글 IME)·cefQuery 브리지는 엔진 E2E 하니스가 단언한다. 검증된 부정 지식(픽셀-over-IPC-
into-DOM 불가)은 이 구현으로 대체되었다 — 픽셀은 프로세스 안에서 GPU 핸들로만 이동한다.

- **R4 — "chromium-grade"는 CEF라는 산출물이 아니라 엔진 등급이다.** 플랫폼의 OS 웹뷰가 이미 등급을 충족하면(Windows WebView2 = Chromium) 승격은 no-op이다. 특정 엔진 버전 고정이 필요한 표면만 별도 선언으로 CEF를 강제한다.
- **R5 — 판정은 스켈레톤의 라우팅 순수함수가 단독 소유한다.** 플러그인은 선언만 한다 — 런타임에 스스로 엔진을 고르지 않는다. 능력×플랫폼 지원표는 스켈레톤이 소유·갱신한다. (A13: 엔진 선택은 플러그인의 것, 라우팅은 스켈레톤의 것.)
- **R6 — 모바일에는 승격 채널이 없다** (CEF 부재). 승격 선언된 표면은 모바일(원격 웹 클라이언트, §1 C4 재해석)에서의 축소 모드 또는 미제공을 함께 선언한다.

플랫폼별 기본 문턱:

| 플랫폼 | OS 웹뷰 | 예상 승격 빈도 | 비고 |
|---|---|---|---|
| macOS | WKWebView | 예외적 | 승격마다 hole-punch 합성 비용 — 문턱 최고. astryx가 이 예외 |
| Windows | WebView2 (Chromium) | 거의 없음 | chromium-grade 요구는 no-op; 엔진 버전 고정 요구만 승격 |
| Linux | webkitgtk | 기본값에 가까움 | CEF가 D2로 상주 — 한계비용 낮음, 문턱 최저 |
| iOS/Android | (원격 웹 클라이언트) | 채널 없음 | R6 |

## 7. Linux 플랜 B — 풀-윈도우 CEF 승격 견적

발동 조건: webkitgtk가 앱 UI 크롬조차 실측 불합격일 때만. "교체급"이 아니라 **전송층 교체 + 서빙층 신설**로 국소화된다.

불변(비용 아님): React 전체(CEF=Chromium이라 오히려 webkitgtk 대응 감소), Rust 백엔드 전체, 플러그인 뷰층(DOM 마운트), 번들 무게(CEF는 D2로 어차피 탑재), 창 관리(tao 창 유지 + CEF를 풀-윈도우 X11 차일드로).

작업 목록:

1. **Transport 추상화 (본체).** invoke/events는 wry 주입 스크립트라 CEF에 없다. 프론트에 invoke-transport ↔ websocket-transport 추상화를 넣고, sok 데몬을 WebSocket + 로컬 인증 토큰으로 UI에 개방한다. 커맨드가 단일 레지스트리 + 단일 엔벨로프이므로 어댑터 1개로 전체가 이동한다. 이 추상화는 일회성 비용이 아니라 영구 자산이다(프레임워크 이탈 옵션, 원격 UI 가능성 — ARCHITECTURE.md A13의 완성).
2. `asset://` 대체 — CEF 커스텀 스킴 핸들러 또는 로컬 HTTP 서빙(mediaproxy 패턴 재활용).
3. 부트스트랩 주입 — init script·테마 CSS 변수를 `OnContextCreated` 경로로.
4. `tauri-plugin-webview-capture` 대체 — CEF 네이티브 캡처(Chromium 쪽이 더 쉬움). 여타 플러그인은 Rust 커맨드라 transport를 타면 자동 해결.
5. 검증 — X11 IME(한글 입력), DnD, 멀티윈도우 포커스, Wayland/Ozone.

보너스: UI까지 CEF가 되면 Linux에서 hole-punch 문제 자체가 소멸한다 — 단일 Chromium 세계에서 UI 뷰 + 콘텐츠 브라우저 뷰를 합성한다(Electron WebContentsView 모델과 동형, Rust는 유지).

## 8. 리스크 대장

| # | 리스크 | 심각도 | 완화 |
|---|---|---|---|
| 1 | `add_child` unstable 게이트, 안정화 약속 없음(2.12에 breaking fix #15625) | High | D2로 노출을 macOS 한정으로 축소; Tauri 마이너 핀; A13 인터페이스 유지로 macOS도 후일 CEF 이관 가능 |
| 2 | Tauri v3 하부 재작업(tao→winit, GTK4, 1st-party CEF/Servo 런타임 프리뷰; 마일스톤 ~27%) | Med-High | v3 조기 채택 금지; 1st-party CEF 런타임은 사이드카 투자와의 수렴 기회로 취급 |
| 3 | 포크 유지 + 업스트림 릭 픽스 시 이중 해제 위험 | Med | D4 per-target 게이트; `with_webview_balanced` 폴백 보존; 리베이스 전 changelog canary |
| 4 | Linux webkitgtk 그래픽 결함(메인 DOM 웹뷰) | Med | GPU-heavy는 CEF 패널로 격리; DMABUF/NVIDIA env-var 폴백 출하; Linux xterm은 DOM 렌더러 검토; CI 30s 수치는 실기기 재측정 전 판단 금지 |
| 5 | Wayland: wry child webview X11 전용 | High→Low | D2가 Linux에서 wry child 사용 자체를 제거; 스파이크에서 CEF Wayland/Ozone 확인; XWayland는 최후 폴백 |
| 6 | CEF Win/Linux 표면 작업 미실증(HWND 펌프, X11 reparenting, helper 프로세스군, 엔진 페이로드 서명) | High | §9 스파이크로 타임박스; 서명/노터라이즈를 같은 마일스톤에서 해소 |
| 7 | `ipc.rs`/CLI Windows 미컴파일(`std::os::unix` 하드 임포트) | Med | named pipe 또는 AF_UNIX-on-Windows를 기존 소켓 추상화 뒤에; .app 번들 가정 경로 탐색 수정 |
| 8 | 미디어 프록시 TLS 지문 취약(wreq rc 핀; native-tls JA3는 macOS만 검증) | Med | wreq(전 OS 동일 Chrome 지문 위조)를 기본 경로로 승격; 플랫폼별 CDN-403 canary 테스트 |
| 9 | Windows 배포 마찰(HSM 서명, SmartScreen, WebView2 부트스트랩) | Low-Med | Azure Key Vault 서명(공식 Tauri 경로); evergreen 부트스트래퍼 |
| 10 | Electrobun 전략적 추격(Rust-main + child-webview 레이어링을 동시에 답하는 유일한 타 후보) | 정보 | §10 재평가; transport 추상화(§7-1)가 이탈 비용을 상한 |

## 9. 스파이크 계획 (타임박스)

- **S1 — Windows 먼저**: Tauri 창 안에 빈 CEF 패널(HWND parenting, Win32 메시지 펌프, `CefDoMessageLoopWork`). HWND 방식은 macOS NSView 경로보다 쉬운 케이스다.
- **S2 — Linux**: X11 reparenting 동일 실험 + CEF Wayland/Ozone 상태 확인 + webkitgtk 메인 웹뷰 실기기 측정(리스크 4 판단 데이터).
- **S3 — 플랜 B 견적(1일)**: 풀-윈도우 CEF + WebSocket invoke 프로토타입. §7 발동 여부와 무관하게 견적을 확보해 둔다.
- 부수 트랙: 리스크 7(ipc.rs Windows), 엔진 페이로드 서명.

## 10. 관찰 항목과 재평가 트리거

- **Electrobun**: Rust main-process가 태그 릴리스에 도달하고 안정화되면 재평가(기준: 2분기 후). 그 전에는 후보가 아니다.
- **Tauri v3**: 1st-party CEF/Servo 런타임 프리뷰 출시 시 D2 사이드카와의 수렴 검토. `add_child` 제거 신호가 나오면 즉시 재평가.
- **servo crate**: LTS 라인 성숙도만 릴리스 노트 수준으로 추적. Verso 계보는 추적하지 않는다(사망 확인).
- **업스트림 WKWebView 릭 픽스** 병합 → D4 canary 발동, 포크 해체 검토.

## 참고

- 관련 문서: [ARCHITECTURE.md](ARCHITECTURE.md) (A13 엔진 중립·A14 사이드카), [SIDECARS.md](SIDECARS.md), [PERFORMANCE.md](PERFORMANCE.md), [webview-leak-fix.md](webview-leak-fix.md)
- 근거 1차 소스(조사 시점 검증): tauri 2.11.5 릴리스·docs.rs unstable 게이트 표기, wailsapp/wails 릴리스 API(alpha2.116), webui-dev/webui 릴리스 API(스테이블 0회), blackboardsh/electrobun main 커밋(2026-07-04 "rust main process")·npm dist-tags, versotile-org/verso 아카이브 배너(2025-10-08), servo.org 블로그(0.1.0, 2026-04-13), Elanis/web-to-desktop-framework-comparison(2026-07-05 재생성)
