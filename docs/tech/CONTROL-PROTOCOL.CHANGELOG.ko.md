---
kind: translation
status: historical
canonical: docs/tech/CONTROL-PROTOCOL.CHANGELOG.md
---

# Control protocol 설계 흐름

이 문서는 [영어 흐름 문서](./CONTROL-PROTOCOL.CHANGELOG.md)의 한국어 번역입니다. 현재 계약은
`CONTROL-PROTOCOL.md`가 정의합니다.

## 하나의 response envelope가 필요한 이유

Socket이 bare value와 window response envelope를 함께 전달하면 generic client는 command owner를
미리 알지 않는 한 응답 형식을 구분할 수 없습니다. 잘못된 parser를 선택하면 정상 화면 상태도 실패로
판정됩니다.

현재 모든 control-plane response는 하나의 self-describing envelope를 사용합니다. Relay는 window
envelope를 그대로 전달하고 Core command도 socket boundary에서 같은 outer shape을 사용합니다. Command
type을 이미 아는 in-process typed caller만 direct value를 사용할 수 있습니다.

## 검증

Protocol test는 Core command와 window command를 같은 generic client로 실행해 동일한 envelope grammar를
요구합니다. Greeting test는 command 실행 전에 호환되지 않는 protocol version을 거부합니다.
