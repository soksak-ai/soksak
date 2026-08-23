---
kind: translation
status: active
canonical: docs/tech/ENVIRONMENT-AND-INSTALLATION.md
---

# Environment와 설치

이 문서는 [영어 정본](./ENVIRONMENT-AND-INSTALLATION.md)의 한국어 번역입니다. 공개 JSON
형식은 `soksak-spec`이 소유하며, 이 문서는 Core 동작을 정의합니다. Release identity와
archive 검증은 `RELEASE-INTEGRITY.md`가 정의합니다.

## Environment

`<identity-home>/environment.json`은 유일한 로컬 component 상태입니다. Plugin, sidecar, kit,
contract, spec은 선택된 정확한 version, 절대 로컬 경로, source 종류, managed content의 registry
ID, 필요한 경우 target을 기록합니다. Plugin은 활성화 상태와 sidecar 역할 binding도 기록합니다.
하나의 단조 증가 `revision`이 전체 environment를 포함하며, 변경은 compare-and-swap 후 하나의
`environment.changed` event를 발행합니다. Polling은 사용하지 않습니다.

원격 repository, source commit, dependency, URL, size, digest는 registry release가 소유합니다.
Environment는 이 정보를 복제하지 않습니다. 다른 영구 component 문서나 dependency lock은 없습니다.

## Installer

Core installer는 검증된 plugin, sidecar 또는 직접 요청된 kit release를 읽고 현재 target artifact를
선택합니다. 선언된 크기만큼 내려받고 SHA-256을 검증한 뒤 regular file만 추출하고 manifest를
검증합니다. Component directory와 environment는 하나의 transaction으로 공개합니다.

Plugin 설치는 정확한 plugin dependency와 각 역할에 선택된 sidecar ID를 같은 transaction에서
설치합니다. 이미 materialize된 동일 version은 공유합니다. 실패하면 이전 environment는 변하지
않습니다. Write lock은 transaction 동안만 존재합니다.

Kit은 재사용 구현 source이며 암묵적인 plugin runtime dependency가 아닙니다. Contract와 spec
release는 validation input이고 runtime 설치 directory에 복사되지 않습니다. Release 문서는
dependency scope나 sidecar role binding을 담지 않습니다. Plugin 설치는 plugin을 자동 활성화하지
않으며 sidecar binding도 명시적 environment operation으로 commit합니다.

## Development source

Development source는 해당 ID의 versioned source와 절대 경로를 교체하고 managed update를 막습니다.
Manifest는 identity, app version, interface, permission, path 검증을 그대로 통과해야 합니다. 별도
boolean은 저장하지 않습니다.

`environment.json`만 runtime discovery에 사용합니다. Core와 component는 `../`, 주입된 repository
root, checkout layout, PATH, symlink로 다른 repository를 찾지 않습니다. Build 관계는 package
dependency, runtime 관계는 environment가 해석하는 component ID, 원격 byte는 registry release를
사용합니다.

미래 기능을 미리 구현하지는 않지만 규칙, 상태 축, 소유권 경계, command/status/event/DOM 공개면은
구현이 의존하기 전에 확정합니다. Plugin, sidecar, kit, contract, spec source 공개면은 추측성 기능이
아니라 platform 상태입니다.

## Commands

- `environment_get`: environment 조회
- `plugin_enabled_set`: plugin 활성화 변경
- `plugin_sidecar_set`: 하나의 sidecar 역할 binding 변경
- 종류별 `source_set`: component의 정확한 source와 로컬 경로 교체
- `artifact_install_begin/stage/read_utf8/commit/rollback`: atomic 설치 transaction

공개 unit, install profile, dependency closure, composition graph, execution graph, deployment graph는
존재하지 않습니다.
