---
kind: translation
status: active
canonical: docs/README.md
---

# 문서 목록

이 문서는 [영어 정본](./README.md)의 한국어 번역입니다. 독립적인 규칙을 정의하지 않습니다.

## 구조

```text
docs/
├── README.md              문서 목록
├── tech/                  기술 계약
├── manual/                작업 절차
└── design-flow documents  사람이 읽는 설계 판단 흐름
```

## Front matter

모든 문서는 `kind`, `status`, `canonical`을 선언합니다. 영어 정본은 현재 계약을 과거 이력
없이 이해할 수 있어야 합니다. 중요한 계약 전환은 `kind: changelog` 문서가 문제, 판단,
결과, 검증 순서로 설명합니다. Git은 정확한 commit과 diff를 보존하고, changelog는 사람이
판단 흐름을 이해하도록 돕습니다.

한국어 번역은 대응하는 `.ko.md` 파일이며 `kind: translation`과 영어 정본 경로를 선언합니다.
번역은 별도 규칙을 만들 수 없습니다.

## 언어

영어 문서가 정본입니다. 독자용 문서는 한국어 번역을 제공할 수 있습니다. 코드 주석, commit,
식별자, 로그, 오류 코드, 테스트 이름, API 필드는 영어를 사용합니다. 코드 안의 한국어는 `ko`
resource 값에만 존재합니다.

## 문서에 들어갈 내용

문서는 계약과 그 계약의 기술적 이유를 담습니다. Schema가 존재하면 schema가 단일 정본이며,
문서는 schema가 강제할 수 없는 이유만 설명합니다. 현재 계약 문서는 폐기된 경로나 과거 구현을
이해해야만 읽을 수 있는 형태여서는 안 됩니다. 설계 변화가 계속 참고할 가치가 있으면 대응
changelog에 기록합니다.

제목과 본문은 하나의 주장입니다. 서로 다르면 코드와 검증 결과를 확인해 둘 중 잘못된 쪽을
고칩니다. 규칙에는 반드시 실패할 수 있는 gate가 있어야 합니다.

## 주요 문서

| 문서 | 내용 |
| --- | --- |
| `GATES.md` | G0–G5 완료 기준과 판정 명령 |
| `GATES.CHANGELOG.md` | Installed-product gate 소유권과 stale no-op target 제거 흐름 |
| `ARCHITECTURE.md` | Core 소유권, plugin 경계, C1–C6 |
| `ARCHITECTURE.CHANGELOG.md` | Domain 기능이 Core에서 분리된 이유 |
| `NAMING.md` | 공개 식별자와 vocabulary |
| `NATIVE-LAYER.md` | Native 계층과 플랫폼 경계 |
| `NATIVE-SURFACES.md` | Native surface 선언과 적용 검증 |
| `RESTORE.md` | Restart 후 복원 계약 |
| `RESTORE.CHANGELOG.md` | 잘못된 record를 보정하지 않는 이유 |
| `SIDEBAR.md` | Sidebar, rail, workspace 배치 계약 |
| `SIDEBAR.CHANGELOG.md` | Surface와 placement를 분리한 이유 |
| `REPO-LAYOUT.md` | Repository 내부 책임 배치 |
| `REPOSITORY-GOVERNANCE.md` | Branch, fork, archive, source 보존 규칙 |
| `IDENTITY.md` | Home, socket, CLI identity |
| `ENVIRONMENT-AND-INSTALLATION.md` | Component environment와 installer |
| `ENVIRONMENT-AND-INSTALLATION.CHANGELOG.md` | 두 상태 파일을 하나로 합친 이유 |
| `CONTROL-PROTOCOL.md` | Control envelope와 version negotiation |
| `CONTROL-PROTOCOL.CHANGELOG.md` | 하나의 응답 envelope가 필요한 이유 |
| `COMMAND-LINE.md` | 공개 CLI command 형식 |
| `TERMINAL-UX-HANDOFF.ko.md` | 해결되지 않은 터미널 UX 결함, workspace 소유권 지도, 확인된 기준점 |
| `TERMINAL-UX-EXECUTION.ko.md` | Renderer parity, view visibility, native close, test isolation의 필수 RED-to-GREEN 순서 |
| `MESSAGE-PROTOCOL.md` | Request, response, progress 상관관계 |
| `SIDECARS.md` | Sidecar 배포, 선택, lifetime |
| `PLUGIN-CONTRACT.md` | Plugin 선언과 계약 소유권 |
| `I18N.md` | 사용자 문장의 소유권과 번역 |
| `UI-GEOMETRY.md` | Layout 및 border 소유권 |
| `manual/TESTING.md` | RED→GREEN과 gate 실행 |
| `manual/EVIDENCE.md` | 수치·capture 증거 규칙 |
| `manual/AGENT-CONTROL.md` | 외부 제어와 공개 상태면 |
| `manual/DEVELOPMENT.md` | 변경, 되돌림, commit 절차 |

저장소 작업 규칙의 정본은 `../AGENTS.md`입니다.
