---
kind: translation
status: active
canonical: ./IDENTITY.md
---

# Identity

프로세스가 어느 설치본에 속하는지, 그리고 거기서 따라 나오는 모든 것.

## I1. 입력 하나, 도출 하나

`core/identity` 는 식별자(`com.soksakv3.core`)와 호출자가 읽은 ambient 를 받아 home, 소켓 경로,
CLI 이름, 빌드 축, 릴리즈 플래그를 함께 반환합니다.

따로 도출하면 ("home A, 식별자 B") 라는 조합이 표현 가능해지고, 재연결이 아무 보고 없이 다른 설치본에
닿습니다. 함수 하나에서 도출하면 나중에 검사하는 대신 그 조합 자체가 없어집니다.

## I2. 코어는 ambient 를 읽지 않는다

`core/` 는 `os.Getenv`, `os.Getwd`, `os.Executable` 를 호출하지 않고 `runtime.GOOS` 로 분기하지
않습니다. 런처가 그것들을 읽어 값으로 전달합니다: `identity.Environment{Windows, Home, UserProfile}`.

결과는 둘이고 둘 다 필요합니다. 같은 규칙이 창에서도, 헤드리스 서버에서도, 테스트에서도 같은 답을
냅니다. 그리고 잘못 설정된 프로세스가 릴리즈 사용자의 home 을 물려받을 수 없습니다.

**검사.** `core/install/ambient_test.go` 가 코어 소스에서 ambient 읽기를 검사합니다.

## I3. Project identity

빌드된 project의 identifier는 `com.<project>.core`입니다. 가운데 segment가 안정적인 project 이름이고
`core`는 app 종류입니다. Home suffix나 framework axis가 아닙니다. `com.soksak.core`와
`com.soksakv3.core`는 서로 다른 project이며 persistent state를 공유하지 않습니다.

명시적으로 주소를 받은 개발 또는 gate process는 `com.soksak.dev` 같은 environment-axis identifier를
사용할 수 있습니다. 이는 build project가 아니라 run identity입니다. Framework 이름은 project identity에
들어가지 않습니다.

## I4. 축에서 따라 나오는 것

| 도출값 | `com.soksak.core` | `com.soksakv3.core` | 명시적 run `com.soksak.dev` |
| --- | --- | --- | --- |
| home | `~/.soksak` | `~/.soksakv3` | `~/.soksak-dev` |
| environment | `<home>/environment.json` | 같은 규칙 | 같은 규칙 |
| socket | `<home>/<identifier>.sock` | 같은 규칙 | 같은 규칙 |
| CLI 이름 | `sok` | `sokv3` | `sok-dev` |

Project home은 나란히 놓이며 등록표 없이 각자 정해집니다.

런타임 재정의는 없습니다. 프로세스가 도는 중에 바꿀 수 있는 home 은 두 프로세스가 서로 다르게 알 수
있는 home 이고, SQLite 는 두 번째 writer 를 거부하지 않고 직렬화하므로 충돌이 조용히 남습니다.
2026-08-15 실측: `dev` 축 식별자가 `~/.soksak-dev/soksak.db` 를 열었는데 다른 프로세스가 그 디렉터리에
살아 있는 소켓을 보유하고 있었습니다.

## I5. identity 를 만들어내지 않는다

`identity.Require` 는 빈 식별자를 기본값으로 대체하지 않고 거부합니다. 자기 identity 를 추측하는
프로세스는 추측이 틀리는 순간 다른 설치본에 붙고, 그것도 조용히 붙습니다.

## I6. home 하나에 백엔드 하나

home 은 store 를 열거나 창을 그리기 전에 확보합니다(`internal/application/launch.go`). 같은 home 에
대한 두 번째 프로세스는 아무것도 그리기 전에 종료하므로, 실패는 데이터베이스 하나에 백엔드 둘이
쓰는 것이 아니라 거부된 시작 하나입니다.

## I7. identity 하나에 구성 하나

home 은 settings 구성 하나를 소유합니다(COMPOSITION C2). 릴리즈, 개발, 테스트 identity 는 설치 선택,
개발 모드, provider 결합을 공유하지 않습니다. 따라서 설치 트랜잭션과 그것을 해석하는 백엔드는 같은
해석된 identity home 을 사용합니다.
