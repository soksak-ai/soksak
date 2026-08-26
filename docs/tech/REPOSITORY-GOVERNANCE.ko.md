---
kind: translation
status: active
canonical: ./REPOSITORY-GOVERNANCE.md
---

# 저장소 거버넌스

## G1. 로컬 소스가 정본이다

정본 workspace 체크아웃의 활성 소스가 현재 제품을 정의합니다. 과거 GitHub branch, tag, release,
프레임워크 구현이 그것에 호환성을 강요하지 않습니다. 현재 계약은 자기 정본 형태만 받아들입니다.

## G2. 독립 저장소

독립적으로 소유되는 제품 저장소에는 개발 라인이 하나, main 입니다. 모든 변경 branch 는 patch 단위로
감사하고 소유자의 게이트로 검증한 뒤, main 으로 fast-forward 하거나 이유와 함께 거부합니다. 병합된
branch 는 그 tip 이 main 에서 도달 가능해진 뒤에만 삭제합니다. 독립적으로 릴리즈되는 라이브러리는,
그 branch 가 완료된 변경 branch 가 아니라 지원 중인 소스 라인일 때 버전 유지 branch 를 유지할 수
있습니다. 이름에 라이브러리 버전을 포함하고, tip 은 영구적인 로컬·원격 ref 에서 도달 가능하게
유지합니다.

## G3. Fork

fork 는 upstream 동기화를 위해 upstream 기본 branch 를 유지합니다. soksak 개선은 별도 branch 에
남기며, branch 목록을 단순히 정리하려고 그 기본 branch 에 병합하지 않습니다. branch 이름에는
upstream 컴포넌트 버전을 포함하고, upstream 이 버전을 게시하지 않으면 정확한 소스 commit 을
포함합니다. 소비자는 정확한 개선 commit 을 고정합니다. upstream 버전이 바뀌면 새로 검증한 개선
라인을 만들고, upstream 으로 보낼 수 있는 변경은 upstream 에 제안합니다.

## G4. 과거 저장소

퇴역한 프레임워크 구현은 소스 이력이지 릴리즈 대상이 아닙니다. 그 저장소는 보관 상태이며, 기존
commit·개선 branch·tag·release 는 계속 읽을 수 있습니다. Actions 를 실행하지 않고 새 tag, release,
호환 patch, 마이그레이션을 추가하지 않습니다. 현재 제품은 그것을 설치 가능 대상으로 등록하지
않습니다.

## G5. 소스 유실 없음

branch, 저장소 이름, worktree 를 제거하기 전에 모든 tip 에는 영구 보존 ref 가 있어야 합니다. 정본
branch, 버전이 붙은 fork 개선 branch, 과거 저장소 branch, 또는 릴리즈가 아닌 archive/ tag 입니다.
patch 동등성은, 정확한 소스 tip 이 다른 곳에 보존되어 있거나 archive/ ref 로 의도적으로 기록된
경우에만 중복 branch 삭제를 허용합니다. 제품 릴리즈 워크플로는 v* 에서만 실행되며, archive/ tag 는
제품을 게시하지 않습니다.

## G6. 표준은 구현에 맞추어 움직이지 않는다

게이트가 실패하면 구현, fixture, 의존, 자동화를 고칩니다. 실패를 통과시키려고 기준을 약화하지
않습니다. 기준 자체가 틀렸다는 증거가 있으면 먼저 그 충돌을 보고하고, 문서와 그 RED 를 함께 바꾼
뒤에 구현을 재개합니다.
