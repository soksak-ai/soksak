---
kind: translation
status: active
canonical: docs/tech/ENVIRONMENT-AND-INSTALLATION.md
---

# Environment와 설치

공개 JSON 형식은 `soksak-spec`이 소유합니다. 이 문서는 Core runtime 상태와 installer transaction을
정의합니다. Canonical build, local store, GitHub 공개 규칙은 spec package의
`docs/BUILD-AND-RELEASE.md`가 정의합니다.

## Environment

`<identity-home>/environment.json`은 유일한 영구 runtime-component 상태입니다. 하나의 단조 증가
`revision`, Plugin record, Sidecar record를 포함합니다. Plugin record에는 exact version, materialized
절대 경로, source(`local` 또는 `registry`), artifact SHA-256, enabled 상태가 있습니다. Sidecar record는
enabled 상태 대신 target triple을 추가합니다.

Kit, Contract, Spec은 build 또는 validation input입니다. 이들의 exact release reference는 release
document와 candidate build receipt에 남으며 Core는 runtime 상태로 복사하지 않습니다. Runtime
dependency는 Plugin release에 남습니다. Environment는 repository, source commit, URL, size, dependency
closure, role binding을 저장하지 않습니다.

Core는 identity home을 얻은 뒤 revision 1을 생성합니다. 상태가 없거나 올바르지 않으면 boot error이며
가상의 empty state를 만들지 않습니다. 모든 변경은 compare-and-swap을 사용하고
`environment.changed` event 하나를 발행합니다. File polling은 없습니다.

## 하나의 release 계약과 두 transport

Local release와 registry release는 같은 closure resolver와 installer transaction을 사용합니다. 두
release 모두 동일한 공개 release document, manifest, permission, entrypoint, size, SHA-256을 가집니다.
HTTPS와 명시적으로 주소를 받은 local release store는 승인된 byte를 읽는 방법만 다릅니다. Raw source
path는 설치 input이 아닙니다. Core는 `../`, 주입된 workspace root, `PATH`, checkout layout, symlink로
repository를 찾지 않습니다.

Exact dependency version이 주소를 받은 local store에 있으면 release와 asset byte가 parent의 URL, size,
SHA-256과 같아야 합니다. Local release가 손상됐거나 다르면 error이며 network로 fallback하지
않습니다. Local에 dependency가 없으면 parent release가 선언한 exact HTTPS reference를 사용할 수
있습니다.

## Installer transaction

Installer는 complete Plugin/Sidecar runtime closure를 해석하고 host target을 고르며 모든 size와
SHA-256을 검증하고 regular file만 추출하며 manifest를 확인합니다. 모든 component를 stage한 뒤
component directory와 `environment.json`을 transaction 하나로 공개합니다. 실패하면 이전 environment와
component directory가 그대로 유지됩니다.

같은 id, version, target, artifact digest는 멱등입니다. 같은 id, version, target의 digest가 다르면
`VERSION_ARTIFACT_CONFLICT`로 실패하며 설치 byte를 덮어쓰지 않습니다. Local record는 자동 registry
교체 대상이 아닙니다. Registry update는 표시할 수 있지만 Local 선택을 바꾸려면 명시적인 registry
install transaction이 필요합니다.

Installer는 실행 중이거나 기록된 Sidecar를 종료하지 않습니다. 다른 Sidecar byte를 선택하려면 명시적
lifecycle operation이 필요합니다. Core는 update 완료를 위해 사용자의 복구 가능한 process를 종료하지
않습니다.

## Command와 event

- `environment_get`: complete runtime 선택 조회
- `plugin_enabled_set`: compare-and-swap으로 Plugin 활성화 변경
- `artifact_install_begin`, `artifact_install_stage`, `artifact_install_read_utf8`,
  `artifact_install_commit`, `artifact_install_rollback`: shared transaction
- `artifact_install_status`, `artifact_install_wait`: event-driven progress 공개
- `artifact.install.progress`: phase 변경, `environment.changed`: commit된 revision 하나

`source_set`, raw-path install, compatibility reader, fallback transport, install profile, 저장된 dependency
closure, 두 번째 installer는 존재하지 않습니다.
