# 릴리스 무결성

이 문서는 플러그인, 사이드카, 킷의 릴리스 및 설치 불변식을 정의한다. 컴포넌트 저장소는
소스 매니페스트를 소유한다. `soksak-spec`은 정식 릴리스 검증기를 소유한다. 레지스트리는
검증된 릴리스 메타데이터를 저장한다. 코어는 provider 이름을 알지 않고 릴리스 바이트를 설치하고 검증한다.

## 하나의 식별자 정본

- `plugin.json`, `sidecar.json`, `kit.json`만 컴포넌트 ID와 버전의 정본이다.
- 빌드 스크립트는 사이드카 process에 `.exe`를 추가하는 것처럼 target별 필드만 생성할 수 있다.
- 빌드 스크립트와 workflow는 ID, 버전, 인터페이스, archive 버전, tag를 중복 선언하지 않는다.
- archive 이름, tag, conformance subject, `release.json` 식별자는 소스 매니페스트에서 파생한다.

## 두 지점에서 모두 검증

발행과 설치는 같은 식별자를 강제하며 어느 쪽도 다른 지점을 신뢰하지 않는다.

1. 정식 발행자는 tag 생성 전에 모든 archive 의 manifest ID, 버전, 인터페이스, 프로세스 경로,
   target 실행 파일, digest, 크기, 안전한 일반 파일 목록을 검증한다.
2. 코어는 다운로드한 digest와 크기를 검증하고 일반 파일만 추출한다. 컴포넌트 kind에 맞는 정식
   manifest 이름을 요구하고 staging 전에 manifest ID와 버전을 registry 식별자와 비교한다.
3. commit은 staging된 식별자와 digest가 승인된 설치 요청과 계속 같은지 검증한다.
4. Core는 Go native crypto 구현으로 registry Ed25519 서명, currentness, high-water continuity를
   검증한다. Renderer engine은 공개 형식을 parse하지만 암호학적 trust를 소유하지 않는다.

잘못된 바이트가 포함된 immutable release는 덮어쓰거나 마이그레이션하지 않는다. registry에
등록하지 않으며, 책임 구분에 RED 테스트와 GREEN 수정이 생긴 뒤 새 patch 버전을 발행한다.

## 실행 전 조건

- CI action, SDK 소스, 재사용 워크플로는 정확한 commit 또는 버전을 쓴다. 빌드 도구
  version 소유권, 발견, 업그레이드는 `BUILD-TOOLCHAIN.ko.md`를 따른다.
- text source와 module checksum 파일은 모든 host에서 LF로 checkout한다. 플랫폼별 checkout
  변환 때문에 소스 무결성 검사가 거짓 module 변경을 보고해서는 안 된다.
- renderer command가 제한 시간이 있는 native 작업을 위임하면 바깥 제한 시간은 native 제한보다
  길어야 한다. Native 작업이 살아 있는 동안 transport가 renderer 무응답을 보고하지 않는다.
- native system test는 시작 전에 application과 control client가 host OS용인지 검증한다. Apple
  Silicon macOS는 arm64와 amd64를 모두 실행할 수 있다. 다른 architecture 조합은 명시적 지원이 없으면 거부한다.
- 제품 빌드와 native test는 같은 최소 deployment target을 사용한다.
- 로컬 계약 테스트, 크로스 컴파일 확인, 릴리즈 바이트 검증이 통과한 뒤에만 릴리즈나 시스템 테스트를 실행한다.
- macOS Docker 사전 검증은 Windows 빌드 입력, PE 바이너리, 릴리즈 바이트, manifest, 설치 상태를
  검증한다. Windows runtime 성공을 주장하지 않는다. WebView2, ConPTY, named pipe, Windows
  창 동작은 GitHub `windows-2025` runner에서만 판정한다.
- 터미널 크기 변경 실패는 DOM pixel, 요청 크기, PTY 관측, 복원 관측, 렌더된 frame 중
  처음 진행하지 않은 지점을 기록한다. 일반 timeout만으로는 완료 근거가 되지 않는다.
- toolchain 설치나 다중 target 빌드 전에 디스크 용량을 확인한다. 다시 만들 수 있는 캐시와 빌드
  산출물만 명시적으로 정리하며 소스 파일과 사용자 데이터는 용량 확보에 쓰지 않는다.
- 명시적 sidecar stop은 adopt된 process가 종료된 뒤 반환한다. Application shutdown은 stop이 아니라
  release이며 두 lifecycle 의미를 분리한다.

## 저장소별 소유권

- 컴포넌트 저장소는 소스 manifest, staging 반영본, target 매트릭스, 릴리즈 워크플로를 검사한다.
- `soksak-spec` 은 모든 컴포넌트 종류의 archive 파싱과 릴리즈 identity 를 검사한다.
- 코어는 installation identity, host binary compatibility, atomic environment publication을 검사한다.
- 외부 터미널 테스트 저장소는 발행된 fleet 전체를 black-box 조합으로 검증한다.
- registry 에는 계약을 통과한 불변 릴리즈 문서만 넣는다. 실패한 릴리즈 버전은 목록 항목이 아니다.
- 플러그인과 사이드카는 runtime 설치 아티팩트다. 킷은 재사용 구현 소스를 배포하며 명시적으로
  요청한 경우에만 설치한다. 플러그인의 runtime 의존성으로 추론하지 않는다. contract와 spec
  release는 검증 입력이며 runtime 설치 디렉터리에 복사하지 않는다.
