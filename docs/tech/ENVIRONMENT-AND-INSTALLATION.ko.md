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

Environment는 Plugin과 Sidecar runtime 선택만 기록합니다.
`<identity-home>/environment.json`은 유일한 영구 runtime-component 상태입니다. 하나의 단조 증가
`revision`, Plugin record, Sidecar record를 포함합니다. Plugin record에는 exact version, materialized
절대 경로, source(`local`, `registry` 또는 `development`), artifact SHA-256, enabled 상태가 있습니다.
Sidecar record는 enabled 상태 대신 target triple을 추가합니다.

Kit, Contract, Spec은 build 또는 validation input입니다. 이들의 exact release reference는 release
document와 candidate build receipt에 남으며 Core는 runtime 상태로 복사하지 않습니다. Runtime
dependency는 Plugin release에 남습니다. Environment는 repository, source commit, URL, size, dependency
closure, role binding을 저장하지 않습니다.

Core는 identity home을 얻은 뒤 revision 1을 생성합니다. 상태가 없거나 올바르지 않으면 boot error이며
가상의 empty state를 만들지 않습니다. 모든 변경은 compare-and-swap을 사용하고
`environment.changed` event 하나를 발행합니다. File polling은 없습니다.

Host는 `environment.json`을 한 번 검증합니다. `environment_get`은 parse와 검증을 마친 document를
반환하며 Core frontend는 이를 typed data로 사용하고 다시 검증하지 않습니다.

## 하나의 release 계약과 두 transport

Local release와 registry release는 같은 closure resolver와 installer transaction을 사용합니다. 두
release 모두 동일한 공개 release document, manifest, permission, entrypoint, size, SHA-256을 가집니다.
HTTPS와 명시적으로 주소를 받은 local release store는 승인된 byte를 읽는 방법만 다릅니다. Raw source
path는 설치 input이 아닙니다. 개발 record의 `path`는 `plugin.develop` 또는 `sidecar.develop`이 선언한
source directory이며 installer input이 아닙니다. Core는 `../`, 주입된 workspace root, `PATH`, checkout
layout, symlink로 repository를 찾지 않습니다.

Exact dependency version이 주소를 받은 local store에 있으면 release와 asset byte가 parent의 URL, size,
SHA-256과 같아야 합니다. Local release가 손상됐거나 다르면 error이며 network로 fallback하지
않습니다. Local에 dependency가 없으면 parent release가 선언한 exact HTTPS reference를 사용할 수
있습니다.

## Installer transaction

Installer는 complete Plugin/Sidecar runtime closure를 해석하고 host target을 고르며 모든 size와
SHA-256을 검증하고 regular file만 추출하며 manifest를 확인합니다. 모든 component를 stage한 뒤
component directory와 `environment.json`을 transaction 하나로 공개합니다. 실패하면 이전 environment와
component directory가 그대로 유지됩니다.

같은 id, version, target, artifact digest는 멱등입니다. Content-addressed directory
`<home>/components/<kind>/<id>/<version>[/<target>]/<sha256>`가 이미 있으면 설치는 그 directory를
재사용하고 stage된 복사본을 폐기합니다. 같은 SHA-256은 같은 byte이며 directory는 atomic rename으로
공개되므로 이미 있는 directory는 완전합니다. 이 경우 실패하지 않습니다. 같은
id, version, target의 digest가 다르면 `VERSION_ARTIFACT_CONFLICT`로 실패하며 설치 byte를 덮어쓰지
않습니다. Local record는 자동 registry 교체 대상이 아닙니다. Registry update는 표시할 수 있지만 Local 선택을 바꾸려면 명시적인 registry
install transaction이 필요합니다.

Installer는 실행 중이거나 기록된 Sidecar를 종료하지 않습니다. 다른 Sidecar byte를 선택하려면 명시적
lifecycle operation이 필요합니다. Core는 update 완료를 위해 사용자의 복구 가능한 process를 종료하지
않습니다.

## 개발 source

