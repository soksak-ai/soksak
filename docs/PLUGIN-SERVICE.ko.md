# 플러그인 서비스 — 서비스 축 serve 표준 (Plugin Service)

**서비스(stdio) 축**을 규정하는 규범법이다: soksak가 작성한 상주 프로세스가 stdio 위에서
어떻게 통신하는가. 축 전체에 와이어는 하나 — `soksak-service-spec@1`, stdio 위 NDJSON —
이고 serve 하니스도 하나이며 그런 사이드카는 전부 이를 빌려쓴다. 이 법을 낳은 전수 조사가
밝힌 것: 같은 NDJSON dance(스폰 → 줄 버퍼 → 파싱 → 디스패치 → 쓰기 → close-stdin-EOF →
파이프죽음종료)가 4개+ 플러그인(workflow ×4, mascot, sherpa)에 제각각, 프레임 모양만
쓸데없이 다르게 손으로 짜여 있었다. 이 표준이 그 중복을 끝낸다 — 와이어와 루프를 한 번
입법하고 공유한다.

와이어는 플러그인이 하듯 커맨드를 나른다 — `bind:"service"` 커맨드는 레지스트리
커맨드(P1·§0-1: 플러그인 전용 호출 경로 없음)이고, 응답은 집 표준 봉투 `{ok,code,message,
data}`(MESSAGE-PROTOCOL)다. 전송은 소켓 프로토콜이 아니라 집중된 stdio 와이어다: 소켓에서
떼어 두면 서비스는 절대 소켓-addressable 되지 않는다(인증 표면 0). 서비스의 아웃바운드
크로스-플러그인 호출은 같은 stdio 파이프의 `cmd` 프레임을 탄다(신원이 파이프에 내재) —
절대 소켓 역호출이 아니다.

와이어 상수·serde 타입과 참조 serve 하니스의 단일 원천은 `soksak-service-proto`
크레이트(`src-tauri/crates/soksak-service-proto`)다 — 소비자는 크레이트에 의존하며 상수를
절대 복사하지 않는다(`soksak-pty-proto` 규율). 매니페스트 스키마의 단일 심판은
`@soksak-ai/plugin-spec`의 `parseManifest`다.

인용하는 법은 참조하며 절대 재서술하지 않는다: 결합법 C1–C5(ARCHITECTURE §7), 사이드카
택소노미(SIDECARS §1)와 사이드카 표준(PLUGIN-CONTRACT §5), 응답 봉투와 사이드카 경계
A14(MESSAGE-PROTOCOL), 계약 id(NAMING §8), 기질 규칙 P1–P13(AI-CONTROL).

## 1. 축과 구동 모드

**두 축**(SIDECARS §1, 불변): **엔진** 축은 C ABI를 가진 in-process dylib(바이트 스트림이
아니라 함수 호출 — browser-chromium)이고, **서비스** 축은 stdio 위 별도 프로세스다. 이 법은
서비스 축만 다스린다. 엔진 축은 무접촉.

**서비스 축 안에서, 하나의 와이어에 두 구동 모드** — 차이는 오직 누가 stdio 연결을 쥐느냐다:

| | plugin-driven (core-blind) | core-routed (이 법의 주 형태) |
|---|---|---|
| 누가 스폰/stdio 보유 | 플러그인 JS(`app.process`) | 코어(ServiceManager) |
| 매니페스트 | `sidecars[]` | `sidecars[]` + `service` 블록 |
| 커맨드 표면 | 플러그인 자기 레지스트리 커맨드가 호출 | 코어가 `bind:"service"` 커맨드를 네이티브 라우팅 |
| entry | 플러그인이 entry 모듈 보유 | `entry: null` 합법(순수 계약) |
| 예 | speech(mascot/sherpa) | workflow |
| 와이어 | `soksak-service-spec@1` NDJSON stdio(공유 하니스) | 동일 |

두 모드는 동일 와이어를 말하고 사이드카 쪽에서 동일 serve 하니스를 쓴다; plugin-driven은
공유 JS 클라이언트를, core-routed는 ServiceManager를 쓴다. 이제 어떤 것도 플러그인별 사설
와이어를 강제하지 않는다.

