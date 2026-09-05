---
kind: translation
status: active
canonical: docs/tech/ENVIRONMENT-AND-INSTALLATION.md
---

# Environment와 설치

공개 JSON 형식은 `soksak-spec`이 소유합니다. 이 문서는 Core runtime 상태와 installer transaction을
정의합니다. 정본 빌드, 로컬 저장소, GitHub 공개 규칙은 spec package의
`docs/BUILD-AND-RELEASE.md`가 정의합니다.

## Environment

environment 는 Plugin과 Sidecar runtime 선택만 기록합니다.
`<identity-home>/environment.json`은 유일한 영구 runtime-component 상태입니다. 하나의 단조 증가
`revision`, Plugin record, Sidecar record를 포함합니다. Plugin record에는 exact version, materialized
절대 경로, source(`local`, `registry` 또는 `development`), artifact SHA-256, enabled 상태가 있습니다.
Sidecar record 는 enabled 상태 대신 target triple과 component directory 안의 절대 materialized process
경로를 추가합니다.

Kit, Contract, Spec은 빌드 입력이거나 검증 입력입니다. 이들의 정확한 릴리즈 참조는 릴리즈
문서와 후보 빌드 receipt에 남으며 Core는 runtime 상태로 복사하지 않습니다. 실행 시점
의존은 Plugin 릴리즈에 남습니다. environment 는 저장소, 소스 commit, URL, 크기, 의존
closure, 역할 binding 을 저장하지 않습니다.

Core는 identity home을 얻은 뒤 revision 1을 생성합니다. 상태가 없거나 올바르지 않으면 부팅 오류이며
가상의 빈 상태를 만들지 않습니다. 모든 변경은 compare-and-swap을 사용하고
`environment.changed` event 하나를 발행합니다. 파일 폴링은 없습니다.

Environment revision을 쓰는 frontend 수명주기 연산은 environment coordinator 하나가 그 revision을
적용하기 전에는 반환하지 않습니다. 같은 `environment.changed` event는 같은 reconcile에 합류하며
이미 적용된 뒤에는 no-op입니다. 따라서 뒤따르는 enable, disable, install, reload가 앞선 write가 만든
reload와 경합해 같은 Plugin generation을 두 번 등록할 수 없습니다.

호스트는 `environment.json`을 한 번 검증합니다. `environment_get`은 parse와 검증을 마친 document를
반환하며 Core frontend는 이를 typed data로 사용하고 다시 검증하지 않습니다.

## 릴리즈 계약 하나와 전송 둘

로컬 릴리즈와 registry 릴리즈는 같은 closure resolver 와 설치 트랜잭션을 씁니다. 두
릴리즈 모두 같은 공개 릴리즈 문서, manifest, 권한, entrypoint, 크기, SHA-256 을 가집니다.
HTTPS와 명시적으로 주소를 받은 로컬 릴리즈 저장소는 승인된 바이트를 읽는 방법만 다릅니다. 원시 소스
경로는 설치 입력이 아닙니다. 개발 record의 `path`는 `plugin.develop` 또는 `sidecar.develop`이 선언한
소스 디렉터리이며 설치 입력이 아닙니다. Core는 `../`, 주입된 workspace root, `PATH`, checkout
layout, symlink로 repository를 찾지 않습니다.

어떤 릴리즈 문서도 위치를 기록하지 않습니다. 릴리즈 디렉터리는 kind, id, version 에서 도출합니다.
공개본은 `https://github.com/soksak-ai/<id>/releases/download/v<version>/`, 로컬 저장소는
`<store>/<kind>s/<id>/<version>/`이며 그 안의 모든 file은 bare name으로 가리킵니다. Parent release는
각 dependency의 `release.json`을 size와 SHA-256으로 고정하고, 그것을 읽는 resolver는 그 byte를
돌려줘야 합니다. 로컬 설치은 closure 의 모든 릴리즈를 주소를 받은 저장소에서 읽습니다. 저장소에
없는 의존이나 고정값과 바이트가 다른 의존은 도출한 위치를 명시한 오류이며 네트워크로
fallback하지 않습니다.