개발 record는 Plugin 또는 Sidecar record와 같은 형식이며 `source`가 `development`입니다. `path`는
절대 경로이자 clean한 source directory입니다. Plugin directory는 `plugin.json`과 manifest가 선언한
entry(entry `null`: entry file 없음)를 포함하고 Sidecar directory는 `sidecar.json`과 `dist/<id>`를
포함합니다. Entry 규칙은 `parseManifest`(`soksak-spec`, `packages/plugin-spec/src/spec.ts`)의
manifest 규칙과 같습니다. key가 없으면 `main.js`, `null`이면 entry file 없음(순수 contract Plugin),
문자열이면 trim한 뒤 비어 있지 않고 상대 경로(선행 separator 금지, drive letter 금지)이며 `..`
segment가 없고 `.js` 또는 `.mjs`로 끝나야 합니다. 그 외의 값은
`environment.develop.entryInvalid`로 거부합니다. Host가 path를 검증하고, entry가 `null`이 아닐 때만
entry file(regular file, path 구성 요소에 symlink 없음)을 검증하며, frontend는 사전 검증하지
않습니다. 상대 경로이거나 clean하지 않은 path는 `environment.develop.pathAbsolute`로 거부합니다.
Manifest는 operation당 한 번 읽고 parse하며 `id`, `version`, `entry`(Plugin) 또는
`process`(Sidecar)는 그 parse 하나에서 가져옵니다. Manifest를 읽거나 parse할 수 없거나 manifest가 다른 id를 선언하는 directory는
`environment.develop.directoryUnavailable`(`kind`, `id`, `path`, `error`)로 거부합니다. `error`는
`<file>: <os error 또는 parse error>` 또는 `<file> declares id <id>`이며, os error 또는 parse error는
단독으로는 호출자에게 반환되지 않습니다. `version`은
`plugin.develop` 또는 `sidecar.develop` 시점에 그 parse에서 복사하며 strict semver여야 합니다. `registry`와 `local`
record는 immutable이며 `version`은 artifact의 manifest와 같아야 합니다. `artifactSha256`은 존재하며
비어 있고 `registry`는 없습니다. Artifact는 없습니다. Sidecar record의 `target`은 host build OS와
architecture에서 도출한 host artifact target triple이며 environment variable에서 가져오지 않습니다.
Validation은 digest 또는 registry가 비어 있지 않은 `development` record를 거부합니다. `local`과
`registry` record의 validation은 변경 없으며 digest가 필요합니다.

Record의 effective version은 host 규칙 하나(`core/environment/manifest.go`의 `recordVersion`,
단일 manifest reader `readRecordManifest` 위에 있음)입니다.
`registry` 또는 `local` record는 record의 `version`입니다. `development` record는 Plugin과 Sidecar
모두 directory manifest(`<path>/plugin.json` 또는 `<path>/sidecar.json`)의 version입니다. Host
operation이 다루는 모든 record에 대해 그 manifest는 operation당 정확히 한 번 읽고 parse하며,
effective version과 그 operation이 사용하는 다른 모든 manifest field는 그 parse 하나에서
가져옵니다. 어떤 operation도 같은 file을 두 번 읽어 비교하지 않습니다. 개발 record에 저장된
`version`은 비교하지 않습니다. 호출자가 준 version을 record와 비교하는 모든 host 비교는 effective
version을 사용합니다. `plugin_enabled_set`, Plugin requirement와 요청된 version에 대한
`sidecar_open`의 Sidecar resolution, dependency invariant(모든 Plugin manifest의
`runtimeDependencies` `{id, version}`을 Plugin과 Sidecar record에 대해 검사하며 record를 바꾸는 모든
environment write 전과 installer에서 수행), install commit의 개발 record 검사가 여기에 해당합니다.
Manifest를 읽거나 parse할 수 없거나 manifest가 다른 id를 선언하는 개발 record는 broken입니다.
Effective version이 없고 어떤 dependent도 충족하지 않습니다. 그 effective version이 필요한 모든
operation은 `environment.develop.directoryUnavailable`(`kind`, `id`, `path`, `error`)로
거부합니다. `enabled`가 `true`인 `plugin_enabled_set`, broken consumer Plugin 또는 broken Sidecar에
대한 `sidecar_open`의 Sidecar resolution이 여기에 해당합니다. `enabled`가 `false`인
`plugin_enabled_set`은 effective version을 요구하지 않습니다. Broken 개발 Plugin은 effective version
없이 disable됩니다. Dependency invariant는 broken record를 dependent에 대해 없는 record로
취급합니다. 그 record를 요구하는 dependent는
`install.transaction.dependencyVersionConflict`(`requested`는 `missing`)로 거부하고, 어떤 dependent도
broken record를 요구하지 않으면 write는 진행합니다. Validation은 broken record의 identity 검사를
건너뜁니다. Core frontend는 같은 disk의 manifest로 runtime을 구성하고 그 version을 dependent의 `{id,
version}` requirement와 reload identity에 사용합니다.

