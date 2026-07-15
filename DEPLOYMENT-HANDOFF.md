# soksak V1 배포·확장 플랫폼 핸드오프 (2026-07-15)

이 문서는 2026-07-15 시점의 상태와 다음 게이트를 고정한 체크포인트다. 계약·구현·문서·테스트의
정본은 각 소유 저장소에 있다. 다음 작업자는 이 문서의 산문보다 각 저장소의 `git status`, 커밋,
소유 문서와 테스트 결과를 우선 확인하고 완료/미완료 경계를 유지한다.

## 1. 확정 원칙

- 코어는 비공개 제품이다. 공개 구현을 요구하지 않으며 공개 인터페이스만 소비한다.
- `soksak-spec`은 코어가 모든 확장에 강제하는 플랫폼 경계만 소유한다.
- 플러그인과 사이드카는 자기 고유 계약·구현·문서·테스트·릴리스의 최종 책임을 각 저장소가 가진다.
- 실제로 여러 독립 구현이 같은 도메인 계약을 공유할 때만 `soksak-contract-*`를 만든다.
- registry는 정본을 가리키는 서명된 설치 색인과 검증 결과다. 코드나 계약의 소유자가 아니다.
- 한곳에 모이는 정보는 설치와 검증을 편하게 하기 위한 것이며 구현 덩어리를 만드는 근거가 아니다.
- 공식 registry와 제3자가 만든 사설 registry는 같은 공개 형식과 검증 경로를 사용해야 한다.
- 배포는 GitHub Release 자산으로 한다. 현재 first-party 알파를 npm/crates.io에 발행하지 않는다.
- JS package는 `private: true`, Rust package는 `publish = false`다. package manager는 빌드 도구일 뿐
  배포 registry가 아니다.
- V1 후보의 목표 baseline은 `0.0.1`이고, 이 문서에 열거한 로컬 후보의 manifest/lock/fixture는
  `0.0.1`이다. 조직·원격 전체 rebaseline은 완료되지 않았다. 릴리스 엔진은 version/tag/asset 이름을
  소유 metadata에서 유도하며 `0.0.1`로 분기하지 않는다.
- `soksak-spec-…@0.0.1` 같은 값은 계약 문법 버전일 수 있다. 제품 버전 하드코딩과 구별한다.
- tag push가 검증의 시작점이어서는 안 된다. `main`의 exact checkout에서 전체 검증과 결정적 자산
  생성을 끝낸 workflow가 마지막에 tag/draft/assets/immutable publication을 수행한다.
- GitHub publication은 owner-enforced immutable releases를 확인한 뒤 시작한다. CI는 설치형 GitHub
  App의 단기 토큰만 사용하며 Administration(read) + Contents(write)를 명시한다.
- symlink 금지. archive도 regular file만 허용한다. 상대경로/cwd 추측 금지. 경로는 선언하거나
  발견 가능한 규칙으로 해석한다.
- polling은 최후 수단이다. 이벤트, watcher, callback, 프로세스 종료 신호를 먼저 사용한다.
- 코어·플러그인·사이드카·플러그인 간 연결은 공개 command/state/event/contract로만 한다.
- iframe은 차단 대상이 아니라 confidentiality/integrity 격리 도구다. remote navigation, WebRTC,
  WebTransport처럼 opaque frame 밖으로 capability를 확장하는 동작만 명시 정책과 동의가 필요하다.
- 모든 결함과 기능은 같은 기준의 RED→GREEN으로 증명한다. UI는 실제 실행과 screenshot까지 본다.

## 2. 개발 identity

세 identity 모두 플러그인 개발을 허용해야 한다.

| identity | CLI | home | 앱 본체 | 확장 기본 소스 |
|---|---|---|---|---|
| release | `sok` | `~/.soksak` | 공식/릴리스 | 공식 registry, 명시적 dev source도 가능 |
| dev | `sok-dev` | `~/.soksak-dev` | 로컬 dev | 로컬 workspace 또는 원격 설치 |
| debug | `sok-debug` | `~/.soksak-debug` | 로컬 debug | 공식 설치, 명시적 dev source도 가능 |