**authored vs external 경계(표준의 범위).** 공유 serve 와이어는 **soksak가 작성한 상주
서비스 사이드카**(우리가 바이너리를 씀 — workflow, speech)에 **의무**다. **외부 도구
어댑터**에는 적용하지 않는다: 자기 프로토콜을 말하는 제3자 바이너리를 스폰하는
플러그인(acp가 claude/codex의 ACP JSON-RPC를 브리지; playbox가 yt-dlp/ffmpeg를 exec-one)은
사설 계약을 유지한다 — 스폰되는 바이너리의 프로토콜을 우리가 소유하지 않기 때문이다. 이건
정당한 별개 범주이지, 닫아야 할 예외가 아니다.

엔진 축과 plugin-driven 서비스 모델은 그 외에는 SIDECARS §1의 정의 그대로다; 이 문서는 두
구동 모드가 공유하는 서비스 축 와이어·수명 법이다.

## 2. 규칙 (PS1–PS16)

**PS1 — 코어는 어떤 특정 서비스도 알지 못한다.** 서비스 기계장치(ServiceManager, route
분기, mediation, 브리지)는 범용이다: 모든 것을 매니페스트 데이터와 bind 원장에서
해석한다. 코어 소스에 플러그인 id 0개(C1 스캔). 코어 소스에 커맨드 이름 문자열 0개 —
디스패치는 매니페스트를 따르는 데이터 구동이며, 절대 하드코딩된 동사가 아니다. 기능
네임스페이스 아래 기계장치를 두지 않는다.

**PS2 — 표면은 매니페스트가 소유하고, 서비스는 독자 표면을 갖지 않는다.** 커맨드는
`contributes.commands`에 산다 — 플러그인 서비스는 자체 CLI도, 소켓도, 파일
인터페이스도 추가하지 않는다. 커맨드 레지스트리가 단일 제어 표면이다(PLUGIN-CONTRACT
§5). 서비스 바이너리를 직접 구동하는 저장소 내부 하네스는 unit-level 도구이며 **절대
완결 증거가 아니다**; 완결과 운영은 오직 레지스트리(`sok plugin.*`) 실경로로만 판정한다.

**PS3 — 커맨드 스펙은 매니페스트 데이터다.** `bind:"service"` 커맨드는 스펙 전문을
매니페스트에 선언한다: `params`, `description`, `returns`, `danger`, `title`.
레지스트리는 데이터만으로 등록한다 — 포워딩 핸들러는 합성되며, 절대 손으로 작성하지
않는다. declared ≡ actual은 스폰 시점에 양방향이다: 서비스 hello의 `ops[]`는
매니페스트의 `bind:"service"` 집합과 정확히 일치해야 한다; 어느 방향의 불일치든 bind를
거부한다.

**PS4 — `entry: null`은 순수 계약 플러그인에만 합법이다.** 조건은 `parseManifest`가
강제한다: 매니페스트가 `service`를 선언하고, 모든 커맨드가 `bind:"service"`를 지니며,
코드가 필요한 기여가 존재하지 않는다(`views`, `nodes`, `fileViewers`, `iconSets` 금지 —
각각 런타임 provider 바인딩이 필요하다; 데이터만의
기여 — `programs`, `events`, `skill`, `configuration` — 는 합법으로 남는다). 그 외의
`entry: null` 조합은 전부 거부한다. 로더는 이런 플러그인을 entry 모듈 없이 활성화한다;
투명성 게이트(C2)는 불변 적용된다.