`plugin_manifest_list`는 모든 record의 manifest를 다른 모든 operation이 사용하는 reader인
`readRecordManifest`로 읽습니다. Manifest를 읽거나 parse할 수 없거나 다른 id를 선언하는 record는
`manifest`가 `null`이고 `error`가 `development` record에서는
`environment.develop.directoryUnavailable` 문장, `registry` 또는 `local` record에서는
`install.transaction.pluginManifestInvalid` 문장으로 나열됩니다. Raw os 문자열은 보고하지 않습니다.
Core frontend는 그런 record를 rejected로 나열합니다. `plugin.remove`와 `plugin.disable`은 id를
host 목록, 즉 parse된 runtime map과 rejected 목록 양쪽에서 찾습니다. Rejected record는
`plugin_remove`로 제거하고, host record가 enabled이면 `enabled` `false`인 `plugin_enabled_set`으로
disable합니다. `TARGET_NOT_FOUND`는 host에 record가 없을 때만 반환합니다.

`plugin.develop`과 `sidecar.develop`은 개발 record를 등록합니다. 이미 `registry`, `local` 또는
`development` record가 있는 id에 development를 선언하면 그 record를 교체합니다. 설치된 artifact
directory는 삭제하지 않습니다. 개발 record가 있는 id에 `registry` 또는 `local` release를 설치하면 그
record를 교체합니다. 개발 record의 비어 있는 `artifactSha256`은 `VERSION_ARTIFACT_CONFLICT`를
일으키지 않습니다.

각 develop command의 응답은 결과 status를 포함합니다. `plugin.develop`은 environment coordinator가
plugin을 reload한 뒤 반환하며 `{ id, path, revision, status, error? }`로 응답합니다. `status`는 runtime
status(`enabled`, `disabled`, `error`)이고, rejected 목록만 그 id를 가지면 `rejected`, 어느 쪽도 가지지
않으면 `absent`입니다. `error`는 runtime error 또는 `; `로 이은 rejection error이며 없으면 생략합니다.
Message는 status를 적고 error가 있으면 그 error도 적습니다: `Plugin <id>의 development 레코드를
<path>로 기록했습니다; status disabled: <error>`. `sidecar.develop`은 `{ id, path, revision, version }`으로
응답하며 `version`은 host가 기록한 record의 version으로 write 뒤에 `environment_get`에서 읽습니다.
Message는 `Sidecar <id>의 development 레코드를 <path>로 기록했습니다 (version <v>)`이며 영문 message와 같은
정보를 담습니다.
Status field는 없습니다. Write 전의 `SIDECAR_IN_USE` guard가 `open` 또는 `recorded`로 나열된 id를
거부하므로 write 뒤의 `sidecar_status` 읽기는 답이 하나입니다.