`plugin.dev.create`와 `plugin.dev.load`의 command-level 경계는 세 CLI에 구현되어 있다. 세 identity의
전체 runtime/UI E2E는 아직 완료되지 않았다. `-dev`/`-debug` 앱 빌드는 로컬에만 존재하고 release 앱만
원격 배포한다. 각 identity의 config, 설치, data, sockets, workspace는 서로 섞이지 않아야 한다.

## 3. 목표 저장소 경계

```text
soksak-spec
└─ 공통 handshake, manifest/release/registry/conformance 문법, Rust wire, validator

soksak-plugin-sdk
└─ 공개 author API와 공식 scaffold/conformance fixture

soksak-plugin-*
└─ 플러그인 고유 계약·구현·문서·테스트·GitHub Release

soksak-sidecar-*
└─ 사이드카 고유 interface·구현·문서·테스트·멀티플랫폼 GitHub Release

soksak-contract-*
└─ 여러 독립 구현이 실제 공유하는 도메인 계약과 fixture

soksak-app
└─ private core가 만든 서명 앱/updater 자산의 공개 배포 저장소
```

새 플러그인 작성자는 `soksak-spec`을 수정하지 않는다. 기존 플랫폼 capability만 사용하면
`plugin.dev.create` → 자기 저장소 구현/계약 → validator/conformance → registry 등록 순서로 끝난다.
새로운 공통 플랫폼 capability가 정말 필요할 때만 별도 spec 제안이 생긴다.

## 4. 저장소 체크포인트

### 4.1 공개 플랫폼 spec

- 경로: `/Users/max/ai/cli/soksak-spec`
- branch: `feat/0.0.1-platform-spec`
- HEAD: `97af8080c4a9ad22121f6d43fd2ee563a6ff2ad1`
- 상태: clean, 원격 미반영, 로컬 git remote 미설정
- 커밋:
  - `d7f5485 feat: establish 0.0.1 public platform specification`
  - `97af808 feat: bind SDK releases to exact platform dependencies`
- 검증: Node root 3, Vitest 147, Rust 41, 결정적 release GREEN
- 자산:
  - `artifacts/soksak-ai-plugin-spec-0.0.1.tgz`
  - SHA-256 `25a97c965e8fd83d3f7778e4eea5152ddb79d91311c4d0df18786c1e343274e8`
  - `artifacts/soksak-spec-release.json`
  - SHA-256 `d37c5a8ae86780cb266bd00ef312d2ebd89b71877ad2fbb5000a8eac4accb8ab`
- no-symlink pnpm 설치: `nodeLinker: hoisted`, `preferSymlinkedExecutables: false`.
- 미완료: `scripts/release-verify.mjs`가 제품 `0.0.1`과 archive 이름을 고정하고, release workflow가
  tag-trigger + built-in `GITHUB_TOKEN`을 사용한다. SDK와 같은 metadata-driven/App-token publisher로
  RED→GREEN 교정하기 전에는 local main merge/현재 릴리스 발행 금지.

### 4.2 공개 plugin SDK — 로컬 구현 체크포인트

- 경로: `/Users/max/ai/cli/soksak-plugin-sdk`
- branch: `main`
- HEAD: `4ba804e84dc80500bd64949b6c7d226188b7f7f2`
- 보존 branch: `merged/feat/0.0.1-baseline` (같은 SHA)
- 상태: clean, 공개 원격은 empty, push 안 함
- 검증: Node 21/21, Vitest 4/4, authoritative plugin validator, deterministic pack, symlink 0
- 자산:
  - `artifacts/soksak-ai-plugin-api-0.0.1.tgz`
  - SHA-256 `8de27ac4e1c4ede316b91f27b5617f7423a4e492c8b2f7e3c05a1862a1e4c189`
  - `artifacts/soksak-plugin-sdk-release.json`
  - SHA-256 `3c4d3fec52d9ef12003d002b96e1eca20d57b696944c17e9f999737046d2c0ee`
- spec 의존은 versioned GitHub Release manifest URL + SHA-256 + source 40-SHA로 닫는다.
- `0.7.4` spec, `0.9.3` SDK synthetic fixture가 같은 엔진을 통과한다. 두 버전은 독립이다.
- publisher는 local asset 전수검증 → owner immutable 확인 → exact tag → resumable draft → missing exact
  asset만 업로드 → publish → immutable/tag/assets 재검증 순서다. 삭제/교체 reconciliation은 없다.