## official 레지스트리는 내장이고, URL 하나다

`official` 은 추가하는 것이 아니라 컴파일되어 들어 있습니다. 서술자 — id, 이름, 색인 URL, 신뢰 공개 키 —
가 상수이고, `registry.add` 는 id 가 `official` 인 서술자를 거부하며, 그것이 든 색인 URL 은

```text
https://github.com/soksak-ai/soksak-plugin-registry/releases/latest/download/registry.json
```

입니다. 그래서 official 카탈로그 전체가 릴리즈 asset 하나입니다. `latest` 는 레지스트리 저장소의 가장
새로운 `registry-<sequence>` 릴리즈로 해석되고, 색인은 그 릴리즈의 유일한 asset 입니다. 그런 릴리즈가
없는 저장소는 404 를 답하고, 모든 플러그인이 사용 불가가 되며, `registry.list` 가 그 레지스트리를
`error` 로 보고합니다 — 2026-09-04 측정.

다른 레지스트리는 서술자로 추가하고 HTTPS 로 닿습니다. `isRegistryIndexUrl` 이 다른 모든 scheme 을
거부하고, 자격 증명·쿼리·프래그먼트도 함께 거부합니다. 그래서 파일 경로도, 평문 http 서버도, 토큰을 실은
URL 도 이 전송 밖입니다. 로컬 색인은 TLS 로 서비스하거나 레지스트리 색인이 아닙니다.

두 레지스트리는 같은 qualified 항목을 만들고, 한정 없는 설치는 `official` 에 대해서만 해석됩니다.
`resolveRegistryRelease` 가 나머지에는 `qualification_required` 를 답하므로, 두 번째 레지스트리가
official 이 이름 붙인 플러그인을 조용히 대신 공급하는 일은 없습니다.

## 설치기 transaction

설치기는 완전한 Plugin·Sidecar 실행 closure 를 해석하고 host target 을 고르며 모든 크기와
SHA-256을 검증하고 regular file만 추출하며 manifest를 확인합니다. 모든 component를 stage한 뒤
component directory와 `environment.json`을 transaction 하나로 공개합니다. 실패하면 이전 environment와
component directory가 그대로 유지됩니다.

Sidecar manifest는 project-independent `processRole`과 canonical release process를 선언합니다.
Installer는 Core build의 `PROJECT`를 받아 staged process를 `<PROJECT>-<processRole>`로 rename하고
(Windows는 `.exe` 유지) 그 정확한 절대 file을 `environment.json`에 기록합니다. Canonical release
file은 두 번째 executable로 남기지 않습니다. Runtime resolution은 environment record만 실행하며
Sidecar id에서 이름을 재구성하거나 process 내부 display-name override를 사용하지 않습니다.

같은 id, version, target, 산출물 digest 는 멱등입니다. 내용 주소 디렉터리
`<home>/components/<kind>/<id>/<version>[/<target>]/<sha256>`가 이미 있으면 설치는 그 directory를
재사용하고 stage된 복사본을 폐기합니다. 같은 SHA-256은 같은 byte이며 directory는 atomic rename으로
공개되므로 이미 있는 directory는 완전합니다. 이 경우 실패하지 않습니다. 같은
id, version, target의 digest가 다르면 `VERSION_ARTIFACT_CONFLICT`로 실패하며 설치 byte를 덮어쓰지
않습니다. Local record는 자동 registry 교체 대상이 아닙니다. Registry update는 표시할 수 있지만 Local 선택을 바꾸려면 명시적인 registry
install transaction이 필요합니다.

설치기는 실행 중이거나 기록된 Sidecar를 종료하지 않습니다. 다른 Sidecar byte를 선택하려면 명시적
수명주기 연산이 필요합니다. Core는 update 를 끝내려고 사용자의 복구 가능한 프로세스를 종료하지
않습니다.