View의 provider가 없는 pane은 overlay 하나를 그리며, 그 overlay는 view address 아래의 노출된
node입니다(`ui.tree`가 `<view address>/node/<data-node>`로 나열하고 `data-*` attribute는 `dataset`에
있습니다). Overlay는 provider container의 sibling이며 view address를 `data-view-overlay-addr`에
선언합니다. Container만 `data-view-addr`를 가지므로 `ui.slot`은 view address 하나에
element 하나를 resolve합니다. Node collector의 scan root는 `.tab-viewer[data-view-addr]`와
`[data-view-overlay-addr]` 둘이며, 어느 쪽 안의 `data-node`든 그 root의 view address 아래에
나열되고 chrome으로는 나열되지 않습니다. Boot가 ready가 되기 전의 node는 `plugin-view-loading`입니다. Boot 뒤의 node는
`plugin-view-placeholder`이며 `data-view-plugin`(plugin id)과 `data-view-state`를 가집니다. Plugin이
설치되어 있고 disabled이면 `off`, 어떤 record도 그 id를 가지지 않으면 `absent`, manifest가 거부되었으면
`refused`이고 이때 `data-view-reason`이 `; `로 이은 rejection error를 가집니다. Provider의 mount가
throw했으면 node는 `plugin-view-error`이며 `data-view-plugin`과 `data-view-error`(throw된 message)를
가집니다.

`plugin.remove`와 `sidecar.remove`가 유일한 제거 command입니다. 개발 record는 environment에서만
제거하며 source directory는 삭제하지 않습니다. `local` 또는 `registry` record는 environment에서
제거하고 record의 `path`에 있는 artifact directory를 삭제하되, 실제 path가 `<home>/components/`
바로 아래 깊이 이상일 때만 삭제합니다. Components root와 record path 양쪽의 symlink를 해석합니다.
Strict descendant가 아닌 path는 `environment.remove.pathOutsideHome`(`path`, `home`)으로 거부하고,
components root 아래 path 구성 요소 중 하나라도 symlink이면
`environment.remove.pathSymlink`(`path`, `link`)로 거부하며, 두 경우 모두 record는 유지됩니다. 알 수
없는 id는 `environment.remove.notFound`(`kind`, `id`)로 거부합니다. Dependency invariant는 어떤 file
작업보다 먼저 결과 environment에 대해 검사합니다. 제거는 content-addressed path에 대해 atomic이며
다음 순서로 진행합니다. `<dir>`은 record의 `path`에서 parent chain을 해석하고 모든 path 구성 요소의
symlink를 검사한 결과입니다. `RemoveAll(<dir>.removing)`은 `<dir>` 자체가 더 이상 없어도 항상 먼저
시도합니다. `<dir>.removing`은 record가 이미 사라진 이전 제거의 잔여물이며, 따라서 rename과
environment write 사이의 crash는 그 record의 다음 제거 뒤에 아무것도 남기지 않습니다. 여기서
실패하면 `environment.remove.artifactDeleteFailed`(`path`는 `<dir>.removing`, `error`)로 거부하며
아무것도 바꾸지 않습니다. `<dir>`이 있으면 같은 parent 안의 `<dir>.removing`으로 rename합니다.
Environment write(compare-and-swap)를 수행합니다. Write가 실패하면 directory를 원래 이름으로
되돌리고 거부합니다. Write가 성공하면 `<dir>.removing`을 삭제합니다. 마지막 삭제의 실패는 error가
아닙니다. Command는 `{ previousRevision, revision, artifactDeleteFailed: { path, error } }`로
성공하며 `path`는 `.removing` path입니다. Record는 제거된 상태이고 `environment.changed`는
발행됩니다. Content-addressed path는 partial 상태가 되지 않으며, 그래서 설치가 그 path의 기존
directory를 재사용합니다.

Core frontend는 Plugin을 host 먼저 제거합니다. 현재 revision에서 `plugin_remove`를 호출하고, host가
수락한 뒤에만 memory의 instance를 enabled write 없이 비활성화하고 consent와 enabled 상태를 지우며
environment coordinator를 통해 revision을 한 번 reconcile합니다. Host가 거부하면 frontend는 아무것도
바꾸지 않습니다. Change의 `artifactDeleteFailed`는 성공입니다. Frontend는 path를 담은 activity
하나(Plugin store에서는 `plugin.remove.artifactLeft`, `sidecar.remove`에서는
`sidecar.remove.artifactLeft`)를 발행하고, consent를 지우며, cascade는 계속합니다.
`sidecar.develop`과 `sidecar.remove`는 `sidecar_status`가 그 id를 open 또는 recorded로 나열하면
`SIDECAR_IN_USE`로 거부합니다. `sidecar.install.local`과 같은 규칙이며 Core는 Sidecar를 종료하지
않습니다.

