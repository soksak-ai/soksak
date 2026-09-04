---
kind: translation
status: historical
canonical: docs/tech/ENVIRONMENT-AND-INSTALLATION.CHANGELOG.md
---

# Environment와 설치 설계 흐름

이 문서는 [영어 흐름 문서](./ENVIRONMENT-AND-INSTALLATION.CHANGELOG.md)의 한국어 번역입니다.
현재 계약은 `ENVIRONMENT-AND-INSTALLATION.md`가 정의합니다.

## 두 로컬 record가 실패한 이유

Component 상태가 `settings.json`과 `installed.json`으로 나뉘어 activation과 role 선택, 설치 경로와
version이 서로 다른 revision에 있었습니다. Crash나 동시 update가 한쪽만 공개하면 runtime이 열 수 없는
content를 선택할 수 있었습니다. “정확히 무엇이 실행되는가”에 답하려면 두 authority를 합쳐야 했습니다.

## 하나의 atomic environment

`environment.json`이 유일한 영구 로컬 component 상태가 되었습니다. 하나의 revision에 정확한 version,
절대 경로, 소스 종류, 활성화, target, plugin 과 sidecar 의 역할 binding 이 들어갑니다. 설치는 바이트를
먼저 stage하고 component directory와 environment를 하나의 transaction으로 교체합니다. 실패하면 이전
environment가 유지됩니다.

Registry 는 원격 provenance 와 불변 릴리즈 metadata 를 소유합니다. 로컬 environment 는 이 설치가
선택한 내용과 검증된 byte의 위치만 기록합니다.

## 검증

Environment contract gate는 active code와 현재 정본에서 폐기된 파일명과 command를 거부합니다.
Transaction test는 설치 실패가 partial environment를 공개하지 못하게 합니다.

## 가상의 첫 revision이 실패한 이유

첫 구현은 `environment.json`이 없을 때 memory의 revision 1을 반환했지만 compare-and-swap은 저장된
revision을 올바르게 0으로 보았습니다. 따라서 첫 설치는 `expected 1, actual 0`으로 실패할 수밖에
없었습니다. 이제 Core가 identity home을 소유한 뒤 실제 revision 1을 공개합니다. 조회와 write가
하나의 상태를 사용하며 파일 없음을 두 가지로 해석하지 않습니다.

## 2026-08-25: 개발 소스와 종류별 제거 명령 하나

개발 record 는 `source` 가 `development`, `path` 가 소스 디렉터리, `artifactSha256` 이 존재하며 비어
있고, `registry`가 없으며, `version`은 `plugin_develop` 시점에 manifest에서 읽습니다. `plugin_develop`과
`sidecar_develop`이 compare-and-swap으로 등록합니다. 개발 record 위에 `registry` 또는 `local`
release를 설치하면 record를 교체합니다. 비어 있는 `artifactSha256`은 `VERSION_ARTIFACT_CONFLICT`를
일으키지 않습니다.

개발 directory가 version의 진실입니다. 어떤 validation도 개발 record의 `version`을 directory의
`plugin.json`과 비교하지 않습니다. Core frontend는 disk의 manifest로 runtime을 구성하고 그 version을
dependent의 `{id, version}` requirement와 reload identity에 사용합니다. Registry와 local record는
immutable이며 `version`은 artifact의 `plugin.json`과 같아야 합니다.

Plugin entry는 `parseManifest`와 같은 manifest 규칙을 따릅니다. key가 없으면 `main.js`, `null`이면
entry file 없음(순수 contract Plugin), 문자열이면 directory 내부 상대 경로(`..` 금지, 절대 경로
금지)입니다. `plugin_develop`은 entry가 `null`이 아닐 때만 그 file(regular file, path 구성 요소에
symlink 없음)을 검증합니다.