Frontend packaging에 native compile이 항상 필요한 것은 아닙니다. 각 frontend release owner가 entry에
build가 필요한지 선언합니다. build가 필요한 package는 선언된 명령과 산출물만 봉인하고, 정적이거나
이미 생성된 entry는 build 없이 package할 수 있습니다. 두 경로 모두 동일한 manifest·dependency·archive·
digest 검증과 불변 store 구조를 사용합니다. compile을 생략해도 source directory 실행 경로,
`file:`/`link:` locator, 변경 가능한 workspace 주입은 허용되지 않습니다.

설치된 Plugin 둘 이상이 공유 exact dependency를 새 버전으로 함께 옮겨야 하면 그 Plugin들은 하나의
transaction root 집합입니다. `plugin.install.local.batch.plan`은 명시한 store 하나에서 모든 root를
해결하고 component kind와 id마다 version 하나만 선택합니다. closure 둘이 서로 다른 version을 선택하면
plan digest를 계산하기 전에 충돌하는 모든 id, version, root와 함께 `DEPENDENCY_VERSION_CONFLICT`를
반환합니다. 또한 중복·충돌 release identity를 거부하고 정렬한 root 집합과 전체 합집합 closure를 hash합니다.
`plugin.install.local.batch`는 같은 plan을 다시 해결하고 서로 다른 Plugin과 Sidecar를 각각 한 번만
stage한 뒤 environment revision을 한 번 commit합니다. root를 하나씩 갱신하거나 `environment.json`을
직접 편집하거나 dependent Plugin을 잠시 제거하는 방식은 올바른 migration이 아닙니다.

batch installer는 stage 직전에 공개 `sidecar_status`를 읽습니다. 선택된 Sidecar가 `open` 또는 `recorded`에
있으면 요청 version과 실행 중 version, process, PID를 포함한 `SIDECAR_IN_USE`를 반환합니다. 실행 중인 이전
unit 위에 새 environment 선택을 기록하지 않고 unit을 암묵적으로 중지하지도 않습니다. 호출자가
`sidecar.stop`(호스트의 `sidecar_stop`)을 명시적으로 실행한 뒤 같은 plan digest로 다시 요청합니다. 설치 시 plan을 다시 해석하므로
plan과 설치 사이의 변경도 검사합니다.

## 개발 소스

개발 record는 Plugin 또는 Sidecar record와 같은 형식이며 `source`가 `development`입니다. `path`는
절대 경로이자 깨끗한 소스 디렉터리입니다. Plugin 디렉터리는 `plugin.json`과 manifest가 선언한
entry(entry `null`: entry file 없음)를 포함하고 Sidecar directory는 `sidecar.json`과 environment가
선언한 project-materialized process를 포함합니다. Entry 규칙은 `parseManifest`(`soksak-spec`, `packages/plugin-spec/src/spec.ts`)의
manifest 규칙과 같습니다. key가 없으면 `main.js`, `null`이면 entry file 없음(순수 contract Plugin),
문자열이면 trim한 뒤 비어 있지 않고 상대 경로(선행 separator 금지, drive letter 금지)이며 `..`
segment가 없고 `.js` 또는 `.mjs`로 끝나야 합니다. 그 외의 값은
`environment.develop.entryInvalid`로 거부합니다. 호스트가 path를 검증하고, entry가 `null`이 아닐 때만
entry file(regular file, path 구성 요소에 symlink 없음)을 검증하며, frontend는 사전 검증하지
않습니다. 상대 경로이거나 clean하지 않은 path는 `environment.develop.pathAbsolute`로 거부합니다.
manifest 는 operation당 한 번 읽고 parse하며 `id`, `version`, `entry`(Plugin) 또는
`process`(Sidecar)는 그 parse 하나에서 가져옵니다. manifest 를 읽거나 parse할 수 없거나 manifest가 다른 id를 선언하는 directory는
`environment.develop.directoryUnavailable`(`kind`, `id`, `path`, `error`)로 거부합니다. `error`는
`<file>: <os error 또는 parse error>` 또는 `<file> declares id <id>`이며, os error 또는 parse error는
단독으로는 호출자에게 반환되지 않습니다. `version`은
`plugin.develop` 또는 `sidecar.develop` 시점에 그 parse에서 복사하며 strict semver여야 합니다. `registry`와 `local`
record는 immutable이며 `version`은 artifact의 manifest와 같아야 합니다. `artifactSha256`은 존재하며
비어 있고 `registry`는 없습니다. 산출물은 없습니다. Sidecar record의 `target`은 host build OS와
아키텍처에서 도출한 host 산출물 target triple 이며 환경변수에서 가져오지 않습니다.
검증은 digest 또는 registry가 비어 있지 않은 `development` record를 거부합니다. `local`과
`registry` record의 validation은 변경 없으며 digest가 필요합니다.