`plugin.reload {id}`는 `<path>/plugin.json`과 manifest가 선언한 entry를 다시 읽습니다. `app.environment`의
`unitMode`는 개발 record에서 도출합니다.

## 거부

표는 host command별로 호출자가 environment module에서 받을 수 있는 모든 error를 나열합니다. 거부
key는 `core/environment`에 선언된 i18n key이며 아래의 `install.*` key도 거기에 선언되어 있습니다.
Non-key로 표시한 error는 그대로 반환됩니다. Go `os` error, `ErrRevisionConflict`, 그리고
`control.Arg`, `environment.json` reader, `platformspec` validator의 raw error입니다.
`sidecar.develop`과 `sidecar.remove`의 `SIDECAR_IN_USE`는 host 호출 전의 Core frontend 거부이며
host error가 아닙니다. `sidecar_open` row는 Sidecar resolution 중 environment가 소유한 error만
나열합니다. `<dir>`은 위 제거 규칙의 해석된 artifact directory입니다.

| Command | Error | 조건 |
| --- | --- | --- |
| `plugin_develop`, `sidecar_develop` | `control.arg.missing`(`name`), `control.arg.nullValue`(`name`) | `id`, `path`, `expectedRevision` 중 하나가 없거나 `null`임. 다른 모든 검사보다 먼저. |
| `plugin_remove`, `sidecar_remove` | `control.arg.missing`(`name`), `control.arg.nullValue`(`name`) | `id` 또는 `expectedRevision`이 없거나 `null`임. 다른 모든 검사보다 먼저. |
| `plugin_enabled_set` | `control.arg.missing`(`name`), `control.arg.nullValue`(`name`) | `plugins`, `enabled`, `expectedRevision` 중 하나가 없거나 `null`임. 다른 모든 검사보다 먼저. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | Non-key `argument "<name>": <json error>` | Argument의 JSON type이 틀림. |
| `sidecar_develop` | `install.hostArtifactTarget.noPlatform` | Process가 host OS 또는 architecture를 받지 못함. `path`보다 먼저 검사. |
| `sidecar_develop` | `install.hostArtifactTarget.noTriple`(`os`, `arch`) | Host 쌍에 대한 artifact triple이 없음. `path`보다 먼저 검사. |
| `plugin_develop`, `sidecar_develop` | `environment.develop.pathAbsolute`(`path`) | `path`가 상대 경로이거나 clean하지 않음. |
| `plugin_develop` | `environment.develop.directoryUnavailable`(`kind` `plugin`, `id`, `path`, `error`) | `<path>/plugin.json`이 없거나, 읽거나 parse할 수 없거나, 다른 id를 선언함. `error`는 `plugin.json: <os error 또는 parse error>` 또는 `plugin.json declares id <id>`. |
| `sidecar_develop` | `environment.develop.directoryUnavailable`(`kind` `sidecar`, `id`, `path`, `error`) | `<path>/sidecar.json`이 없거나, 읽을 수 없거나, spec parser가 거부하거나(알 수 없는 field 또는 trailing data, id pattern 밖의 `id` 또는 `interface.id`, strict SemVer가 아닌 `version`, `0.0.1`이 아닌 `interface.version`, `dist/<id>` 또는 `dist/<id>.exe`가 아닌 `process`), 다른 id를 선언함. `error`는 `sidecar.json: <os error 또는 parse error>` 또는 `sidecar.json declares id <id>`. |
| `plugin_develop` | `environment.develop.entryInvalid`(`id`, `entry`) | Manifest `entry`가 entry 규칙을 위반함. |
| `plugin_develop` | Non-key `os.ErrNotExist`, `os.ErrInvalid`, 또는 그 밖의 `Lstat` error | Entry file 검사, entry가 `null`이 아닐 때(없으면 `main.js`): entry 또는 그 path 구성 요소가 없음(`os.ErrNotExist`); 구성 요소가 symlink이거나 entry가 regular file이 아님(`os.ErrInvalid`); 그 밖의 `Lstat` 실패(그 os error). |
| `sidecar_develop` | Non-key `os.ErrNotExist`, `os.ErrInvalid`, 또는 그 밖의 `Lstat` error | Manifest `process`(`dist/<id>`)의 process file 검사: process 또는 그 path 구성 요소가 없음(`os.ErrNotExist`); 구성 요소가 symlink이거나 process가 regular file이 아님(`os.ErrInvalid`); 그 밖의 `Lstat` 실패(그 os error). |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set`, `sidecar_open` | Non-key `environment.json` 읽기 또는 parse error | `environment.json`을 읽을 수 없거나(not-exist 외의 error), 내용을 `platformspec` parser 또는 validator가 거부함. `plugin_remove`, `sidecar_remove`, `plugin_enabled_set`에서는 첫 검사이고 `plugin_develop`과 `sidecar_develop`에서는 directory 검사 뒤. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set`, `sidecar_open` | Non-key `os.ErrNotExist` | `environment.json`이 없음. 위 row와 같은 위치. |
| `environment_get`, `plugin_manifest_list` | Non-key `environment.json` 읽기 또는 parse error | `environment.json`을 읽을 수 없거나(not-exist 외의 error), 내용을 `platformspec` parser 또는 validator가 거부함. 이 두 command의 유일한 거부. |
| `environment_get` | Non-key `os.ErrNotExist` | `environment.json`이 없음. `plugin_manifest_list`는 대신 빈 목록을 반환함. |
| `plugin_manifest_list` | 없음. Record의 `error` | Manifest를 읽거나 parse할 수 없거나 다른 id를 선언하는 record는 `manifest`가 `null`이고 `error`가 `readRecordManifest`의 `environment.develop.directoryUnavailable` 문장(`development`) 또는 `install.transaction.pluginManifestInvalid` 문장(`registry`, `local`)으로 나열됨. 거부가 아니며 raw os 문자열도 아님. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.notFound`(`kind`, `id`) | `id`의 record가 없음. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.pathOutsideHome`(`path`, `home`) | 개발 record가 아닌 record의 `path`가 `<home>/components/`의 strict descendant가 아니거나, 그 `<dir>`이 해석된 components root의 strict descendant가 아님. 두 번째 경우 `path`는 `<dir>`. Record는 유지. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.pathSymlink`(`path`, `link`) | Components root 아래의 path 구성 요소가, leaf를 포함하여, symlink임. Record는 유지. |
| `plugin_remove`, `sidecar_remove` | Path 검사의 non-key os error | Path 구성 요소의 `Lstat`, 또는 parent나 components root의 `EvalSymlinks`가 not-exist 외의 error로 실패함. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove` | `install.transaction.pluginManifestInvalid`(`plugin`) | 결과 environment의 dependency validation: `registry` 또는 `local` Plugin record의 `plugin.json`이 없거나, 읽거나 parse할 수 없거나, record의 id와 version을 선언하지 않음. `plugin_remove`와 `sidecar_remove`에서는 path 검사 뒤, 어떤 file 작업보다 먼저. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove` | `install.transaction.dependencyVersionConflict`(`plugin`, `kind`, `dependency`, `required`, `requested`) | 결과 environment의 dependency validation: Plugin manifest의 `runtimeDependencies` 항목에 정확히 그 version의 record가 없음. `plugin_remove`와 `sidecar_remove`에서는 남은 Plugin이 제거된 record를 요구함. 없거나 broken인 record는 `requested`가 `missing`, 그 밖에는 찾은 effective version. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.artifactDeleteFailed`(`path`, `error`) | Rename 전의 `RemoveAll(<dir>.removing)`이 실패함. `path`는 `<dir>.removing`. 아무것도 바뀌지 않음. 마지막 삭제의 실패는 거부가 아니라 result의 data. |
| `plugin_remove`, `sidecar_remove` | Rename의 non-key os error | `Lstat(<dir>)`이 not-exist 외의 error로 실패했거나 `<dir>`에서 `<dir>.removing`으로의 rename이 실패함. |
| `plugin_enabled_set` | Non-key `os.ErrInvalid` | `id` 또는 `version`이 빈 ref, 또는 `plugins`에 같은 `id`가 두 번 있음. |
| `plugin_enabled_set` | Non-key `os.ErrNotExist` | Ref `id`의 record가 없거나 ref `version`이 effective version(`registry`와 `local`은 record의 `version`, `development`는 지금 읽은 manifest version)과 다름. `enabled`가 `false`인 broken 개발 record는 version 검사를 건너뜀. |
| `plugin_enabled_set` | `environment.develop.directoryUnavailable`(`kind` `plugin`, `id`, `path`, `error`) | `enabled`가 `true`이고 개발 Plugin의 `plugin.json`이 없거나, 읽거나 parse할 수 없거나, 다른 id를 선언함. 그 record에 `enabled` `false`는 성공함. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | Non-key `ErrRevisionConflict`(`Expected`, `Actual`) | `expectedRevision`이 현재 revision과 다름. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | Non-key `platformspec` validation error | `Validate`가 결과 environment를 거부함. 예: 개발 `plugin.json`의 `version`이 strict SemVer가 아닐 때 `plugin <id>: component requires exact version and absolute path`. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | `environment.home.absolute` | Environment home이 절대 경로가 아님. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | Publish의 non-key os error | `environment.json`을 publish하는 동안 `MkdirAll`, `WriteFile`, 또는 `Rename`이 실패함. |
| `sidecar_open`(Sidecar resolution) | Non-key `os.ErrNotExist` | Consumer Plugin 또는 Sidecar id의 record가 없거나 요청된 version이 effective version과 다름. |
| `sidecar_open`(Sidecar resolution) | `environment.develop.directoryUnavailable`(`kind`, `id`, `path`, `error`) | Consumer Plugin record 또는 Sidecar record가 broken 개발 record임. |
| `sidecar_open`(Sidecar resolution) | Non-key `os.ErrInvalid` | `registry` 또는 `local` Sidecar record의 `sidecar.json`이 없거나, 읽을 수 없거나, spec parser가 거부하거나, record의 id와 version을 선언하지 않음. |
| `sidecar_open`(Sidecar resolution) | Non-key `os.ErrNotExist`, `os.ErrInvalid`, 또는 그 밖의 `Lstat` error | `sidecar_develop`과 같은 `dist/<id>`의 process file 검사. |

