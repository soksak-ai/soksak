---
kind: translation
status: historical
canonical: docs/tech/RESTORE.CHANGELOG.md
---

# Restore 설계 흐름

이 문서는 [영어 흐름 문서](./RESTORE.CHANGELOG.md)의 한국어 번역입니다. 현재 계약은
`RESTORE.md`가 정의합니다.

## 잘못된 record를 보정하지 않는 이유

형식이 다른 record 하나 때문에 cold restore 전체가 중단되어 뒤의 정상 window도 열리지 않았습니다.
읽는 과정에서 빠진 field를 채우면 안전해 보이지만 두 번째 data model이 생기고 durable identity를
조용히 발명하게 됩니다.

현재 restore는 record를 각각 검증합니다. 현재 shape 밖의 record는 이름과 이유를 보고하고 변경하지
않은 채 건너뜁니다. 나머지 record 복원은 계속됩니다. Reader는 migration하거나 상태를 추측하지
않습니다. 피해는 해당 record 하나로 제한되고 진단 증거가 보존됩니다.

## 검증

Restore gate는 여섯 번 cold restart하고 canonical digest, persistent slot 수, 마지막 sweep의 forgotten
record 0개를 검사합니다.