**PS5 — 와이어는 `soksak-service-spec@1`이다.** stdio 위 양방향 NDJSON; 한 줄에 JSON
프레임 하나; 줄은 절대 4 MB를 넘지 않는다 — 초과하거나 파싱 불가한 줄은 프로토콜
결함이며 재시작 경로(PS10)로 들어간다, 절대 무음 스킵이 아니다. 서비스의 첫 줄은
`hello`(프로토콜 버전, interface id, `ops[]`, `subscribe[]`)다; 코어는
`soksak-protocol` 판정 문법과 매니페스트 선언으로 호환성을 검증한 뒤 `ready`로
응답한다. 프레임: `req`/`res`(커맨드 실행, id 멀티플렉스), `ev`(진행, req id에 결속),
`act`(활동, 단독), `cmd`/`cmdres`(중개 아웃바운드 호출), `push`(구독 이벤트,
코어→서비스), `shutdown`. 에러 코드 집합은 proto 크레이트의 폐쇄 enum이다; 코어는
미지의 코드를 `INTERNAL`로 사상하며 raw 서비스 문자열을 봉투 밖으로 절대 누출하지
않는다.

**PS6 — 코어 소스에 등장하는 계약 id는 플러그인-id 문법과 절대 충돌하지 않는다.** C1
스캔은 코어의 `soksak-plugin-*` 토큰을 적발한다; 따라서 와이어 계약은
`soksak-service-spec@1`이고 크레이트는 `soksak-service-proto`다. 플러그인-id 스캐너가
제재할 계약 id를 절대 만들지 않는다. id는 NAMING §8(`<scope>-spec@<major>`)을 따른다;
매니페스트 `service.interface` 선언에 등장한다 — 그 선언을 인정하도록 NAMING §8의 표면
목록을 개정하는 것은 이 입법의 일부이며, 절대 무언 추가가 아니다(C4).

**PS7 — 봉투가 메시지 seam이다.** 서비스 `res`는 `ok`, `code`, `message`, `hints[]`,
`data`를 1급 필드로 나른다 — 사람 문장은 MESSAGE-PROTOCOL §3의 규칙 그대로 커맨드
구현이 소유하되, JS 클로저 대신 와이어로 전달된다. 레지스트리는 봉투가 제공한
`message`/`hints`를 **오직** `bind:"service"` 커맨드에 대해서만 수용한다; 다른 모든
커맨드는 런타임 함수 seam을 유지한다. message 부재는 라벨로 열화하고
conformance(`messagesMissing`)에 표면화된다, 절대 로드타임 거부가 아니다. 진행 `ev`
프레임은 표준 `command.progress`로 사상된다; 이 형태에서는 A14의 어댑터 역할이
프로토콜에 흡수된다(MESSAGE-PROTOCOL 개정은 seam 커밋과 함께 랜딩한다).

**PS8 — 내부는 불투명, 경계는 투명.** 코어는 프로토콜 프레임만 해석하고 그 외엔 아무것도
해석하지 않는다 — 플러그인 도메인 데이터는 검사 없이 통과한다(A14). 모든 실행은
가시적이다: 네이티브로 디스패치된 커맨드는 웹뷰 경로와 동일한 충실도로 활동 피드에
`command.executed`를 기록한다(AI-CONTROL P12); 서비스 상태 전이(`spawned`, `draining`,
`restarted`, `backoff`, `error`)는 활동 이벤트로 발행된다. 무음 강등은 금지다.

**PS9 — bind는 선언적이며 창-무관이다.** bind = 설치됨 ∧ 활성화됨 ∧ 동의됨 ∧
매니페스트가 `service`를 선언함. 부팅 원천은 **bind 원장** — identity 홈 아래 코어
소유의 파생 파일이다(경로 파생은 proto 크레이트에 산다). 앱은 활성화/동의/설치 전이가
있을 때마다 원장을 다시 쓴다(이벤트 구동, 절대 폴링 아님); 코어는 부팅 시 원장을 읽고
워크스페이스 창 없이 bind한다. Rust는 매니페스트를 절대 재파싱하지 않는다 — 단일 심판은
`@soksak-ai/plugin-spec`으로 남고, 원장은 이미 판정된 부분집합을 나른다. 스폰은 사이드카
스테이징 법(실물 스테이징, 원자 rename, 심링크 금지)을 따르고, `SOKSAK_HOME`을
주입하며, 선언된 시크릿을 스폰 환경에만 주입한다 — 시크릿은 절대 stdio를 건너지
않는다. bind는 세대 카운터 아래 멱등이다: 경합하는 두 bind가 두 프로세스를 입양할 수
없다.