`plugin_remove`와 `sidecar_remove`는 위 write row 넷의 어떤 error를 반환하기 전에도
`<dir>.removing`을 `<dir>`로 되돌립니다. 그 rename이 실패하면 error는 `errors.Join(write error,
rename error)`입니다. `plugin_enabled_set`은 dependency validation을 수행하지 않습니다. Enabled
상태는 dependency invariant의 일부가 아닙니다.

## Command와 event

- `environment_get`: complete runtime 선택 조회
- `plugin_manifest_list`: 모든 Plugin record를 manifest 본문과 함께, broken record는 `error`와 함께
  나열
- `plugin_enabled_set`: compare-and-swap으로 Plugin 활성화 변경. `enabled`가 `true`이면 이름이
  적힌 모든 Plugin의 effective version이 필요하고 `false`이면 필요하지 않음
- `plugin_develop`, `sidecar_develop`(`id`, `path`, `expectedRevision`): compare-and-swap으로 개발
  record 등록
- `plugin_remove`, `sidecar_remove`(`id`, `expectedRevision`): compare-and-swap으로 record 하나를
  제거하고 위의 제거 규칙 적용
- `artifact_install_begin`, `artifact_install_stage`, `artifact_install_read_utf8`,
  `artifact_install_commit`, `artifact_install_rollback`: shared transaction
- `artifact_install_status`, `artifact_install_wait`: event-driven progress 공개
- `artifact.install.progress`: phase 변경, `environment.changed`: commit된 revision 하나

`source_set`, raw-path install, compatibility reader, fallback transport, install profile, 저장된 dependency
closure, 두 번째 installer는 존재하지 않습니다.