Content-addressed directory `<home>/components/<kind>/<id>/<version>[/<target>]/<sha256>`가 이미
있으면 설치는 그 directory를 재사용하고 stage된 복사본을 폐기합니다. 같은 digest는 같은 byte이며
directory를 공개한 rename은 atomic이었습니다. 이 경우 `destinationExists`를 반환하지 않습니다.

`plugin_remove`와 `sidecar_remove`(`id`, `expectedRevision`)가 종류별 제거 명령 하나입니다.
`plugin_remove`는 이 변경 전에는 unbuilt stub이었고 `sidecar_remove`는 새로 추가되었습니다. 개발
record는 environment에서만 제거합니다. `local` 또는 `registry` record는 environment에서 제거하고
실제 path가 `<home>/components/` 바로 아래 깊이 이상일 때만 artifact directory를 삭제합니다.
Components root와 record path 양쪽의 symlink를 해석하고 components root 아래 path 구성 요소 중
하나라도 symlink이면 거부합니다. 다른 path는 `environment.remove.pathOutsideHome`으로 거부합니다.
알 수 없는 id는 `environment.remove.notFound`로 거부합니다. Dependency invariant는 write 전에 결과
environment에 대해 검사합니다.

Artifact 제거는 content-addressed path에 대해 atomic입니다. Environment write 전에 directory를 같은
parent 안의 `<dir>.removing`으로 rename하고, write는 compare-and-swap이며, write가 실패하면 directory를
원래 이름을 복원하고, write가 성공하면 `<dir>.removing`을 삭제합니다. 삭제가 실패하면
`.removing` path를 담은 `environment.remove.artifactDeleteFailed`를 change와 함께 반환합니다. 따라서
content-addressed path는 partial 상태가 되지 않으며, 이 조건 아래에서 설치가 그 path의 기존
directory를 재사용합니다.

Core frontend는 host 먼저 제거합니다. 현재 revision에서 `plugin_remove`를 호출하고 host가 수락한
뒤에만 memory의 instance를 비활성화하고 consent와 enabled 상태를 지우며 revision을 한 번 reconcile합니다.
Host가 거부하면 frontend는 아무것도 바꾸지 않습니다. `sidecar.remove`는 `sidecar_status`가 그 id를
open 또는 recorded로 나열하면 `SIDECAR_IN_USE`로 거부합니다. `sidecar.install.local`과 같은 규칙이며
자동으로 종료하지 않습니다.

Host는 `environment.json`을 한 번 검증합니다. `environment_get`은 검증된 document를 반환하고 Core
frontend는 이를 자체 `HostEnvironment` type으로 typed data로 사용합니다. Frontend의
`parseEnvironmentDocument` 호출과 `ENVIRONMENT_INVALID` 결과는 제거되었습니다. Core의 `./spec` barrel은
Core가 사용하는 이름만 명시적 named export로 export하며 `parseEnvironmentDocument`는 그중에 없습니다.
개발 record의 절대 경로 검증은 host에서만 수행하며 frontend는 path를 사전 검증하지 않습니다.

## 2026-08-25: Effective version, spec와 같은 entry 규칙, 제거 순서

위 절은 host가 기록된 대로 구현하지 않은 규칙 셋과, 이후 Go 변경이 교체한 규칙 하나를 기록했습니다.
이 항목은 지금 유효한 규칙을 기술합니다.