**PS10 — 재시작은 드레인 우선, 크래시는 loud.** 환경·시크릿 변경은 **드레인
재시작**으로 발효된다: in-flight op가 완료되고(zombie backstop 상한), 새 req는 유계
큐잉되고, 그 뒤 프로세스가 교체된다 — 변경 이벤트가 트리거하며, 절대 폴링이 아니다.
크래시는 지수 백오프(1→2→4→8→16초, 상한 5)로 리스폰한다; 결정적 즉사(`ready` 이전
사망)는 재시도가 없다 — 곧장 에러 상태로 간다. 상한 도달과 에러 상태는
`status:"error"`와 사유를 활동 피드와 플러그인 상태 표면에 발행한다. 리스폰 성공은
플러그인의 스케줄을 1회 poke한다. `shutdown`은 드레인 유예를 주고, 그 뒤 SIGKILL한다;
앱 종료는 상주 서비스 프로세스를 0개 남긴다.

**PS11 — 라우팅은 네이티브이며 포커스-무관이다.** `bind:"service"` 커맨드는 `route()`
내부에서 ServiceManager로 직행 디스패치된다 — 웹뷰 emit 이전에, 그리고 그것을
대신하여. 어떤 창도 참조하지 않고 어떤 창도 필요하지 않다: 무엇이 포커스를 쥐고 있든 —
컨트롤 플레인이어도 — 디스패치는 동일하다. route 분기는 자신의 `command.executed`
결과를 직접 기록한다. 창 발원 호출은 합성 프록시 핸들러를 통해 같은 ServiceManager에
닿는다; 프록시는 창 로드 시 매니페스트 데이터로 1회 등록된다(서비스 재시작을 가로질러
절대 재등록하지 않는다 — 레지스트리의 중복-throw는 유효하다). 실행 진실은
ServiceManager 하나뿐이다; 프록시는 상태를 갖지 않는다.

**PS12 — 전달은 effective-once다.** 코어는 모든 `req`에 idempotency 키를 스탬핑한다;
서비스는 키로 dedup하고 반복된 키에는 캐시된 `res`를 재생한다. 파괴된 창의 pending
브리지 엔트리는 파괴 시점에 취소된다, 절대 만료 방치가 아니다. req의 마감은 진행 `ev`
프레임이 도착하는 동안 연장된다, zombie backstop까지 — 장시간 op는 웹뷰 lease 없이
생존한다.

**PS13 — 아웃바운드 호출은 중개되고, 신원은 코어가 스탬핑한다.** 서비스는 오직 `cmd`
프레임으로만 다른 커맨드를 부른다. 코어는 인바운드와 동일한 게이트 전체로 중개한다:
관리 커맨드 차단, danger 등급 권한, 선언 의존성 검사 — 미선언 대상 플러그인은
거부된다(C3 사다리; 절대 이름-핀 편의가 아니다). `origin`과 `parent`는 코어가 직접
스탬핑한다 — 서비스의 자기신고 신원은 절대 신뢰하지 않는다. 중개 호출이 웹뷰 대상을
필요로 하면, 코어는 대상 플러그인을 호스팅하는 창들 가운데 결정적으로 선택한다 — 절대
`LAST_FOCUSED`가 아니고, 절대 컨트롤 플레인이 아니고, 절대 포커스를 움직여서가 아니다;
적격 창이 없으면 호출은 유계 큐잉되고 창 도착 시 방류된다(이벤트 구동).

**PS14 — 스케줄은 매니페스트 데이터이고 수명은 코어가 소유한다.** `contributes.schedules`
는 트리거를 데이터로 선언한다(`name`, `command`, `params`, `trigger`, `timeoutMs`,
`zombieBackstopMs`). 코어는 `owner`에 플러그인 id를 스탬핑하고, bind 시 등록하고, bind
직후 1회 poke하고(부팅 스캔), unbind 시 owner로 취소한다 — 서비스 스케줄은 절대 고아가
될 수 없다. `bind:"service"` 커맨드를 발화하는 스케줄은 네이티브로 디스패치된다(PS11);
창의 존재에 절대 의존하지 않는다.

