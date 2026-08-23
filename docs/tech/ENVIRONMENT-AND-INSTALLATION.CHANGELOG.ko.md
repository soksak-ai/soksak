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
절대 경로, source 종류, activation, target, plugin-to-sidecar role binding이 들어갑니다. 설치는 byte를
먼저 stage하고 component directory와 environment를 하나의 transaction으로 교체합니다. 실패하면 이전
environment가 유지됩니다.

Registry는 원격 provenance와 immutable release metadata를 소유합니다. 로컬 environment는 이 설치가
선택한 내용과 검증된 byte의 위치만 기록합니다.

## 검증

Environment contract gate는 active code와 현재 정본에서 폐기된 파일명과 command를 거부합니다.
Transaction test는 설치 실패가 partial environment를 공개하지 못하게 합니다.

## 가상의 첫 revision이 실패한 이유

첫 구현은 `environment.json`이 없을 때 memory의 revision 1을 반환했지만 compare-and-swap은 저장된
revision을 올바르게 0으로 보았습니다. 따라서 첫 설치는 `expected 1, actual 0`으로 실패할 수밖에
없었습니다. 이제 Core가 identity home을 소유한 뒤 실제 revision 1을 공개합니다. 조회와 write가
하나의 상태를 사용하며 파일 부재에 두 의미를 부여하지 않습니다.
