# 릴리스 무결성

이 문서는 플러그인, 사이드카, 킷의 릴리스 및 설치 불변식을 정의한다. 컴포넌트 저장소는
소스 매니페스트를 소유한다. `soksak-spec`은 정식 릴리스 검증기를 소유한다. 레지스트리는
검증된 릴리스 메타데이터를 저장한다. 코어는 provider 이름을 알지 않고 릴리스 바이트를 설치하고 검증한다.

## 하나의 식별자 정본

- `plugin.json`, `sidecar.json`, `kit.json`만 컴포넌트 ID와 버전의 정본이다.
- 빌드 스크립트는 사이드카 process에 `.exe`를 추가하는 것처럼 target별 필드만 투영할 수 있다.
- 빌드 스크립트와 workflow는 ID, 버전, 인터페이스, archive 버전, tag를 중복 선언하지 않는다.
- archive 이름, tag, conformance subject, `release.json` 식별자는 소스 매니페스트에서 파생한다.

## 두 경계에서 모두 검증

발행과 설치는 같은 식별자를 강제하며 어느 쪽도 다른 경계를 신뢰하지 않는다.

1. 정식 publisher는 tag 생성 전에 모든 archive의 manifest ID, 버전, 인터페이스, process 경로,
   target 실행 파일, digest, 크기, 안전한 일반 파일 목록을 검증한다.
2. 코어는 다운로드한 digest와 크기를 검증하고 일반 파일만 추출한다. 컴포넌트 kind에 맞는 정식
   manifest 이름을 요구하고 staging 전에 manifest ID와 버전을 registry 식별자와 비교한다.
3. commit은 staging된 식별자와 digest가 승인된 설치 요청과 계속 같은지 검증한다.

잘못된 바이트가 포함된 immutable release는 덮어쓰거나 마이그레이션하지 않는다. registry에
등록하지 않으며, 책임 경계에 RED 테스트와 GREEN 수정이 생긴 뒤 새 patch 버전을 발행한다.

## 실행 전 조건

- CI action, 언어 toolchain, SDK source, 재사용 workflow는 정확한 commit 또는 버전을 사용한다.
- native system test는 시작 전에 application과 control client가 host OS용인지 검증한다. Apple
  Silicon macOS는 arm64와 amd64를 모두 실행할 수 있다. 다른 architecture 조합은 명시적 지원이 없으면 거부한다.
- 제품 빌드와 native test는 같은 최소 deployment target을 사용한다.
- local contract test, cross-compilation 검사, release-byte 검증이 통과한 뒤에만 release 또는 system-test를 실행한다.
- toolchain 설치나 multi-target build 전에 디스크 용량을 확인한다. 재생성 가능한 cache와 build
  output만 명시적으로 정리하며 source file과 사용자 데이터는 용량 확보에 사용하지 않는다.

## 저장소별 소유권

- 컴포넌트 저장소는 source manifest, staging projection, target matrix, release workflow를 검사한다.
- `soksak-spec`은 모든 component kind의 archive parsing과 release identity를 검사한다.
- 코어는 installation identity, host binary compatibility, installed settings publication을 검사한다.
- 외부 terminal test 저장소는 발행된 전체 fleet를 black-box composition으로 검증한다.
- registry에는 contract를 통과한 immutable release document만 포함한다. 실패한 release 버전은 catalogue entry가 아니다.
- 플러그인과 사이드카는 runtime 설치 아티팩트다. 킷은 재사용 구현 소스를 배포하며 명시적으로
  요청한 경우에만 설치한다. 플러그인의 runtime 의존성으로 추론하지 않는다. contract와 spec
  release는 검증 입력이며 runtime 설치 디렉터리에 복사하지 않는다.