**PS15 — 인바운드 이벤트는 브리지·dedup·1회 전달된다.** hello `subscribe[]`는 서비스가
소비하는 bus 토픽을 명명한다. 코어는 창-bus 발행을 단조 `seq`를 가진 코어측
허브(ActivityHub 규율)로 브리지하고, 창들을 가로질러 seq로 dedup하고, 각 이벤트를
서비스에 정확히 1회 push한다. 이 보장은 구조가 나른다 — 절대 문서 경고가 아니다.

**PS16 — 직렬화는 서비스의 법이고, 기준은 절대 약화되지 않는다.** 상태 변이 op는 서비스
내부의 단일 뮤텍스 아래 실행된다 — 공유 상태의 동시 변이는 계약으로 금지되며, 읽기 op는
동시 실행될 수 있다. 이 법이 명명하는 모든 게이트는 랜딩하는 날부터 blocking이다. 이곳의
기준은 오직 C5 절차 — 명시적 문제 제기, 그 뒤 재입법 커밋 — 로만 변경된다. 재입법
이력은 이 문서에 기록한다.

**PS17 — serve 루프는 공유 하니스이지, 손으로 짜지 않는다.** 모든 서비스가 필요로 하는
프레이밍 — 줄 버퍼 NDJSON 읽기, 한 줄에 JSON 하나 쓰기+flush, hello 발행, id-멀티플렉스
req/res, 스트리밍 `ev`, close-stdin을 EOF로, 파이프죽음 시 종료, PS16의 상태변이 뮤텍스 —
은 `soksak-service-proto`에 `serve(handlers)`로 한 번 산다. 사이드카 저자는 op 핸들러만
쓰고 그 외엔 아무것도 안 쓴다; 루프는 빌려쓰지 절대 재구현하지 않는다. 코어
쪽(ServiceManager 프레이밍/라우팅)과 사이드카 쪽(`serve`)이 같은 크레이트에 의존한다 —
와이어는 원천이 하나이고 양끝에서 읽는다. 미래의 비-Rust 사이드카는 크레이트 스펙에 맞춰
와이어를 직접 구현한다; Rust `serve`는 참조이고, 와이어가 표준이다.

**PS18 — 하나의 와이어, 두 구동 모드.** 같은 와이어·같은 `serve` 하니스가 **core-routed**
모드(코어가 stdio를 쥐고 `bind:"service"` 커맨드를 라우팅 — PS9/PS11)와 **plugin-driven**
모드(플러그인 JS가 `app.process`로 stdio를 쥐고 공유 JS 클라이언트로 와이어를 구동)를 함께
섬긴다. plugin-driven 모드는 SIDECARS `service` 모델이되, 플러그인별 사설 계약 대신 표준
와이어 위에 있다. soksak가 작성한 상주 서비스 사이드카(speech, workflow)는 어느 모드로 돌든
이 와이어를 **의무**로 말해야 한다; 사설 프레임 모양을 발명할 수 없다. 레거시 보완은 이
구조의 일부다(R1): speech 사이드카와 그 플러그인 클라이언트가 공유 하니스로 이관한다 — 그
이관이 이 와이어가 workflow 패치가 아니라 표준임을 증명한다.

**PS19 — 외부 도구 어댑터는 예외가 아니라 원칙으로 범위 밖이다.** 자기 프로토콜을 말하는
**제3자** 바이너리를 스폰하는 플러그인(acp → claude/codex의 ACP JSON-RPC; playbox →
yt-dlp/ffmpeg one-shot)은 사설 계약을 유지한다 — 스폰되는 바이너리의 와이어를 우리가
소유하지 않고 우리 것을 말하게 강제할 수 없기 때문이다. 이건 닫아야 할 예외가 아니라 별개
범주다. authored-vs-external 선이 PS17/PS18의 범위 경계다: 공유 와이어는 soksak가 상주
바이너리를 작성하는 곳에만 의무다.

## 3. 매니페스트 선언