record 의 effective version은 host 규칙 하나(`core/environment/manifest.go`의 `recordVersion`,
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
manifest 를 읽거나 parse할 수 없거나 manifest가 다른 id를 선언하는 개발 record는 broken입니다.
Effective version이 없고 어떤 dependent도 충족하지 않습니다. 그 effective version이 필요한 모든
operation은 `environment.develop.directoryUnavailable`(`kind`, `id`, `path`, `error`)로
거부합니다. `enabled`가 `true`인 `plugin_enabled_set`, broken consumer Plugin 또는 broken Sidecar에
대한 `sidecar_open`의 Sidecar resolution이 여기에 해당합니다. `enabled`가 `false`인
`plugin_enabled_set`은 effective version을 요구하지 않습니다. Broken 개발 Plugin은 effective version
없이 disable됩니다. Dependency invariant는 broken record를 dependent에 대해 없는 record로
취급합니다. 그 record를 요구하는 dependent는
`install.transaction.dependencyVersionConflict`(`requested`는 `missing`)로 거부하고, 어떤 dependent도
broken record를 요구하지 않으면 write는 진행합니다. 검증은 broken record의 identity 검사를
건너뜁니다. Core frontend는 같은 disk의 manifest로 runtime을 구성하고 그 version을 dependent의 `{id,
version}` requirement와 reload identity에 사용합니다.

`plugin_manifest_list`는 모든 record의 manifest를 다른 모든 operation이 사용하는 reader인
`readRecordManifest`로 읽습니다. manifest 를 읽거나 parse할 수 없거나 다른 id를 선언하는 record는
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
않으면 `absent`입니다. `error` 는 실행 오류 또는 `; ` 로 이은 거부 오류이며 없으면 생략합니다.
메시지는 상태를 적고 오류가 있으면 그 오류도 적습니다: `Plugin <id>의 development 레코드를
<path>로 기록했습니다; status disabled: <error>`. `sidecar.develop`은 `{ id, path, revision, version }`으로
응답하며 `version`은 host가 기록한 record의 version으로 write 뒤에 `environment_get`에서 읽습니다.
메시지는 `Sidecar <id>의 development 레코드를 <path>로 기록했습니다 (version <v>)`이며 영문 message와 같은
정보를 담습니다.
Status field는 없습니다. Write 전의 `SIDECAR_IN_USE` guard가 `open` 또는 `recorded`로 나열된 id를
거부하므로 write 뒤의 `sidecar_status` 읽기는 답이 하나입니다.

뷰의 제공자가 없는 pane 은 오버레이 하나를 그리며, 그 오버레이는 뷰 주소 아래의 노출된
node입니다(`ui.tree`가 `<view address>/node/<data-node>`로 나열하고 `data-*` attribute는 `dataset`에
있습니다). 오버레이는 제공자 컨테이너의 형제이며 뷰 주소를 `data-view-overlay-addr`에
선언합니다. 컨테이너만 `data-view-addr` 를 가지므로 `ui.slot` 은 뷰 주소 하나에
element 하나를 resolve합니다. Node collector의 scan root는 `.tab-viewer[data-view-addr]`와
`[data-view-overlay-addr]` 둘이며, 어느 쪽 안의 `data-node`든 그 root 의 뷰 주소 아래에
나열되고 chrome 으로는 나열되지 않습니다. 부팅이 ready가 되기 전의 node는 `plugin-view-loading`입니다. 부팅 뒤의 node는
`plugin-view-placeholder`이며 `data-view-plugin`(plugin id)과 `data-view-state`를 가집니다. Plugin이
설치되어 있고 disabled이면 `off`, 어떤 record도 그 id를 가지지 않으면 `absent`, manifest가 거부되었으면
`refused`이고 이때 `data-view-reason`이 `; `로 이은 거부 오류를 가집니다. 제공자의 mount 가
throw했으면 node는 `plugin-view-error`이며 `data-view-plugin`과 `data-view-error`(throw된 message)를
가집니다.

`plugin.remove`와 `sidecar.remove`가 유일한 제거 command입니다. 개발 record는 environment에서만
제거하며 소스 디렉터리는 삭제하지 않습니다. `local` 또는 `registry` record는 environment에서
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
environment write(compare-and-swap)를 수행합니다. 쓰기가 실패하면 directory 이름을 원래대로
되돌리고 거부합니다. 쓰기가 성공하면 `<dir>.removing`을 삭제합니다. 마지막 삭제의 실패는 오류가
아닙니다. 명령은 `{ previousRevision, revision, artifactDeleteFailed: { path, error } }`로
성공하며 `path`는 `.removing` path입니다. record 는 제거된 상태이고 `environment.changed`는
발행됩니다. Content-addressed path는 partial 상태가 되지 않으며, 그래서 설치가 그 path의 기존
directory를 재사용합니다.

Core frontend는 Plugin을 host 먼저 제거합니다. 현재 revision에서 `plugin_remove`를 호출하고, host가
수락한 뒤에만 memory의 instance를 enabled write 없이 비활성화하고 consent와 enabled 상태를 지우며
environment coordinator를 통해 revision을 한 번 reconcile합니다. 호스트가 거부하면 frontend는 아무것도
바꾸지 않습니다. Change의 `artifactDeleteFailed`는 성공입니다. Frontend는 path를 담은 activity
하나(Plugin store에서는 `plugin.remove.artifactLeft`, `sidecar.remove`에서는
`sidecar.remove.artifactLeft`)를 발행하고, consent를 지우며, cascade는 계속합니다.
`sidecar.develop`과 `sidecar.remove`는 `sidecar_status`가 그 id를 open 또는 recorded로 나열하면
`SIDECAR_IN_USE`로 거부합니다. `sidecar.install.local`과 같은 규칙이며 Core는 Sidecar를 종료하지
않습니다.

`plugin.reload {id}`는 `<path>/plugin.json`과 manifest가 선언한 entry를 다시 읽습니다. manifest와
entry bytes가 같으면 현재 runtime 세대를 유지합니다. bytes가 달라지면 `plugin_enabled_set`을 쓰지
않고 활성 세대를 교체하며, 비활성 record는 비활성 상태를 유지합니다.
`state.health.plugins.modules`가 graph 재사용과 교체를 보고합니다. `app.environment`의 `unitMode`는
개발 record에서 도출합니다.

## 거부

표는 host 명령마다 호출자가 environment 모듈에서 받을 수 있는 모든 오류를 나열합니다. 거부
key는 `core/environment`에 선언된 i18n key이며 아래의 `install.*` key도 거기에 선언되어 있습니다.
키가 없다고 표시한 오류는 그대로 반환됩니다. Go `os` 오류, `ErrRevisionConflict`, 그리고
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
| `plugin_develop` | Non-key `os.ErrNotExist`, `os.ErrInvalid`, 또는 그 밖의 `Lstat` error | entry 파일 검사, entry가 `null`이 아닐 때(없으면 `main.js`): entry 또는 그 path 구성 요소가 없음(`os.ErrNotExist`); 구성 요소가 symlink이거나 entry가 regular file이 아님(`os.ErrInvalid`); 그 밖의 `Lstat` 실패(그 os error). |
| `sidecar_develop` | Non-key `os.ErrNotExist`, `os.ErrInvalid`, 또는 그 밖의 `Lstat` error | manifest `process`(`dist/<id>`)의 process file 검사: process 또는 그 path 구성 요소가 없음(`os.ErrNotExist`); 구성 요소가 symlink이거나 process가 regular file이 아님(`os.ErrInvalid`); 그 밖의 `Lstat` 실패(그 os error). |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set`, `sidecar_open` | 키 없는 `environment.json` 읽기 또는 파싱 오류 | `environment.json`을 읽을 수 없거나(not-exist 외의 error), 내용을 `platformspec` parser 또는 validator가 거부함. `plugin_remove`, `sidecar_remove`, `plugin_enabled_set`에서는 첫 검사이고 `plugin_develop`과 `sidecar_develop`에서는 directory 검사 뒤. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set`, `sidecar_open` | Non-key `os.ErrNotExist` | `environment.json`이 없음. 위 row와 같은 위치. |
| `environment_get`, `plugin_manifest_list` | 키 없는 `environment.json` 읽기 또는 파싱 오류 | `environment.json`을 읽을 수 없거나(not-exist 외의 error), 내용을 `platformspec` parser 또는 validator가 거부함. 이 두 command의 유일한 거부. |
| `environment_get` | Non-key `os.ErrNotExist` | `environment.json`이 없음. `plugin_manifest_list`는 대신 빈 목록을 반환함. |
| `plugin_manifest_list` | 없음. record 의 `error` | manifest 를 읽거나 parse할 수 없거나 다른 id를 선언하는 record는 `manifest`가 `null`이고 `error`가 `readRecordManifest`의 `environment.develop.directoryUnavailable` 문장(`development`) 또는 `install.transaction.pluginManifestInvalid` 문장(`registry`, `local`)으로 나열됨. 거부가 아니며 raw os 문자열도 아님. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.notFound`(`kind`, `id`) | `id`의 record가 없음. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.pathOutsideHome`(`path`, `home`) | 개발 record가 아닌 record의 `path`가 `<home>/components/`의 strict descendant가 아니거나, 그 `<dir>`이 해석된 components root의 strict descendant가 아님. 두 번째 경우 `path`는 `<dir>`. record 는 유지. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.pathSymlink`(`path`, `link`) | Components root 아래의 path 구성 요소가, leaf를 포함하여, symlink임. record 는 유지. |
| `plugin_remove`, `sidecar_remove` | 경로 검사의 키 없는 os 오류 | Path 구성 요소의 `Lstat`, 또는 parent나 components root의 `EvalSymlinks`가 not-exist 외의 error로 실패함. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove` | `install.transaction.pluginManifestInvalid`(`plugin`) | 결과 environment의 dependency validation: `registry` 또는 `local` Plugin record의 `plugin.json`이 없거나, 읽거나 parse할 수 없거나, record의 id와 version을 선언하지 않음. `plugin_remove`와 `sidecar_remove`에서는 path 검사 뒤, 어떤 file 작업보다 먼저. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove` | `install.transaction.dependencyVersionConflict`(`plugin`, `kind`, `dependency`, `required`, `requested`) | 결과 environment의 dependency validation: Plugin manifest의 `runtimeDependencies` 항목에 정확히 그 version의 record가 없음. `plugin_remove`와 `sidecar_remove`에서는 남은 Plugin이 제거된 record를 요구함. 없거나 broken인 record는 `requested`가 `missing`, 그 밖에는 찾은 effective version. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.artifactDeleteFailed`(`path`, `error`) | Rename 전의 `RemoveAll(<dir>.removing)`이 실패함. `path`는 `<dir>.removing`. 아무것도 바뀌지 않음. 마지막 삭제의 실패는 거부가 아니라 result의 data. |
| `plugin_remove`, `sidecar_remove` | rename 의 키 없는 os 오류 | `Lstat(<dir>)`이 not-exist 외의 error로 실패했거나 `<dir>`에서 `<dir>.removing`으로의 rename이 실패함. |
| `plugin_enabled_set` | Non-key `os.ErrInvalid` | `id` 또는 `version`이 빈 ref, 또는 `plugins`에 같은 `id`가 두 번 있음. |
| `plugin_enabled_set` | Non-key `os.ErrNotExist` | Ref `id`의 record가 없거나 ref `version`이 effective version(`registry`와 `local`은 record의 `version`, `development`는 지금 읽은 manifest version)과 다름. `enabled`가 `false`인 broken 개발 record는 version 검사를 건너뜀. |
| `plugin_enabled_set` | `environment.develop.directoryUnavailable`(`kind` `plugin`, `id`, `path`, `error`) | `enabled`가 `true`이고 개발 Plugin의 `plugin.json`이 없거나, 읽거나 parse할 수 없거나, 다른 id를 선언함. 그 record에 `enabled` `false`는 성공함. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | Non-key `ErrRevisionConflict`(`Expected`, `Actual`) | `expectedRevision`이 현재 revision과 다름. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | Non-key `platformspec` validation error | `Validate`가 결과 environment를 거부함. 예: 개발 `plugin.json`의 `version`이 strict SemVer가 아닐 때 `plugin <id>: component requires exact version and absolute path`. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | `environment.home.absolute` | Environment home이 절대 경로가 아님. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | publish 의 키 없는 os error | `environment.json`을 publish하는 동안 `MkdirAll`, `WriteFile`, 또는 `Rename`이 실패함. |
| `sidecar_open`(Sidecar resolution) | Non-key `os.ErrNotExist` | Consumer Plugin 또는 Sidecar id의 record가 없거나 요청된 version이 effective version과 다름. |
| `sidecar_open`(Sidecar resolution) | `environment.develop.directoryUnavailable`(`kind`, `id`, `path`, `error`) | Consumer Plugin record 또는 Sidecar record가 broken 개발 record임. |
| `sidecar_open`(Sidecar resolution) | Non-key `os.ErrInvalid` | `registry` 또는 `local` Sidecar record의 `sidecar.json`이 없거나, 읽을 수 없거나, spec parser가 거부하거나, record의 id와 version을 선언하지 않음. |
| `sidecar_open`(Sidecar resolution) | Non-key `os.ErrNotExist`, `os.ErrInvalid`, 또는 그 밖의 `Lstat` error | `sidecar_develop`과 같은 `dist/<id>`의 process file 검사. |

`plugin_remove`와 `sidecar_remove`는 위 write row 넷의 어떤 error를 반환하기 전에도
`<dir>.removing`을 `<dir>`로 되돌립니다. 그 rename 이 실패하면 오류는 `errors.Join(write error,
rename error)`입니다. `plugin_enabled_set`은 의존 검증을 하지 않습니다. enabled
상태는 dependency invariant의 일부가 아닙니다.

## 명령과 이벤트

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
- `artifact_install_status`, `artifact_install_wait`: 이벤트 기반 진행 공개
- `artifact.install.progress`: phase 변경, `environment.changed`: commit된 revision 하나

`source_set`, raw-path install, compatibility reader, fallback transport, install profile, 저장된 dependency
closure, 두 번째 installer는 존재하지 않습니다.
