# 테스트

모든 repo(코어·플러그인·사이드카)에 표준 타깃 둘. repo 는 `make test-unit` / `make test-e2e`
(Makefile) 또는 동명 `npm` 스크립트로 노출한다.

## 두 타깃

- **`test-unit`** — 결정적, LLM 0, 실행 중인 앱 불요. 기계가 오프라인으로 정착하는 순수 로직·
  타입 검사. 코어: `spec-gate`(plugin-spec/plugin-api 빌드 + 헤드리스 매니페스트 게이트),
  `typecheck`(tsc), `check`(cargo check), `test`(cargo test), `test-front`(vitest). 플러그인:
  그 repo 의 vitest/cargo 스위트. 커밋 전 게이트 — 매 커밋 전에 그린이어야 한다.
- **`test-e2e`** — 실행 중인 앱을 소켓으로 구동. 멱등·자기정리: 각 하니스가 자기 창·프로젝트를
  만들고 단언하고 정리한다(사용자 워크스페이스 무접촉). identity 인자를 받는다(기본
  `IDENTITY=debug`). 코어 스위트: orchestrator·project-rail·nl-console·browser-restore·
  multiwindow·resize.

## 하니스 방법론

- **멱등 시나리오 파일, 임시 스크립트 아님.** 하니스는 깨끗이 재실행된다: 진입 시 잔재를
  청소하고, 자기 픽스처 안에서만 동작하며, 만든 것을 지운다. 재사용 하니스가 소유할 일에
  일회용 스크립트를 쓰지 않는다.
- **픽스처 루트는 `~/.soksak-e2e` 하위**, 재사용·멱등 — app 홈(`~/.soksak`·`-dev`·`-debug`)과
  분리. 상태 회수는 창 라이프사이클(teardown=window.close)로, 매번 새 임시 dir 로가 아니다.
- **스킵 말고 introspect.** "테스트 못 함"이면 그 사실을 드러내는 introspection 명령(상태 조회·
  측정)을 추가한다. "메커니즘 없음"은 핑계가 아니다 — 표면을 확장한다.
- **결정적 단언과 LLM 의존 단계를 분리.** 결정적 검사는 정확한 결과를 단언하고, LLM 호출 단계
  (에이전트 턴)는 관용 재시도하며 특정 모델 출력에 게이트하지 않는다.
- **실제 신호를 측정.** 런타임 사실을 직접 읽는다(터미널 출력=`term.read`, 실 winsize=`stty size`,
  렌더=픽셀 밝기) — 정적/추론값이 아니라.

## 하니스 규칙 (실측으로 얻은)

- **하니스가 앱을 루프로 재기동하게 두지 마라.** 멈춘 상태 회복은 최대 1회, 그다음 진단과 함께
  시끄럽게 실패한다 — 재기동→부활→재스캔 루프는 회복이 아니다.
- **EOF 소켓 읽기는 예외를 던진다**, 공회전 아님: `recv` 가 빈 바이트를 영원히 돌려주면 행이므로
  EOF 를 오류로 본다.
- **응답 봉투는 rpc 헬퍼 한 곳에서 언랩.** 기계 페이로드는 `data` 에 중첩(MESSAGE-PROTOCOL);
  헬퍼에서 평탄화해 단언이 평면 필드를 읽게 한다.
- **워크스페이스 창을 명시 타게팅.** `main` 은 워크스페이스 없는 컨트롤 플레인이라, 프로젝트를
  측정하는 하니스는 자기 `w-*` 창을 열고 모든 명령을 그 창으로 라우팅한다 — 창 미지정 명령은
  컨트롤 플레인에 착지해 아무것도 측정하지 못한다.

## 플러그인·사이드카 repo

플러그인 repo 의 `test-unit` 은 자기 스위트(vitest/cargo). 빌드 단계(TypeScript `src/`)가 있는
repo 는 발행 전 빌드하고, 플러그인은 `soksak-plugin-doctor` 를 `prepublishOnly` 에 배선해 발행 전
무결성 게이트(theme/permission/naming/envelope)가 돌게 한다. 테스트 파일 0 인데 `vitest` 를
돌리는 스크립트는 거짓 그린 — 실 테스트를 넣거나 스크립트를 제거한다.

---

English guide: [TESTING.md](TESTING.md).