- SDK tarball은 `examples/soksak-plugin-reminder-demo`의 source, standalone JS, manifest를 포함한다.
- release CI는 `workflow_dispatch`, exact main checkout, App token v3 pin, Administration(read),
  Contents(write), `SOKSAK_RELEASE_TOKEN`만 사용한다.
- 실제 GitHub workflow/publication은 아직 실행하지 않았다. clean checkout의 기본
  `scripts/prepare-spec.mjs`는 아직 존재하지 않는 원격 `soksak-spec-v0.0.1` manifest/artifact를
  가져오므로 현재는 로컬 spec 자산을 절대경로로 명시해야 한다.
- 원격 SDK repo는 owner-enforced immutable이 꺼져 있고 repo-level Actions variable/secret도 비어 있다.
  이 상태에서 publisher는 의도대로 fail-closed한다.

### 4.3 독립 unit 초기 체크포인트

| 경로 | branch / HEAD | 검증 | 현재 경계 |
|---|---|---|---|
| `/Users/max/ai/cli/soksak-plugin-agents-hooks` | `feat/0.0.1-baseline` / `680ed4e7fc7e3a1833ae4ad2a46e4df4f80a0bda` | 기능 51/type/build/validator/conformance GREEN; 전체 no-symlink RED | git clean; `node_modules/.bin` symlink 8개; publication 교체 필요 |
| `/Users/max/ai/cli/soksak-plugin-browser-dom-picker` | `feat/0.0.1-baseline` / `c260b9210545920122d0dbbb0d1848c5bde5d5ad` | 16 tests + validator/conformance GREEN | clean; symlink 0; publication 교체 필요 |
| `/Users/max/ai/cli/soksak-contract-narration` | `feat/0.0.1-baseline` / `4df10cf3c9c00192267d695549e559c17309185d` | `bash scripts/gate.sh` 14/14, deterministic artifact GREEN | clean; symlink 0; publication 교체 필요 |
| `/Users/max/ai/cli/soksak-sidecar-speech-sherpa` | `feat/0.0.1-baseline` / `8a9cd479ecfc9eaedbf339463d111dfe4f0031d5` | 기능/release gate: Rust 3 + Node 46 GREEN; 전체 no-symlink 기준 RED | tracked clean; ignored `target`에 dylib symlink 3개; push/merge 안 함 |
| `/Users/max/ai/cli/soksak-sidecar-workflow` | `feat/0.0.1-baseline` / `141bb06b8473a62fdc6cca969750223135c41eb0` | local-spec mirror gate: Rust 183 + Node 12 GREEN | clean; symlink 0; 원격 없음; push/merge 안 함 |

위 clean 세 저장소는 version-generalization뿐 아니라 exact-main context, owner immutable preflight,
App token, resumable fail-closed publication을 포함한 전체 경계를 교체하기 전에는 최초 main 후보로
확정하거나 publish하지 않는다.

workflow sidecar는 `ca1b91ca1b63800ac1715fa88cfceb2621f5b7da`와
`141bb06b8473a62fdc6cca969750223135c41eb0` 두 기능 커밋으로 runtime/release 경계를 분리했다.
declared absolute store + OS lock fail-fast로 cwd 추측, kill, 100회 polling takeover를 제거했고,
metadata만 바꾼 `0.0.2` fixture도 같은 release engine을 통과했다. 로컬에는 이전 `main` `7f3731d`가
있지만 신규 저장소의 parentless 후보 transaction 전에는 merge하지 않는다. 원격 workflow는 spec
source `d7f54852754195527f125d1fc11362316157d19b`와 sidecar repo가 GitHub에 없어 각각 404로 막힌다.