Effective version은 host 규칙 하나, `core/environment/manifest.go`의 단일 manifest reader
`readRecordManifest` 위의 `recordVersion`입니다. `registry` 또는
`local` record의 effective version은 저장된 `version`입니다. `development` record는 Plugin과 Sidecar
모두 비교 시점에 읽은 `<path>/plugin.json` 또는 `<path>/sidecar.json`의 version입니다. 호출자가 준
version을 record와 비교하는 모든 host 비교가 이를 사용합니다. `plugin_enabled_set`, Plugin
requirement와 요청된 version에 대한 Sidecar resolution, Plugin과 Sidecar record 양쪽에 대한
dependency invariant, install commit의 개발 record 검사가 여기에 해당합니다. 어떤 site도 개발
record에 저장된 `version`을 비교하지 않습니다. 이전 문장 "어떤 validation도 record의 version을
directory의 manifest와 비교하지 않는다"는 Plugin store만 기술한 것이었고, host는 개발 Sidecar의
저장된 `version`을 비교하고 있었습니다. Manifest를 읽거나 parse할 수 없거나 다른 id를 선언하는 개발 record는
broken입니다. Effective version이 없고, 어떤 dependent도 충족하지 않으며, 그 effective version이
필요한 모든 operation(`enabled`가 `true`인 `plugin_enabled_set`, `sidecar_open`의 Sidecar
resolution)은 `environment.develop.directoryUnavailable`(`kind`, `id`, `path`, `error`)로
실패합니다. 어떤 dependent도 broken record를 요구하지 않으면 write는 진행합니다. Validation은 그
record의 identity 검사를 건너뛰고 dependent에 대해서는 없는 record로 취급합니다.

Entry 규칙은 spec과 같습니다(`soksak-spec` `packages/plugin-spec/src/spec.ts`, `parseManifest`).
없으면 `main.js`, `null`이면 entry 없음, 문자열이면 trim한 뒤 비어 있지 않고 상대 경로이며 `..`
segment가 없고 선행 separator나 drive letter가 없으며 `.js` 또는 `.mjs`로 끝납니다. 그 외의 값은
`environment.develop.entryInvalid`로 거부합니다. 이전 host는 trim하지 않은 문자열과 임의의
확장자를 받아들였습니다.

제거 순서. Rename 전에 `<dir>.removing`이 있으면 record가 이미 사라진 이전 제거의 잔여물이며 먼저
삭제합니다. 여기서 실패하면 `<dir>.removing`을 담은 `environment.remove.artifactDeleteFailed`로
거부하고 아무것도 바꾸지 않습니다. 그 다음 `<dir>.removing`으로 rename, environment
write(compare-and-swap), write 실패 시 원래 이름을 복원, 성공 시 `<dir>.removing` 삭제 순서입니다.
마지막 삭제의 실패는 더 이상 Go error가 아닙니다. Command는 `{ previousRevision, revision,
artifactDeleteFailed: { path, error } }`로 성공합니다. Core 프론트엔드는 그 변경을 성공으로
처리하고(consent 삭제, cascade 계속) path를 담은 activity 하나(`plugin.remove.artifactLeft`,
`sidecar.remove.artifactLeft`)를 발행합니다. 이전 frontend는 모든 throw를 거부로 처리했으므로, 삭제
실패 시 host가 이미 제거한 record의 consent와 enabled 상태가 그대로 남았습니다.

Path 거부는 key 하나가 아니라 둘입니다. `<home>/components/`의 strict descendant가 아닌 path는
`environment.remove.pathOutsideHome`, components root 아래 path 구성 요소 중 하나라도 symlink이면
`environment.remove.pathSymlink`입니다. 이전 문서는 첫 번째만 적었습니다.

`sidecar.develop`은 `sidecar.install.local`, `sidecar.remove`와 같은 `sidecarInUse` 검사로 host 호출
전에 `SIDECAR_IN_USE`를 거부합니다. 이전 command에는 guard가 없어 실행 중인 Sidecar의 record를
개발 record가 교체할 수 있었습니다.

