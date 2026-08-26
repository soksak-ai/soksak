---
kind: translation
status: historical
canonical: docs/tech/ARCHITECTURE.CHANGELOG.md
---

# Architecture 설계 흐름

이 문서는 [영어 흐름 문서](./ARCHITECTURE.CHANGELOG.md)의 한국어 번역입니다. 현재 계약은
`ARCHITECTURE.md`가 정의합니다.

## Domain 기능을 Core에서 분리

Core에는 file, agent conversation, terminal, media playlist, file explorer의 의미와 동작이
포함되어 있었습니다. 첫 소비자에는 동작했지만 이후 소비자는 첫 기능의 가정을 따라야 했습니다.

Core census는 다음 기준을 확정했습니다. Domain-neutral mechanism이 process 구분을 넘을 수 없거나
여러 plugin이 같은 기능을 다시 만들게 되는 경우에만 Core가 소유합니다. 의미와 사용자 동작은
plugin이 소유합니다. 따라서 file 보기, terminal 해석, conversation, media policy는 plugin command와
capability 뒤로 이동했습니다.

## Source tree composition을 설치 component로 교체

Core가 특정 plugin package를 link하고 이웃 repository를 찾으면 checkout layout이 제품 계약이 되고
plugin 추가 때마다 Core를 다시 build해야 합니다. Build 관계는 공개 package, runtime 선택은
`environment.json`으로 바뀌었습니다. Core는 설치 environment가 선언한 component만 조립합니다.

## PTY를 sidecar가 구현하는 capability로 전환

측정 결과 PTY master는 별도 process가 소유했고 Core는 공개 protocol로 byte를 받았습니다. 안정적인
개념은 PTY capability이며 구현은 설치된 sidecar입니다. Terminal policy는 plugin에 남고 다른 구현도
Core 수정 없이 설치할 수 있습니다.

## 검증

Coupling gate는 Core의 domain 이름과 구체 plugin dependency를 거부합니다. Repository boundary gate는
sibling source 탐색을 거부합니다. Host와 sidecar의 end-to-end 검증은 installed-product test가 소유합니다.