speech sidecar는 `8a9cd479ecfc9eaedbf339463d111dfe4f0031d5`에서 결정적 5-target release,
fresh-process handshake, immutable/resumable publisher, manifest-driven next-version 경로를 닫았다.
라이선스 closure는 Cargo package 178개(registry package 177개 포함), native component 2개,
원문 354개다. upstream `ort rc.12`의
`load-dynamic+api-17`이 Vitis API18 symbol을 참조해 fresh build가 실패한 RED는 공식
`alternative-backend` 경계에서 executable-adjacent regular ONNX Runtime 1.17.1/API17을 검증·설정하고
library lifetime을 소유해 GREEN으로 만들었다. 그러나 gate가 ignored Cargo `target`에 build output
`libonnxruntime.dylib` symlink 3개를 생성한다. tracked/release/archive에 없다는 이유로 §1의 절대
no-symlink 기준을 축소하지 않는다. 생성 원인을 제거하고 같은 full gate 뒤 `find . -type l` 0을
증명하기 전 speech checkpoint는 전체 완료가 아니다. 이전 local `main` `82c685d`는 merge하지 않았다.

### 4.4 private core WIP — 완료 아님

- 경로: `/Users/max/ai/cli/vsterm-tauri`
- branch: `feat/v1-extension-platform`
- handoff 문서 커밋 직전 마지막 구현 커밋: `5f21043ca825c7bd516cc81ab3802e091de50642`
- 상태: 대규모 dirty WIP. 관련/비관련 파일이 섞여 있으므로 `git add .` 금지.
- ignored `node_modules`를 포함한 현재 repository tree에 symlink 1,287개가 있어 전체 no-symlink 기준 RED다.
- 이미 기능 커밋된 경계:
  - `5c21a2f` identity-local unit sources
  - `8485d61` 모든 identity의 plugin workspace 개발
  - `dbfa408` clean checkout contract bootstrap
  - `e054dee` unsafe sidecar archive 거부
  - `5f21043` native webview navigation policy
- dirty tree에는 public Command Registry, native plugin runtime, registry installer, unit installer,
  spec extraction, 문서 변경이 포함된다. 전체 RED/GREEN과 runtime/UI 검증이 끝나지 않았다.
- `docs/ARCHITECTURE*.md`, `docs/PLUGINS.md` 일부는 아직 release/debug 개발을 제한하거나 옛 명령을
  설명한다. 현재 정책으로 정리하기 전 정본으로 인용하지 않는다.
- `.claude/**`, `.agents/**`, `.claude/worktrees/**`, 루트 `:-`는 무차별 stage 금지.

### 4.5 version/inventory 도구

- 경로: `/Users/max/ai/cli/soksak-version-fix`
- branch: `feat/0.0.1-safe-rebaseline`
- HEAD: `063696443e49f3c47a9bacdfda57e4bbab153a75`
- 상태: git clean. 도구 unit test 45/45 GREEN이나 ignored `node_modules` symlink 108개 때문에 전체
  no-symlink 기준 RED다. 원격 mutation 0. live 정책 gate도 아래 4건 때문에 RED다.
- 조직 70개 전체 목록 정본:
  `/Users/max/ai/cli/soksak-version-fix/inventory/repositories.json`
- snapshot: `observedAt=2026-07-14T08:06:56Z`, 70개/고유 이름 70개, SHA-256
  `c08e18c30f556f69900ae459fdb13e1a49499d99601f47e70cef93cb7e93df27`. 2026-07-15 live도 70개다.
- 현재 `--live --enforce-policy` blocker:
  - `REQUIRED_REPOSITORY_EMPTY soksak-app`
  - `REQUIRED_REPOSITORY_EMPTY soksak-plugin-sdk`
  - `ACTIVE_DISTRIBUTION_NOT_PUBLIC soksak-plugin-remote-iroh (private)`
  - `ACTIVE_DISTRIBUTION_NOT_PUBLIC tauri-plugin-webview-capture (private)`
- 목표는 기존 70 + 신규 5 = 75다. 신규 5:
  - `soksak-contract-narration`
  - `soksak-plugin-agents-hooks`
  - `soksak-plugin-browser-dom-picker`
  - `soksak-sidecar-speech-sherpa`
  - `soksak-sidecar-workflow`
- `soksak-app`과 `soksak-plugin-sdk`는 이미 존재하는 공개 empty repo라 신규 5가 아니다.
- `soksak-kit-terminal-common`은 삭제된 파일을 export하던 빈/stale 소비 의존이므로 제거 대상이며
  저장소를 만들지 않는다. `soksak-kit-terminal-conformance`는 폐기된 engine-as-judge 모델이고
  `soksak-contract-terminal`과 충돌하므로 만들지 않는다. 소유 근거는
  `/Users/max/ai/cli/soksak-version-fix/docs/REPOSITORY-INVENTORY.md`다.
