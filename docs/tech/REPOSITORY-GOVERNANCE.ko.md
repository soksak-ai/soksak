---
kind: translation
status: active
canonical: ./REPOSITORY-GOVERNANCE.md
---

# 저장소 거버넌스

## G1. 로컬 소스가 정본이다

정본 workspace 체크아웃의 활성 소스가 현재 제품을 정의합니다. 과거 ref, release, 일시정지 component는
현재 계약을 변경하지 않습니다. 현재 계약은 자기 정본 형태만 받아들입니다.

## G2. 독립 저장소

독립적으로 소유되는 제품 저장소에는 개발 라인이 하나, main 입니다. 모든 변경 branch 는 patch 단위로
감사하고 소유자의 검사로 검증한 뒤, main 으로 fast-forward 하거나 이유와 함께 거부합니다. 병합된
branch 는 그 tip 이 main 에서 도달 가능해진 뒤에만 삭제합니다. 독립적으로 릴리즈되는 라이브러리는,
그 branch 가 완료된 변경 branch 가 아니라 지원 중인 소스 라인일 때 버전 유지 branch 를 유지할 수
있습니다. 이름에 라이브러리 버전을 포함하고, tip 은 영구적인 로컬·원격 ref 에서 도달 가능하게
유지합니다.

## G3. Version product line

각 독립 release component는 지원하는 각 version에 하나의 source line을 선언합니다. Version은
manifest와 release artifact에 기록합니다. 소비자는 environment manifest로 version을 선택하며 새
release는 설치된 environment를 변경하지 않습니다.

## G4. 일시정지 저장소

일시정지 component는 source와 기존 release artifact를 읽을 수 있습니다. 일시정지 중에는 source
변경, release, 호환 patch, migration을 추가하지 않습니다. 현재 제품은 일시정지 component를 설치
가능 대상으로 등록하지 않습니다.

## G5. 소스 유실 없음

branch, 저장소 이름, worktree 를 제거하기 전에 모든 tip 에는 영구 보존 ref 가 있어야 합니다. 정본
branch, 지원 version branch, 또는 보존 historical ref가 그 대상입니다. 정확한 source tip이 다른
곳에 보존되었거나 release가 아닌 ref로 기록된 경우에만 중복 branch 삭제를 허용합니다. 제품 release
workflow는 선언된 release tag에서만 실행합니다.

## G6. 표준은 구현에 맞추어 움직이지 않는다

검사가 실패하면 구현, fixture, 의존, 자동화를 고칩니다. 실패를 통과시키려고 기준을 약화하지
않습니다. 기준 자체가 틀렸다는 증거가 있으면 먼저 그 충돌을 보고하고, 문서와 그 RED 를 함께 바꾼
뒤에 구현을 재개합니다.