계약 문서는 host command별로 호출자가 받을 수 있는 모든 error를 나열합니다. Key는
`environment.develop.pathAbsolute`, `environment.develop.directoryUnavailable`,
`environment.develop.entryInvalid`, `environment.remove.notFound`,
`environment.remove.pathOutsideHome`, `environment.remove.pathSymlink`,
`environment.remove.artifactDeleteFailed`, `install.transaction.dependencyVersionConflict`,
`install.transaction.pluginManifestInvalid`, `install.hostArtifactTarget.noPlatform`,
`install.hostArtifactTarget.noTriple`이고, key가 아닌 error는 `ErrRevisionConflict`,
`environment.json` 없음의 `os.ErrNotExist`, 그리고 표에 적힌 `os.ErrInvalid`, `os.ErrNotExist`,
file 검사의 os error입니다. `environment.develop.manifestMismatch`는 삭제되었습니다.
`environment.develop.directoryUnavailable`(`kind`, `id`, `path`, `error`)이 읽거나 parse할 수 없거나
다른 id를 선언하는 개발 manifest에 대한 유일한 거부입니다. `plugin_develop`과 `sidecar_develop`,
`enabled`가 `true`인 `plugin_enabled_set`, Sidecar resolution에서 같습니다. Manifest 읽기의 raw os
error는 호출자에게 반환되지 않습니다.

One read. Host operation이 다루는 모든 record에 대해 그 manifest는 operation당 정확히 한 번 읽고
parse하며, effective version과 다른 모든 manifest field는 그 parse 하나에서 가져옵니다. 어떤
operation도 같은 file을 두 번 읽어 비교하지 않습니다. Disable. `enabled`가 `false`인
`plugin_enabled_set`은 effective version을 요구하지 않으므로 broken 개발 Plugin을 disable할 수
있습니다. `enabled`가 `true`이면 요구합니다. Orphan. 개발 record가 아닌 record의 제거는 `<dir>`
자체가 더 이상 없어도 항상 `RemoveAll(<dir>.removing)`을 시도합니다. `<dir>`은 record path에서
parent chain을 해석하고 symlink를 검사한 결과입니다. Rename과 environment write 사이의 crash는 그
record의 다음 제거 뒤에 아무것도 남기지 않습니다.

## 2026-08-26: Code에서 도출한 거부 표

계약 문서의 거부 표는 `core/environment`에서 도출하며 각 host command가 반환하는 모든 error를
나열합니다. 이전 표는 키가 없는 오류 둘만 적고 나머지는 산문에 남겼습니다. 추가된 행: 명령마다
argument decoding(`control.arg.missing`, `control.arg.nullValue`, JSON type이 틀릴 때의 raw
`argument "<name>": <json error>`); `environment.json`의 원시 읽기 오류 또는 파싱 오류;
`environment.home.absolute`; write 시점 결과 environment 의 원시 `platformspec` 검증 오류;
publish 중 `MkdirAll`, `WriteFile`, `Rename`의 원시 os 오류; `plugin_remove` 또는 `sidecar_remove` 가
실패한 write 뒤 `<dir>.removing`을 되돌리지 못할 때의 `errors.Join(write error, rename error)`;
not-exist 외의 error로 실패한 `Lstat(<dir>)`. 정확하게 고친 항목:
`environment.develop.directoryUnavailable`은 없는 manifest 도 포함하며 `error` 는 `<file>: <os error
또는 parse error>` 또는 `<file> declares id <id>`; `sidecar.json`의 spec parser 조건;
`environment.remove.pathOutsideHome`은 해석된 parent가 `<dir>`을 해석된 root 밖에 둘 때 `<dir>`을
적음; `plugin_enabled_set`이 비교하는 effective version과 `enabled`가 `false`인 broken 개발
record의 version 검사 생략. `sidecar_open`의 Sidecar resolution에는 `sidecar.json`이 record를
확인하지 않는 `registry` 또는 `local` Sidecar 의 `os.ErrInvalid` 와 `dist/<id>` 의 프로세스 파일 검사를
추가했습니다.

## 2026-08-26: `plugin_manifest_list`의 broken record, rejected record의 제거와 disable

`plugin_manifest_list`는 모든 record의 manifest를 다른 모든 operation이 사용하는 reader인
`readRecordManifest`로 읽습니다. Manifest를 읽거나 parse할 수 없거나 다른 id를 선언하는 record는
`manifest`가 `null`이고 `error`가 `development` record에서는
`environment.develop.directoryUnavailable` 문장, `registry` 또는 `local` record에서는
`install.transaction.pluginManifestInvalid` 문장으로 나열됩니다. 이전 command는 두 번째 reader로
`plugin.json`을 읽고 raw os 문자열을 보고했습니다.

