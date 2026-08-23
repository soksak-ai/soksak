---
kind: translation
status: historical
canonical: docs/tech/SIDEBAR.CHANGELOG.md
---

# Sidebar 설계 흐름

이 문서는 [영어 흐름 문서](./SIDEBAR.CHANGELOG.md)의 한국어 번역입니다. 현재 계약은
`SIDEBAR.md`가 정의합니다.

## Plugin이 place가 아니라 surface를 선언하는 이유

Plugin manifest가 구체 region을 선택하면 plugin이 사용자 window를 배열하게 되고 같은 side view도
왼쪽과 오른쪽에서 서로 다른 개념이 됩니다. Projection field는 한 content plugin이 옆에 나타날 다른
plugin까지 선택하게 했습니다.

현재 계약은 capability와 arrangement를 분리합니다. Plugin은 content tab, side view 또는 둘 다 가능한지
선언합니다. 실제 region, split, tab order, persistence는 workspace가 소유합니다. 알 수 없는 manifest
field는 임의 placement로 번역하지 않고 거부합니다.

## 검증

Manifest gate는 현재 surface grammar만 허용합니다. Layout과 restore gate는 side view 이동이 plugin
identity를 바꾸지 않고 native content가 rail을 가로지르지 않음을 증명합니다.