- rebaseline은 backup mirror, exact leases, release attestation, fresh clone verification, rollback을
  모두 닫기 전 실행하지 않는다. 현재 원격 force-push/delete는 수행하지 않았다.

### 4.6 app 배포 저장소

- 경로: `/Users/max/ai/cli/soksak-app`
- branch: `feat/0.0.1-baseline`
- 공개 원격: 존재하지만 empty
- 상태: 아직 파일/커밋 없음. 다음 컨텍스트로 핸드오프.

## 5. 2026-07-15 원격 사실

- `soksak-ai/soksak-spec`: public, non-empty, remote `main`
  `bec5bffda177cdd5c35d97229c87299bd11fa75c`.
- 원격에는 옛 `plugin-spec-v0.3.0` release만 있다. assets는
  `release-manifest.json`, `soksak-ai-plugin-spec-0.3.0.tgz`; 현재 release object는 immutable false다.
- 저장소 immutable setting은 `enabled=true`, `enforced_by_owner=true`다.
- 로컬 0.0.1 spec SHA `97af808…`와 원격은 다르다. 안전 rebaseline 전 push 금지.
- `soksak-ai/soksak-app`, `soksak-ai/soksak-plugin-sdk`: public empty.
- `soksak-app`과 `soksak-plugin-sdk`의 immutable setting은 둘 다
  `enabled=false`, `enforced_by_owner=false`다.
- 두 empty repo의 repo-level Actions variables/secrets는 비어 있다. 조직 수준 상속 여부는 현재 토큰의
  권한 부족(403)으로 미검증이다.
- 신규 5 저장소는 GitHub에 아직 없다.
- feature branch는 어느 원격에도 push하지 않는다. 공개할 때는 검증된 local main만 대상이다.
- npm 레거시 발행물 `@soksak-ai/plugin-spec@0.3.0`, `@soksak-ai/plugin-api@0.2.1`은 그대로
  존재한다. 새 npm 발행 금지와 기존 package deprecate/unpublish 미완료를 구별한다.
- `cargo search soksak --limit 100` 결과는 0건이다.

## 6. 확인된 publication boundary 후속

다음 production 파일은 현재 manifest/fixture 값이 아니라 릴리스 동작을 제품 `0.0.1` 또는 옛
tag-push/기본 토큰 publication에 고정하므로 교정 대상이다.

- `/Users/max/ai/cli/soksak-spec/scripts/release-verify.mjs`
- `/Users/max/ai/cli/soksak-spec/.github/workflows/release.yml`
- `/Users/max/ai/cli/soksak-plugin-agents-hooks/scripts/build-release.mjs`
- `/Users/max/ai/cli/soksak-plugin-agents-hooks/.github/workflows/release.yml`
- `/Users/max/ai/cli/soksak-plugin-browser-dom-picker/scripts/build-release.mjs`
- `/Users/max/ai/cli/soksak-plugin-browser-dom-picker/.github/workflows/release.yml`
- `/Users/max/ai/cli/soksak-contract-narration/scripts/build-release.mjs`
- `/Users/max/ai/cli/soksak-contract-narration/.github/workflows/release.yml`

교정 기준은 package/Cargo/owner manifest에서 id/version/repository/tag/assets를 유도하고, 다른 제품 버전
fixture가 metadata 변경만으로 같은 build→conformance→publish 경로를 통과하는 것이다. 그와 동시에
SDK와 같은 exact-main context, owner immutable preflight, App token, resumable fail-closed publisher로
교체한다. 계약 구현 코드의 exact interface version, schema id, 현재 manifest, lock, fixture는 자동
치환하지 않는다.

RED 범위에는 다음도 포함한다.

- `/Users/max/ai/cli/soksak-plugin-browser-dom-picker/test/release.test.mjs`의 fixed `v0.0.1` 정책
- agents/browser의 `README.md`, `README.ko.md`에 남은 fixed-tag 설명
- narration/spec에 없는 synthetic other-version 및 workflow/publisher 정책 테스트

## 7. 다음 실행 순서

