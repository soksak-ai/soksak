---
kind: translation
status: active
canonical: ./COMPONENT-OWNERSHIP.md
---

# 컴포넌트 소유와 공통 표준

## 직접적인 컴포넌트 종류

플랫폼은 plugin, sidecar, kit, contract, spec 을 그 이름을 직접 씁니다. 일반화된 unit, 컴포넌트
종류, `{kind,id,version}` 식별자는 없습니다. 명령, 설정, registry 기록, 릴리즈 문서, 상태, 오류는
직접적인 종류 이름을 사용합니다.

## 소유 구분

- `soksak-spec` 이 공개 플랫폼 JSON Schema, 파서, 정본 fixture, validator CLI 동작, 소유자 릴리즈
  템플릿의 유일한 출처입니다.
- `soksak-contract-*` 는 둘 이상의 저장소가 실제로 공유하는 도메인 프로토콜만 소유합니다. 플랫폼
  릴리즈나 registry 문법의 두 번째 출처가 아닙니다.
- `soksak-kit-*` 는 재사용 구현 코드를 소유합니다. kit 은 공개 계약 문법을 소유하지 않습니다.
- plugin, sidecar, kit, contract, spec 저장소는 자기 구현, 직접 manifest, 테스트, 라이선스, 정확한
  의존 선언을 소유합니다.
- 코어는 공개 spec 패키지를 그대로 소비합니다. release, registry, conformance, plugin, sidecar,
  kit, contract, spec 파서를 복사하지 않습니다.

## Schema 메타데이터와 payload 식별자

JSON Schema 파일이 `$schema` 와 `$id` 를 소유합니다. payload 는 자기 schema 식별자를 되풀이하지
않습니다. `spec` 은 설치된 spec 식별 객체용으로 예약합니다. `protocol` 은 런타임 framing 용으로
예약합니다. `format` 은 `tar.gz`, `tgz` 같은 직렬화 형식용으로 예약합니다.

## 릴리즈와 registry

릴리즈에는 plugin·sidecar·kit·contract·spec 식별자 정확히 하나, 그 불변 소스 commit, artifact 바이트
크기와 digest, conformance 보고서가 들어갑니다. 릴리즈 문서에는 의존 범위나 provider 선택이 없습니다.
registry 문서는 현재 Plugin 루트를 나열합니다. Plugin 릴리즈 참조가 정확한 Plugin·Sidecar 런타임
closure 를 공개하고, 빌드 receipt 가 Kit·Contract·Spec 입력을 공개합니다. registry 에는 설치
프로파일이나 저장된 closure 가 없습니다.

## Environment

`environment.json` 이 유일한 런타임 컴포넌트 상태입니다. 정확한 Plugin·Sidecar 버전, 실체화된 절대
경로, artifact SHA-256 값, 소스 종류, registry ID, Sidecar target, Plugin 활성화를 기록합니다.
Plugin 릴리즈가 정확한 런타임 의존 참조를 소유하며, environment 는 역할 결합을 저장하지 않습니다.
릴리즈 문서와 빌드 receipt 가 Kit·Contract·Spec 입력의 저장소, 소스 commit, 의존 선언, URL, 크기,
digest 를 소유합니다.

공개 unit, 의존 범위, 설치 프로파일, 의존 closure, 구성 그래프, 실행 그래프, 배포 그래프는 없습니다.
검증은 임시 로컬 자료구조를 쓸 수 있지만 그것을 또 하나의 계약으로 저장하지 않습니다.

## 변경 규율

- 호환 리더, 별칭, 마이그레이션, 대체 필드, 옛 경로를 남기지 않습니다.
- 공개 구분이 바뀌면 schema, 파서, 정본 corpus, validator, 소유자 템플릿, 소비자 테스트, 문서를 한
  번의 검증된 순서로 갱신합니다.
- 테스트는 최종 규칙에 대해 RED 로 시작합니다. 실패한 구현은 규칙을 약화하지 않고 고칩니다.
- 코드 주석과 Git 메시지는 간결한 영어로 씁니다. 사용자에게 보이는 한국어와 영어 메시지는 같은 정보를
  담습니다.