```jsonc
{
  "entry": null,                          // PS4 — 순수 계약 플러그인
  "permissions": ["service", "..."],     // "service"는 caution 권한(동의 강조)
  "sidecars": [
    { "name": "workflow", "interface": "soksak-sidecar-workflow-spec@1",
      "reach": { "fetch": { "url": "...", "sha256": "..." } } }
  ],
  "service": {
    "sidecar": "workflow",                // 상주 바이너리인 sidecars[] 엔트리를 명명
    "interface": "soksak-service-spec@1", // 이 법이 규율하는 와이어(PS5, PS6)
    "subscribe": ["bus:kanban:changed"]   // PS15
  },
  "contributes": {
    "commands": [
      { "name": "run", "title": { "en": "Run", "ko": "실행" },
        "bind": "service",
        "description": "Start a workflow run from a draft document.",
        "params": { "doc": { "type": "string", "required": true } },
        "returns": "object" }
    ],
    "schedules": [
      { "name": "reconcile", "command": "reconcile", "trigger": { "reconcile": true },
        "timeoutMs": 1800000, "zombieBackstopMs": 3600000 }
    ]
  }
}
```

바이너리의 배급·스테이징·명명·무결성은 사이드카 법을 불변 상속한다(SIDECARS;
`sidecars[].reach` fetch + sha256). `service` 블록은 코어-라우팅 bind만 추가하고 그
외엔 아무것도 추가하지 않는다.

## 4. 게이트

| 조항 | 게이트 | 표면 |
|---|---|---|
| PS1 | `core-decoupling-scan.mjs` (C1) | `make gates` |
| PS3, PS4 | `parseManifest` 픽스처(valid + must-fail) | `make spec-gate` |
| PS5, PS12 | proto 크레이트 유닛 + ServiceManager 픽스처-서비스 테스트 | `cargo test` |
| PS7 | 레지스트리 seam 테스트(서비스 한정 수용) | `pnpm test` |
| PS9–PS15 | ServiceManager + route + schedule + 브리지 테스트, PS 번호 인용 | `cargo test` / `pnpm test` |
| PS17 | `serve()` 하니스 픽스처-사이드카 테스트(루프·hello·멀티플렉스·EOF) | `cargo test` |
| PS18 | 공유 JS 클라이언트 테스트 + speech 사이드카의 공유 하니스 이관 | `pnpm test` / `cargo test` |
| PS2 (완결) | `sok plugin.*` 실경로 시나리오 게이트 | e2e |

이 법을 강제하는 모든 RED 테스트는 조항 번호를 인용한다. `make verify`의 CI 원장 행은
게이트를 추가하는 같은 커밋에서 새 게이트를 반영한다(CI-STATUS 규율).

## 재입법 이력

- 2026-07-11 — v1.0.0 입법 (PS1–PS16).
- 2026-07-11 — PS4: 금지 목록에 `iconSets` 추가(구현 검증에서 런타임 provider 바인딩
  필요가 확인됨 — `registerIconSet`; 열거가 이를 누락했었다).
- 2026-07-11 — v2.0.0: "제3 형태"에서 **서비스 축 serve 표준**으로 재저작. 문제(C5): 전수
  조사(docs + chromium/sherpa 엔진 + 플러그인 out-of-process)가 같은 stdio-NDJSON serve
  루프를 4개+ 플러그인에 프레임 모양만 쓸데없이 다르게 손짜기로 발견 — workflow 하나로
  정한 것이 잘못된 범위였다. PS17(공유 `serve` 하니스)·PS18(하나의 와이어, 두 구동 모드 —
  core-routed와 plugin-driven, 후자는 SIDECARS `service` 모델을 표준 와이어로 이관)·
  PS19(authored-vs-external 어댑터 경계) 추가. 이는 SIDECARS §1의 `service` 모델
  "private contract"를 soksak-작성 사이드카에 한해 개정한다(동반 커밋); 엔진 축은 무접촉,
  A14의 "세 와이어 통일"은 범위 밖 유지 — 이건 stdio 축 내부만 정리한다.

---

Version: 2.0.0
Status: AUTHORITATIVE
단일 진실: `soksak-service-proto`(와이어·serve 하니스), `@soksak-ai/plugin-spec`(매니페스트)
