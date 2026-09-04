---
kind: translation
status: active
canonical: ./PLUGIN-CONTRACT.md
---

# 플러그인 계약

## 소유

`soksak-spec` 이 공개 플러그인 manifest, release, registry, conformance, settings, 설치 상태 문법을
소유합니다. `build/soksak-spec.json` 은 정확한 Spec 릴리즈 하나를 선택합니다. 코어는 그 릴리즈를
`@soksak/soksak-spec` 패키지와 Go `platformspec` 모듈로 소비합니다. 파서 사본이나 다른 패키지명을
갖지 않습니다.

규범적 버전 규칙과 예시는 `soksak-ai/soksak-spec` 릴리즈에 있습니다.

## Manifest

모든 플러그인은 정확한 릴리즈 버전과 애플리케이션 요구사항을 선언합니다.

~~~json
{
  "id": "example-plugin",
  "version": "0.0.1",
  "appVersionRequirement": "0.0.1"
}
~~~

provider 는 정확한 `{id, version}` interface 를 선언합니다. consumer 는 `{id, requirement}` 를
선언합니다. manifest 는 schema 판별자를 되풀이하지 않고 provider 저장소를 선택하지 않습니다.

view 는 `surfaces: ["tab"]`, `surfaces: ["side"]`, 또는 둘 다를 선언합니다. 배치는 호스트가
소유합니다. 알 수 없는 필드는 매핑하지 않고 거부합니다.

## 코어가 소유하는 계약

`frontend/src/plugins/contract.json` 에는 Doctor 가 소비하는 코어 테마 변수와 어휘만 들어 있습니다.
플러그인 ID, 권한, manifest 필드는 `soksak-spec` 에서 옵니다. 그것을 테마 계약으로 복사하면 출처가
하나 더 생깁니다.

## 런타임 강제

- 불투명 플러그인 런타임과 capability broker 가 격리를 제공합니다.
- manifest 권한은 동의 선언이자 broker 허용 목록입니다.
- 로더 활성화는 정본 패키지를 통해 `appVersionRequirement`, 권한, 명령, view, 노드, interface
  요구사항을 검사합니다.
- 플러그인, 사이드카, 코어는 명령·이벤트·상태·버전이 있는 interface 로 통신합니다. 서로의 내부
  파일이나 DOM 을 읽지 않습니다.

## 실패 보고

Plugin 은 renderer 에서 실행됩니다. 코어는 renderer 콘솔 출력을 수집하지 않고, `activity` 는 실행된
명령을 기록하며 실행 전에 거부된 명령은 기록하지 않습니다. 따라서 보고 없이 실패한 Plugin 은 기록 없이
실패합니다.

기록이 남지 않는 두 형태:

- 없는 협력자에 대한 선택적 호출. `a` 가 undefined 인 `a?.b()` 는 아무것도 수행하지 않고 예외도
  발생시키지 않습니다.
- 값으로 반환되는 거부. `commands.execute` 는 예외 대신 `{ok:false}` 를 반환하므로, 예외만 처리하는
  호출자는 거부를 성공으로 처리합니다.

요구사항:

- 기능을 수행할 수 없는 컴포넌트는 감지 지점에서 한 번 그 사실을 보고합니다.
- `commands.execute` 호출자는 `ok` 를 읽고 false 이면 보고합니다.
- 처리되지 않은 Plugin 오류와 거부된 Plugin 명령은 Plugin 을 다시 빌드하지 않고 읽을 수 있는 한 위치에
  도달합니다.

2026-09-04 측정: Plugin 이 코어 index 에 session 을 쓰지 않았습니다. 경로의 모든 요소가 설치된 번들에
있었고 모든 권한 검사를 통과했습니다. 원인을 찾으려면 로그 문장을 추가해 Plugin 을 다시 빌드해야 했습니다.

## File drop grant

운영체제 drop은 Core에 path로 들어오지만 Plugin event에는 불투명 grant ID와 민감하지 않은 kind만
전달됩니다. Grant는 Plugin 하나와 window 하나에 묶이고 한 번만 redeem할 수 있으며, 올바른 소유자가
성공적으로 redeem했을 때만 제거됩니다. Core는 허용된 raw `path`를 반환할 뿐 그것을 shell text,
editor 입력, image protocol 또는 다른 domain command로 해석하지 않습니다.

그 해석은 소비 Plugin 또는 domain Kit이 소유합니다. Terminal Kit은 `app.environment`에서 선언된
login shell을 읽고 명시적으로 지원하는 shell family 하나의 문법으로 grant path를 quote하며 알 수
없는 family는 거부합니다. Command는 raw path를 grant 대신 전달할 수 없습니다. File path 입력과
inline image payload는 별도 capability이며 서로 fallback하지 않습니다.

## 검증

- `soksak-spec` 이 전체 manifest 와 wire 문법을 테스트합니다.
- 코어 facade 테스트가 정확한 패키지를 사용하는지, 알 수 없는 필드를 거부하는지 증명합니다.
- `permissionBacking.test.ts` 는 모든 공개 권한이 실제 capability 를 통제하도록 요구합니다.
- `dropGrants.test.ts` 는 소비자 의미 없이 불투명하고 소유자에 묶인 일회용 redemption을 증명합니다.
- 플러그인 저장소는 자기 manifest, 구현, 번역, 릴리즈 artifact 를 테스트합니다.