1. no-symlink install/build 경계를 먼저 RED→GREEN으로 닫는다. 현재 core 1,287개(pnpm
   `node_modules`), version-fix 108개(pnpm `node_modules`), agents-hooks 8개(npm `.bin`), speech 3개
   (`target/**/libonnxruntime.dylib`)다. 단순 삭제, ignored 경로 제외, gate 예외 추가는 금지한다. 선언적
   no-symlink dependency layout과 regular-file native build를 만든 뒤 각 full gate 재실행 후
   repository 전체 `find . -type l` 0을 증명한다.
2. 먼저 `soksak-spec`의 §6 publication boundary를 RED→GREEN으로 교정한다.
3. 기존 공개 `soksak-spec`에 version-fix의 backup/exact lease/release evidence/fresh-clone/rollback
   transaction을 적용한다. App 접근을 확인하고 검증된 main만 반영한 뒤 owner-immutable
   `soksak-spec-v0.0.1` manifest/artifact를 발행·원격 재검증한다.
4. 기존 empty SDK repo에 owner immutable과 App 접근을 설정·검증한 뒤 단일-root local main만 push한다.
   원격 spec 의존만 사용하는 clean workflow와 SDK immutable release를 실제로 통과시킨다.
5. agents-hooks/browser-dom-picker/narration의 나머지 §6 publication boundary를 각각 RED→GREEN으로
   교정하고 기능 커밋한다. workflow/speech도 원격 spec만으로 full gate가 통과해야 한다.
6. 신규 5는 그 full gate 뒤 version-fix transaction으로 parentless `0.0.1` main 후보를 만들고
   fresh-clone attestation을 통과시킨다. 기존 로컬 조상 이력을 일반 merge하여 최초 공개 이력에
   포함하지 않는다. SDK의 단일 root commit은 이미 이 형태다.
7. parentless 후보/fresh-clone 증거 뒤 신규 5 empty public GitHub repo를 만든다. 각 repo에 owner
   immutable과 GitHub App 접근을 즉시 설정·검증한 뒤에만 parentless main을 push한다. 설정 검증 실패 시
   push/publish하지 않는다. repo 생성은 이미 승인됐으며 재질문 대상이 아니다.
8. 원격 생성·push 직후 live 집합을 재관측해 exhaustive inventory를 70→75로 갱신하고 신규 5의
   visibility/non-empty/default branch와 원격 workflow를 검증한다.
9. inventory drift를 닫은 다음 각 신규 repo의 실제 clean `workflow_dispatch`로 immutable release를
   발행하고 tag/source 40-SHA/asset digest/다운로드 conformance까지 재검증한다. CI GREEN만으로 배포
   완료라 하지 않는다.
10. 75개 전체 inventory를 기준으로 모든 active distribution의 version/dependency/conformance/publication
   경계를 전수 감사하고 저장소별 선언적 policy를 만든다. §6 네 저장소는 첫 적용 집합일 뿐 전체가 아니다.
11. `soksak-plugin-remote-iroh`와 `tauri-plugin-webview-capture`는 source/license/secret/release 경계를
    먼저 검증·교정한 뒤 public으로 전환한다. 단순 visibility 변경으로 정책 RED를 숨기지 않는다.
12. spec을 첫 적용 사례로 삼아 전체 first-party 저장소의 manifest/lock/history를 `0.0.1`로 안전하게
    재기준화한다. 저장소별 RED→GREEN 후보, bundle, exact lease, release evidence, fresh clone, rollback을
    갖추며 외부 의존 버전과 SemVer fixture는 일괄 치환하지 않는다.
13. `soksak-app`의 private-core→public-app exact manifest/updater/App-token publisher를 만들고 empty 정책
    blocker를 닫는다.
14. GitHub Release 기반 clean checkout/install을 증명한 뒤 first-party npm publish/install/npx 소비 경로를
   전수 제거한다. 기존 `@soksak-ai/plugin-spec@0.3.0`, `@soksak-ai/plugin-api@0.2.1`은 npm 정책과
   소유권에 따라 deprecate하고 가능한 공식 삭제 절차를 수행한 뒤 registry/docs/install 재검증을 남긴다.
