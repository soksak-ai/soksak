---
kind: translation
status: historical
canonical: docs/tech/CONTROL-PROTOCOL.CHANGELOG.md
---

# Control protocol 설계 흐름

이 문서는 [영어 흐름 문서](./CONTROL-PROTOCOL.CHANGELOG.md)의 한국어 번역입니다. 현재 계약은
`CONTROL-PROTOCOL.md`가 정의합니다.

## 하나의 response envelope가 필요한 이유

socket 이 값만 있는 응답과 창의 응답 envelope 를 함께 전달하면, 일반 클라이언트는 명령 소유자를
미리 알지 않는 한 응답 형식을 구분할 수 없습니다. 잘못된 parser를 선택하면 정상 화면 상태도 실패로
판정됩니다.

지금은 모든 control plane 응답이 스스로를 설명하는 envelope 하나를 씁니다. 중계는 창의
envelope를 그대로 전달하고 Core command도 socket boundary에서 같은 outer shape을 사용합니다. Command
타입을 이미 가진 프로세스 안의 호출자만 값을 그대로 받을 수 있습니다.

## 검증

프로토콜 테스트는 Core 명령과 창 명령을 같은 일반 클라이언트로 실행해 같은 envelope 문법을
요구합니다. greeting 테스트는 명령 실행 전에 호환되지 않는 프로토콜 버전을 거부합니다.
