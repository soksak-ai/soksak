# CommandBar → soksak v1 마이그레이션 — 불변 기준(헌법)

이 문서는 마이그레이션의 **모든 산출물**이 충족해야 할 불변 기준이다. 대상:
플러그인 `soksak-plugin-runbook`·`soksak-plugin-clipboard`, 코어 capability `clipboard`·`secrets`.
모든 구현 워크플로/에이전트는 이 문서를 합격 기준으로 따른다.

## R0. 기준의 지위 (절대)

- 테스트가 이 기준에 미달이면 **코드를 고친다. 기준을 낮추지 않는다** — 기준 약화는 배신이다.
- 기준 자체가 틀렸다고 판단되면 낮추지 말고 **열린 질문으로 제기해 정정**한다(정당한 약화만 허용).
- **꼼수 금지.** 문제를 문제로(band-aid) 덮지 않는다 — 근본 구조로 해결한다.
- 빠름을 좇지 않는다. 제대로 된 것을 만든다. 기초가 탄탄해야 코드가 롱런한다.
- 확정·명확한 것에 쓸데없는 선택지를 주지 않는다. 이미 결정된 것을 다시 묻지 않는다.

## R1. 데이터 — `app.data`만

- 영속화는 `app.data`로만 한다. raw SQL·쿼리문·테이블명·컬럼명을 플러그인/프론트 코드에 두지 않는다.
- `SELECT *`·컬럼 인덱스 의존 금지(CommandBar 레거시 안티패턴). 레코드는 JSON 문서, 필드는 이름으로만.
- enum·식별자 raw value는 영문 안정키로 둔다. 한국어/표시 문자열은 i18n 레이어로 분리한다.
- 계약 상세: `docs/DB-메뉴얼.md`(define/put/query/search/watch, where 연산자, ns·scope 격리).

## R2. 시크릿 — 단일 암호화 볼트

- 단일 암호화 볼트가 단일 진실이다. OS 키체인에 시크릿을 개별 저장하지 않는다(이식 불가·플랫폼 락인).
- **자체 crypto 발명 금지.** 검증된 crate만(Argon2id KDF, XChaCha20-Poly1305 AEAD, OsRng, zeroize).
- 항목별 DEK를 KEK로 wrap(envelope). KEK는 메모리에만 — lock 시 zeroize. 디스크엔 암호문·salt·verifier만.
- **`get` 없음**(평문 readback 차단). 시크릿은 `secretRef` 핸들로만 흐르고, 평문 주입은 Rust 경계
  (process spawn env/args·network 헤더)에서만 일어난다 — 평문이 JS로 넘어오지 않는다.
- 평문은 로그·히스토리·`app.data` 백업·이벤트 브로드캐스트·export 메타에 **절대** 등장하지 않는다.
- ns=pluginId 격리(다른 플러그인 시크릿 접근 불가). 백업/이전은 명시적 암호화 `.soksec` 번들로만.

## R3. 폴링 — 정공법이 없을 때만, 단일 지점에

- 동기화·통지는 이벤트 구독이 정공법이다. 폴링은 정공법이 없을 때의 최후 수단이며, 메인 경로로 새지 않는다.
- 불가피한 폴링은 코어의 **최저 단일 지점**에 격리하고, 위로는 이벤트 계약만 노출한다.
- clipboard 변경: Win=`WM_CLIPBOARDUPDATE`/X11=`XFixes`/Wayland=`wl-data-control`는 네이티브 이벤트(폴링 0),
  macOS만 `changeCount` 폴링. 코어가 흡수해 단일 `clipboard-change` 이벤트로 노출 — 플러그인은 OS 분기를 보지 않는다.

## R4. 링킹 — 순수 해석 + 순환 검출

- 토큰 해석(parse)과 실행(execute)을 분리한다. parse는 순수함수(입력→해석 계획), 실행은 별도다.
- 참조 의존 그래프 + 위상정렬 + **순환 검출**(레거시의 무한재귀를 제거한다).
- 실패를 명시 전파한다 — 미치환 토큰이 셸·HTTP로 새지 않게 한다.
- 파라미터 파싱·JSONPath 추출·이스케이프는 각각 **단일 유틸**로(레거시의 중복 구현을 제거한다).

## R5. 멀티플랫폼 — 기준선

- 코어 capability는 멀티플랫폼이 기준선이다. OS 종속 메커니즘(Keychain·NSPasteboard 등)은 그 플랫폼의
  구현 arm일 뿐 토대가 아니다. 토대는 전 플랫폼 동일 동작(순수 Rust)이어야 한다.

## R6. 코어 노출 — registry 우선, 격리 필요 시 전용 표면

- 코어 새 기능은 raw Tauri `invoke`가 아닌 **command registry**로 노출한다(명시 params + danger 게이트
  + CLI/MCP 자동 노출). 저수준 invoke는 그 handler 내부 실행기로만 둔다.
- 단 **ns 격리가 필요한 풍부 capability(`data`·`secrets`)는 전용 표면 + 전용 권한**으로 둔다 — command
  명령은 호출 pluginId를 모르므로 격리 불가. 표면은 api.ts가 ns=manifest.id를 주입한다.
- **코어 락인 금지.** 특정 플러그인 전용 결합을 코어에 두지 않는다 — 어떤 플러그인도 쓰는 범용 capability만.

## R7. UI·E2E — 명시 노출 + 헤드리스 자가검증

- 플러그인 UI는 `contributes.nodes`로 노드 종류를 선언하고 `data-node`로 인스턴스를 부여한다 →
  소켓 E2E가 `ui.tree`/`ui.measure`/`ui.input.click`(구조적 주소, `src/commands/address.ts`)로 구동·단언한다.
  노출 안 한 요소는 `NOT_EXPOSED`(테스트 불가). 처음부터 노출형으로 짠다.
- **모든 기능을 커맨드로 노출**한다(UI 없이 E2E 전부 가능). RED→GREEN: 실패를 먼저 재현(RED) → 구현 →
  검증(GREEN). 적대적 검증으로 확증한다("seems right"는 근거가 아니다).

## R8. 구조·git

- 각 플러그인 = **독립 git repo**(새 폴더 + `git init`). 이정표마다 커밋. **AI 푸터/Co-Authored-By 금지.**
- 교차 파생 로직(label·식별자·색상맵 등)은 한 유틸에 두고 멱등 재사용한다 — inline 재정의·중복 금지.
- 작업 전 feature 브랜치를 먼저 분리한다. Rust 편집 워크플로 중에는 `make dev`(live-watch)를 띄우지 않는다
  (중간 편집을 핫리빌드하다 transient 실패). 코어 cargo 작업은 dev 정지 후, 끝나면 재시작.

## R9. 완료 정의 (DoD)

- `make verify`(typecheck + cargo check + cargo test + vitest) GREEN.
- 각 플러그인 소켓 E2E 멱등 시나리오 통과(setup→단언→teardown, 합성 scope 격리).
- 레지스트리 카탈로그 등재. 각 플러그인 README. 적대적 검증 PASS.