15. inventory snapshot과 GitHub live 집합 75개가 일치하고 `--live --enforce-policy`가 GREEN인지 확인한다.
16. 코어에서 SDK release fixture를 `plugin.dev.create`의 정식 원본으로 연결한다. 세 identity 모두 같은
   공개 명령을 쓰고, 절대 workspace/source 선언을 반환해야 한다.
17. official/private registry, dependency closure(plugin/sidecar/kit), signature/SHA/install transaction을
   코어 공개 interface로 닫는다. 설치 실패 시 반쪽 상태를 남기지 않는다.
18. core 전체 tests, doctor/conformance, 세 identity 실제 설치/개발, `sok-dev` runtime, screenshot을 확인한다.
19. 이력 유지 대상은 기능 단위 커밋 → local main merge → `merged/…` rename한다. 미검증 WIP는
    `backup/…`로 보존한다.

## 8. 닫히지 않은 기술·외부 상태

- 신규 5 repo 생성은 승인·관리자 권한 대기가 아니라 §7의 parentless 후보 증거 뒤 수행할 pending
  external mutation이다. 현재 계정 `yejune`은 조직 active admin으로 확인됐다.
- release GitHub App의 다음 권한과 repo 접근을 실제 Actions에서 증명해야 한다.
  - repository Administration: read
  - repository Contents: write
  - Actions variable `SOKSAK_RELEASE_CLIENT_ID`
  - Actions secret `SOKSAK_RELEASE_PRIVATE_KEY`
- SDK/app repo-level variable/secret은 현재 없고 조직 수준 상속은 조회 권한 부족으로 미검증이다.
- owner immutable은 spec만 enforced다. SDK/app와 신규 5 모두 `enforced_by_owner=true`가 되기 전 publish 금지.
- no-symlink blocker는 core 1,287개, version-fix 108개, agents-hooks 8개, speech 3개다. 모두
  ignored dependency/build output이지만 예외가 아니며 생성 원인이 미해결이다.
- npm package maintenance 인증은 닫히지 않았다. 이전 authenticated 요청은 E401이었고 기존 두 package의
  deprecate/공식 삭제는 아직 실행하지 않았다.
- spec 옛 이력/release 재기준화는 승인 대기가 아니라 backup/lease/attestation/fresh-clone/rollback
  기술 증거 미완료 상태다.
- macOS codesign/notarization/updater signing credential은 app release 단계의 별도 gate다.

## 9. 재현 명령

아래는 GREEN과 현재 RED를 함께 재관측한다. agents-hooks의 종전 `npm ci`/`npm run` gate와 version-fix의
종전 `pnpm install`/`pnpm test` gate는 각각 symlink 8개/108개를 생성·사용하므로 올바른 완료 명령이
아니다. §7.1에서 no-symlink 설치 경계를 만든 뒤 이 절에 새 정식 gate를 기록한다.