Core frontend의 `plugin.remove`와 `plugin.disable`은 id를 host 목록, 즉 parse된 runtime map과
rejected 목록 양쪽에서 찾습니다. 이전 store는 parse된 runtime map만으로 `TARGET_NOT_FOUND`를
반환했으므로 host가 나열한 broken 개발 record를 frontend에서 제거하거나 disable할 수 없었습니다.
이제 rejected record는 `plugin_remove`로 제거하고 host가 수락한 뒤 rejected 목록에서 지우며, host
record가 enabled이면 `enabled` `false`인 `plugin_enabled_set`으로 disable합니다.
`TARGET_NOT_FOUND`는 host에 record가 없을 때만 반환합니다.

계약 문서는 존재하는 Go identifier인 `core/environment/manifest.go`의 `readRecordManifest`와
`recordVersion`을 적습니다. 이전 문서는 어떤 Go file도 선언하지 않는 이름인 `effectiveVersion`을
인용했습니다. 거부 표에 `plugin_manifest_list`와 `environment_get` row가 있습니다. 둘 다
`environment.json`의 non-key 읽기 또는 parse error를 반환하고, file이 없을 때 `environment_get`은
`os.ErrNotExist`를 반환하며 `plugin_manifest_list`는 빈 목록을 반환합니다. Record별 manifest error는
record의 data이며 거부가 아닙니다.

## 2026-08-26: Develop 응답이 결과 status를 포함하고, overlay가 노출된 node가 됨

`plugin.develop`은 reload 뒤 `{ id, path, revision }`으로 응답했고, reload된 plugin은 consent-required
error와 함께 `disabled`로 남아 pane에 placeholder가 표시되었지만 응답에는 그 상태를 적을 field가
없었습니다. 이제 응답은 reload 뒤 plugin store에서 읽은 `status`와 `error`를 포함하며, rejected
목록만 가진 id는 `rejected`, 어느 쪽도 가지지 않은 id는 `absent`입니다. Message는 status와 error를
적습니다. `sidecar.develop`은 `{ id, path, revision, version }`으로 응답하며 `version`은 host가
기록한 record의 version으로 write 뒤에 `environment_get`에서 읽습니다. Status field는 없습니다.
Write 전의 `SIDECAR_IN_USE` guard가 `open` 또는 `recorded`로 나열된 id를 거부하므로 write 뒤의
`sidecar_status` 읽기는 답이 하나입니다.

PluginViewHost 의 오버레이(loading, placeholder, error)에는 `data-node` 가 없어서 문장이 화면에 있는
동안 `ui.tree` 는 disabled plugin 의 pane 에 노드 0개를 보고했습니다. 이제 각 오버레이는 뷰 주소와
`data-node`(`plugin-view-loading`, `plugin-view-placeholder`, `plugin-view-error`)를 선언하고 상태를
`data-view-state`, `data-view-plugin`, `data-view-reason`, `data-view-error`에 적습니다. Overlay는
provider container의 child가 아니라 sibling입니다. Container는 provider가 소유한 DOM이고 overlay가
표시되는 동안 숨겨집니다. 오버레이는 뷰 주소를 `data-view-addr` 가 아니라
`data-view-overlay-addr`에 선언합니다. `ui.slot`은 `.tab-viewer[data-view-addr]`를
resolve하며 address axiom A2는 address 하나에 element 하나를 요구합니다. Collector의 scan root는
`.tab-viewer[data-view-addr]`와 `[data-view-overlay-addr]` 둘이며, 어느 쪽 안의 `data-node`든 그
root 의 뷰 주소 아래에 나열되고 chrome 스캔은 건너뜁니다.
