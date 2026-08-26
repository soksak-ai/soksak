---
kind: translation
status: active
canonical: ./COMMAND-LINE.md
---

# sok 명령줄

sok 은 애플리케이션 명령 registry 로 요청 하나를 보냅니다. 두 번째 명령 경로를 구현하지 않습니다.

## 명령 이름

공개 명령은 plugin.enable, plugin.install.local, window.snapshot 처럼 점으로 구분한 도메인 이름을
씁니다. 네이티브 백엔드 명령 이름은 내부에서 snake case 를 쓸 수 있으며 공개 CLI 어휘가 아닙니다.

로컬 설치는 명령 두 개로 이루어진 트랜잭션입니다. `plugin.install.local.plan` 또는
`sidecar.install.local.plan` 이 절대 store 경로, 정확한 id, 정확한 version 을 받아 전체 릴리즈
closure 와 plan digest 를 반환합니다. 짝이 되는 설치 명령은 그 digest 를 요구합니다. 계획 이후
릴리즈 바이트가 하나라도 바뀌면 stage 전에 설치가 실패합니다. 원본 소스 경로와 `file:` locator 는
명령 파라미터가 아닙니다.

`sidecar.request` 는 설치된 사이드카 control 요청을 위한 운영자·시스템 테스트 중계입니다. 사이드카
이름과 요청 객체 하나를 받아 그 객체의 command 를 해석하지 않고 전달하며, 사이드카 응답을 반환합니다.
플러그인 코드는 이 운영자 명령을 호출할 수 없습니다. 플러그인은 선언한 사이드카 capability 를
사용합니다.

## 파라미터 형식

두 형식이 같은 파라미터 map 을 만듭니다.

이름-값 형식:

    sok plugin.install.local.plan store=/absolute/releases pluginId=demo version=0.0.1

POSIX 셸과 PowerShell 의 JSON 객체 형식:

    sok plugin.install.local.plan '{"store":"/absolute/releases","pluginId":"demo","version":"0.0.1"}'

JSON 객체는 명령 뒤의 유일한 인자여야 합니다. 객체와 이름-값 인자를 섞으면 거부합니다. JSON 배열,
스칼라, null 도 거부합니다.

이름-값 형식에서 JSON 으로 파싱되는 값은 그 JSON 타입을 유지합니다. generation=3 은 숫자입니다. 나머지
값은 문자열입니다. 문자열 자체가 JSON 처럼 보이면 JSON 문자열 구문으로 감싸서 전달합니다.

두 형식은 같은 명령 schema 에 대한 구문 선택지입니다. 명령이 둘을 다르게 해석해서는 안 됩니다.

Windows cmd 에서는 작은따옴표가 인용 부호로 동작하지 않으므로 이름-값 형식을 권장합니다. PowerShell
과 POSIX 셸은 둘 중 무엇이든 쓸 수 있습니다. 공백이 있는 경로는 이름-값 인자 하나 전체를 인용합니다.
예: "path=C:\Work Area\plugin".

## 탐색과 출력

- sok commands 는 서비스하는 명령과 거부하는 명령 표를 반환합니다.
- sok help 뒤에 명령을 붙이면 그 명령의 공개 schema 를 반환합니다.
- 성공하면 형식이 갖춰진 JSON 값 하나를 stdout 에 쓰고 0 으로 종료합니다.
- 실패하면 이유를 stderr 에 쓰고 0 이 아닌 값으로 종료합니다.

CLI 는 애플리케이션과 같은 identity 패키지에서 identity 소켓을 도출합니다. 다른 설치본으로 대체하지
않습니다.