```sh
git -C /Users/max/ai/cli/soksak-plugin-sdk status --short --branch
git -C /Users/max/ai/cli/soksak-plugin-sdk rev-parse HEAD
cd /Users/max/ai/cli/soksak-plugin-sdk
pnpm install --frozen-lockfile
node scripts/prepare-spec.mjs \
  --manifest /Users/max/ai/cli/soksak-spec/artifacts/soksak-spec-release.json \
  --artifact /Users/max/ai/cli/soksak-spec/artifacts/soksak-ai-plugin-spec-0.0.1.tgz
pnpm test

git -C /Users/max/ai/cli/soksak-spec status --short --branch
cd /Users/max/ai/cli/soksak-spec
pnpm install --frozen-lockfile
pnpm test

cd /Users/max/ai/cli/soksak-plugin-agents-hooks
# 현재 의도된 RED: node_modules/.bin symlink 8개가 출력된다.
find . -type l -print
# 종전 기능 증거: npm ci --ignore-scripts; npm run typecheck; npm run build; npm test
# 위 종전 gate는 no-symlink 교정 전 다시 완료 gate로 사용하지 않는다.
node scripts/build-release.mjs \
  --commit 680ed4e7fc7e3a1833ae4ad2a46e4df4f80a0bda --out dist
node /Users/max/ai/cli/soksak-spec/packages/plugin-spec/bin/validate.mjs plugin plugin.json
node /Users/max/ai/cli/soksak-spec/packages/plugin-spec/bin/validate.mjs release dist/release.json
node /Users/max/ai/cli/soksak-spec/packages/plugin-spec/bin/validate.mjs conformance \
  dist/conformance-release.json dist/conformance-plugin.json dist/conformance-agents-hooks.json \
  --release dist/release.json --plugin-manifest plugin.json
git diff --exit-code

cd /Users/max/ai/cli/soksak-plugin-browser-dom-picker
npm ci --ignore-scripts
npm test
node scripts/build-release.mjs \
  --commit c260b9210545920122d0dbbb0d1848c5bde5d5ad --out dist
node /Users/max/ai/cli/soksak-spec/packages/plugin-spec/bin/validate.mjs plugin plugin.json
node /Users/max/ai/cli/soksak-spec/packages/plugin-spec/bin/validate.mjs release dist/release.json
node /Users/max/ai/cli/soksak-spec/packages/plugin-spec/bin/validate.mjs conformance \
  dist/conformance-release.json dist/conformance-plugin.json \
  --release dist/release.json --plugin-manifest plugin.json
git diff --exit-code

cd /Users/max/ai/cli/soksak-contract-narration
bash scripts/gate.sh

git -C /Users/max/ai/cli/soksak-sidecar-speech-sherpa status --short --branch
cd /Users/max/ai/cli/soksak-sidecar-speech-sherpa
npx --yes node@22.12.0 scripts/gate.mjs
# 현재 의도된 RED: target의 libonnxruntime.dylib symlink 3개가 출력된다.
find . -type l -print

git -C /Users/max/ai/cli/soksak-sidecar-workflow status --short --branch
cd /Users/max/ai/cli/soksak-sidecar-workflow
SOKSAK_SPEC_GIT_MIRROR=/Users/max/ai/cli/soksak-spec \
  npx --yes node@22.12.0 scripts/gate.mjs
# mirror 없이 실행하는 공개 dependency 경로는 pinned spec SHA가 원격에 없어 현재 RED다.

cd /Users/max/ai/cli/soksak-version-fix
# 현재 의도된 RED: pnpm node_modules symlink 108개가 출력된다.
find . -type l -print
# 종전 unit 증거: pnpm install --frozen-lockfile; pnpm test (45/45)
# 위 종전 gate는 no-symlink 교정 전 다시 완료 gate로 사용하지 않는다.
node /Users/max/ai/cli/soksak-version-fix/src/repository-inventory-scan.mjs --live
# 현재 의도된 RED: §4.5의 네 blocker를 모두 출력해야 한다.
node /Users/max/ai/cli/soksak-version-fix/src/repository-inventory-scan.mjs --live --enforce-policy

git -C /Users/max/ai/cli/vsterm-tauri status --short --branch
git -C /Users/max/ai/cli/vsterm-tauri log -5 --oneline
# 현재 의도된 RED: ignored pnpm node_modules symlink 1,287개다.
find /Users/max/ai/cli/vsterm-tauri -type l -print
```

## 10. 브랜치·원격 규칙

- 작업은 기능 branch에서 하고 기능 단위로 커밋한다.
- 이력 유지 대상에서 local main에 통합한 branch는 `merged/` 접두로 rename한다.
- 개발했지만 명시적 지시로 main에 통합하지 못한 branch는 `backup/` 접두로 rename한다.
- feature/backup/merged branch는 원격에 push하지 않는다.
- 신규 5의 최초 공개 main은 일반 merge가 아니라 검증된 parentless 후보로 만든다.
- 기존 Git ref/tag/release 재기준화처럼 파괴적인 변경은 backup/exact lease/attestation/rollback이
  검증된 transaction으로만 한다.
- 신규 repo 생성은 parentless/fresh-clone 증거 뒤 수행하고 immutable/App 설정 검증 전에는 push하지 않는다.
- 새 immutable release는 local asset 전수검증 → preflight → resumable draft → final reverify 경로만
  사용한다. publish 후 삭제·교체 rollback은 금지한다.

관련 장기 메모리:
`/Users/max/.claude/projects/-Users-max-ai-cli-vsterm-tauri/memory/project_soksak-deploy-hotswap.md`
