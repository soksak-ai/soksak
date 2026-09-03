---
kind: translation
status: active
canonical: ./NATIVE-SURFACES.md
---

# 네이티브 표면 — 선언, 적용, 그리고 그 둘의 차이

네이티브 표면은 창이 보여 주지만 문서 안에는 없는 내용입니다. web view 가 그렇고, 앞으로는 자기
프로세스나 자기 renderer 가 필요한 그 밖의 것도 그렇습니다. 문서는 그것이 어디로 가고 무엇을 보여야
하는지를 진술합니다. 네이티브 계층이 그것을 거기 놓고 보고합니다. **판정은 둘의 차이이며, 그 차이는
0 입니다.**

이 문서는 그 이음매의 계약입니다. `tech/NATIVE-LAYER.md` 는 cgo 가 왜 있고 어디에 있어도 되는지를
진술하고, 이 문서는 그 위의 계층이 무엇을 약속하는지를 진술합니다.

## 범위

코어는 선언, 인벤토리, 판정을 소유합니다. 표면 종류는 소유하지 않습니다. "브라우저" 는 플러그인의
낱말이며(C1), 여기에는 오늘 존재하는 유일한 종류로만 나옵니다.

---

# D. 선언 — 문서가 무엇이 존재하는지 진술한다

## D1. 표면은 노드가 선언했기 때문에 존재한다

요소 하나 위의 속성 일곱 개, 그리고 다음 인벤토리 commit 이 표면을 만듭니다. 노드를 지우면 같은 commit
이 그것을 파괴합니다.

```
data-native-surface       provider 종류("webview" 또는 "terminal")
data-native-surface-id    표면이 보고되는 id
data-native-generation    올리면 표면을 다시 만든다
data-native-source        종류가 읽는 JSON. 브라우저면 {"url": …}
data-native-visible       "true" | "false"
data-native-alpha         0..1
data-native-layer         표면들 사이의 그리기 순서
```

이 어휘에는 프레임워크 이름이 없습니다. `data-wails-native-surface` 는 코어가 쓰고 다른 모든 호스트가
읽어야 하는 선언에 호스트 하나의 이름을 넣는 것입니다(P1).

표면을 선언하는 view 는 manifest 에도 선언합니다 — `contributes.views[].nativeSurface: true`. 속성이
표면을 존재하게 만들고, manifest 는 플러그인 밖에서 물어볼 수 있는 것입니다. 2026-08-16 실측: 이
workspace 의 어떤 플러그인도 그것을 선언하지 않았고 브라우저를 담은 플러그인도 마찬가지였습니다.
그래서 호스트 자신의 `ownsNativeSurfaceFromManifests` 는 표면을 가진 그 유일한 view 에 대해 false 를
답했고, 어떤 확인도 결함을 보고하지 않았습니다. 이제 그 플러그인 자신의 검사가 두 경우에 빌드를
실패시킵니다. 소스가 속성을 쓰는데 manifest 가 선언을 빠뜨린 경우, 그리고 manifest 가 선언했는데 어떤
소스도 속성을 쓰지 않는 경우입니다.

## D1b. 문서의 어떤 것도 표면의 순서를 정하지 않는다

`data-native-layer` 는 표면들 사이의 순서를 정합니다. 문서에 대한 상대 위치는 정하지 않습니다. 표면은
페이지 위에 합성되므로 어떤 `z-index` 도 모달을 그 위에 올리지 못합니다. 모든 provider의 기본값은 계약상
`0`이며, 순서가 필요할 때만 provider가 명시적으로 다른 값을 선언합니다.

코어는 서로 다른 사실 셋을 해석합니다. `contentVisible` 은 활성 workspace·space·탭 사슬이며, DOM
슬롯을 제어하고 오버레이나 레이아웃 움직임이 시작된다고 해서 바뀌지 않습니다. `surfaceVisible` 은 거기에
더해 오버레이를 제외합니다. 레이아웃 움직임은 live compositor transaction으로 유지합니다. 움직임 동안
모든 표면을 숨기면 캡처할 픽셀이 없는 대상이 비었습니다. 이 판정은 host tab ancestor의
`data-surface-visible` 로 공개되지만 native 선언을 직접 쓰는 값은 아닙니다. Overlay parking의 순서
소유자는 Core 하나입니다. Core는 선언을 적용된 상태로 유지한 채 surface를 캡처하고
`ParkedPicture`를 게시한 다음, 게시가 완료된 후에만 선언을 숨김으로 바꿉니다. 캡처가 실패하면 live
선언을 계속 적용하고 실패를 `state.health.parking.failures`로 보고합니다. 실패를 빈 pane으로 바꿀 수
없습니다. Picture는 live surface가 돌아올 때까지 같은 슬롯에 유지됩니다. 어느 쪽도 상대 선언을 다시
쓰지 않습니다.

Intrinsic은 Core presentation의 복사본이 아니라 Plugin 내부의 provider 사용 가능 상태입니다. 따라서
mount된 browser는 true를 유지합니다. Terminal Workbench는 자체 maximize로 제외한 pane 하나를 false로
만들 수 있지만 workspace, tab, overlay presentation 변경은 그 값을 바꾸지 않습니다. Terminal Kit은
`intrinsicVisible`, `hostVisible`, 두 값의 논리곱인 `effectiveVisible`, `dim`을 별도 사실로 게시하고
Vision은 첫 번째 값만 native 선언에 씁니다. Browser 0.0.8, Terminal Kit 0.0.77, Vision 0.0.16을 설치한
v7 폐포에서 비활성 terminal과 활성 browser 선언이 모두 intrinsic true인 동안 Core presentation만
browser를 선택했습니다. `surface.inventory`의 ghosts, unowned, unapplied, orphans는 모두 비었습니다.

이 사실들이 분리된 이유는 소유자가 다르기 때문입니다. 합쳤을 때 모달 아래의 모든 DOM 터미널과 사이드바
움직임 중의 터미널이 숨겨졌습니다. live surface 와 그 픽셀 대체본을 합쳤을 때는 pane 이 비었습니다. 탭
슬롯은 `ui.tree` 로 `contentVisible`, `surfaceVisible`, `visibilityReason` 을 노출하고, `state.health`
는 입력을 막는 오버레이 개수와 native 차단 개수를 함께 노출합니다.

캡처 합성은 유지된 선언 목록이 아니라 현재 표시 중인 장식 목록을 사용합니다. 선언된 geometry가 native pane을
가리는 overlay만 native parking을 요청하며, 제한된 메뉴는 요청하지 않습니다. Parking을 요청한 경우에도 surface
picture가 성공한 뒤에만 native surface와 native decoration을 합성 PNG에서 제외합니다.

WebKit은 document 변경 후 첫 capture-only document snapshot을 변경 전 pixel로 완료할 수 있습니다.
`window_capture_present`는 document snapshot을 정확히 한 번 완료하고 폐기한 뒤 반환합니다. 다음
`window_snapshot_region` 요청이 요청한 pixel을 반환합니다. 이 준비는 모든 capture-only 읽기에 실행하고
interactive compositor 캡처에는 실행하지 않습니다. pixel 검사, 재시도, polling, application 활성화는
수행하지 않습니다. 캡처 metadata는 `presentationOrdered`를 포함합니다.

interactive 전달은 geometry와 presentation 소유권을 분리합니다. frame만 바뀐 snapshot은 bridge receipt가
다음 document frame을 소유하지 않아도 반환할 수 있습니다. surface id·generation·kind·source·visibility·
alpha·layer 변경은 실제 compositor receipt를 기다립니다. signature는 frame 좌표를 제외하고 presentation
필드 전체를 포함합니다. 이것만으로 탭 전환이 원자화되지는 않습니다. DOM presentation commit도 그
receipt에 맞춰 stage해야 합니다. 마지막 순서는 `tab.switchScan.nativeMismatchFrames`가 판정합니다.

interactive는 geometry 적용 연기를 뜻하지 않습니다. divider preview마다 terminal host frame, browser host
frame, browser `WKWebView` viewport를 포함한 완전한 선언 rectangle을 각 native kind에 적용한 뒤 그 preview를
판정합니다. `layout.trace.native`는 그려진 DOM frame마다 그 시각 이전의 최신 compositor Apply를 결합하고,
provider가 `settled` rectangle을 노출하면 `applied`와 `settled`를 모두 비교합니다. 따라서 clipping host만
이동하고 page viewport가 이전 크기에 남은 frame은 즉시 `wrongFrames > 0`으로 실패하며, mouse-up 뒤의
정상 frame이 앞선 실패를 지우지 않습니다.

각 divider preview는 layout 상태 변경에 즉시 geometry 표식을 설정합니다. 해당 React layout commit은
그 표식을 소비하고 FLIP animation 없이 새 rectangle을 기록합니다. 표식은 callback 실행 시간이 아니라
상태 변경과 연결됩니다. React commit은 native input callback 반환 뒤에 실행될 수 있고 background 창은
animation을 중지할 수 있습니다. 마지막 preview와 단일 `pane.resize` command는 resize-motion 종료 event
전에 하나의 동기 DOM transaction에서 실행합니다. `ui.tree`, `surface.composition`, `ui.motion`으로 pane,
slot, native surface rectangle 일치, declared/applied drift 0, divider preview의 FLIP animation 0을 검증합니다.

Divider resize는 명시적인 geometry transaction을 사용합니다. Core는 다음 split layout과 각 pane 내부에서
현재 보고된 고정 offset으로 target rectangle을 계산합니다. Native compositor는 전체 inventory를 먼저
적용합니다. Core는 receipt 직후 동일한 store와 DOM 변경을 적용합니다. 하나의 적용이 실행되는 동안
transaction은 최신 pending pointer 값만 유지합니다. 각 native 적용은 이전 document frame이 게시한
task에서 시작하므로 receipt와 DOM 변경에 하나의 완전한 frame 간격을 제공합니다. Document가 animation
frame을 생성하지 않을 때를 위해 task에 유한한 50ms 실패 제한이 있으며 polling은 사용하지 않습니다.

Surface 좌표는 공개 layout trace와 동일한 0.01 CSS pixel 정밀도를 사용합니다. Trace tolerance를 늘리지
않고 실제 command 값에서 floating-point 직렬화 잔여값을 제거합니다. Non-key 상태에서 16 step, 800ms
divider 실행과 36 frame 녹화를 동시에 수행한 결과 tolerance 0에서 compared frame 108개, compositor sample
97개, `wrongFrames=0`, `worstAppliedOff=0`, `worstSettledOff=0`을 반환했습니다. 녹화의 중간 frame에서
terminal, browser viewport, pane line이 동일한 split 위치에 표시됐습니다.

비활성 document는 command로 변경된 layout을 FLIP 없이 적용합니다. WebKit은 non-key window에서 WAAPI를
진행하지 않으므로, 그 상태에서 생성한 animation은 state와 native geometry가 새 rectangle을 포함한 뒤에도
이전 rectangle을 유지할 수 있습니다. `layoutRectMotion`은 FLIP 생성 시 `document.hasFocus()`를 확인합니다.
false이면 `layout-rect-skipped(inactive-document)`를 기록하고 commit된 rectangle을 다음 기준값으로 사용합니다.
현재 window 상태를 직접 사용하며 polling은 사용하지 않습니다.

## D1b.1. Core 장식은 마지막 네이티브 평면이다

포커스 표시선은 provider 내용이 아니라 Core chrome입니다. 관계 오버레이는 projected seam 만 표시하며 rail·pane·union
외곽선은 그리지 않습니다. DOM의 `z-index:7` 또는 `8`로
그려도 AppKit 자식 위에 놓이지 않습니다. 2026-08-30 연결된 브라우저에서 실측했을 때 자식 위쪽의 선은
accent 색이었지만 자식 안쪽의 왼쪽·오른쪽·아래쪽 probe는 모두 페이지의 흰색이었습니다. 터미널도 자기의
어두운 표면으로 같은 실패를 만들었습니다. provider마다 inset을 두면 두 종류가 서로 다르게 실패할 뿐입니다.

따라서 Core는 입력을 통과시키는 범용 네이티브 장식 평면 하나를 소유합니다. 제한된 절대 경로 어휘 `M`,
`L`, `Q`, `Z`를 받아 `CAShapeLayer`로 그리며 브라우저와 터미널 종류에 관계없이 같은 경로를 씁니다. ordered
presentation service는 완전한 surface inventory commit 뒤에 이 지속 평면을 매번 마지막으로 올립니다.
장식만 바뀌면 이벤트로 합쳐지고 직렬화된 writer가 전체 snapshot 하나를 교체합니다. `surface.decorations`는
선언과 `layer:native-above-surfaces`를 포함한 네이티브 receipt를 노출합니다. `presentationVisible`은 선언과
실제 표시를 분리합니다. DOM 오버레이가 열리면 그 상태 edge가 빈 장식 snapshot을 적용하는 동안에도 선언은
최신 기하를 계속 받으며, 닫는 edge가 가장 최신 snapshot을 복원합니다. 이 규칙은 어느 기능도 provider로
옮기지 않고 모달을 provider surface와 Core border 모두보다 위에 놓습니다. 타이머와 폴링은 없습니다.

이 평면은 입력을 받지 않습니다(`hitTest:`는 `nil`을 반환합니다). divider만 resize 대상과 기하 소유자이고,
focus border는 그 결과 panel rectangle과 같은 위치에 그려집니다. `ResizeObserver`는 크기만 보고 위치는 보고하지 않으므로,
위치만 바뀌는 Core render는 paint 전에 rectangle 위치로 다시 그립니다. 외부 크기 변경은 계속 observer event로
들어옵니다.

capture-only도 하나의 compositor입니다. 문서와 provider 그림으로 창을 재구성한 다음 같은 Core 장식 snapshot을
마지막에 그립니다. provider loop 전에 그리면 가림 결함이 그대로 재현됐습니다. 변경 뒤 격리 설치 실행에서
live browser를 지나는 포커스 왼쪽·오른쪽 edge probe는 균일한 `(238,238,238)`에서 accent가 포함된 평균
약 `(160,163,231)`, 최소 휘도 `0.378`로 바뀌었고 composed note는 장식 두 개를 기록했습니다. rail과 pane의
rounded union은 바깥쪽 edge 전체에 보였습니다. 브라우저 탭 30프레임 전환도 switch frame 1개, flicker·blank·
overlap·native mismatch frame 0개로 끝났습니다.

연결된 rail의 유한 resize는 합성 프레임 70개를 기록했습니다. 바깥쪽 왼쪽·오른쪽·위쪽·아래쪽 띠는 모두
`changedFrames=0`이었고 rail 안쪽 띠도 변경 프레임 0개, 작업 영역 전체는 `nearBlank=0`이었습니다. 같은
구간의 compositor history는 중간 폭 전체에서 sample 264개와 interactive·settled commit을 모두 보유했고,
최대 drift 0, failure·unapplied·undeclared·misparented surface 0개를 답했습니다.

같은 평면을 live terminal surface 위에서도 측정했습니다. surface만 있던 RED는 휘도 `0.088`의 균일한
terminal 바탕이었습니다. Core 선을 마지막에 그린 뒤 왼쪽과 오른쪽 probe는 평균 휘도 `0.354`, 최소
`0.088`, 최대 `0.616`을 읽었고 위쪽과 아래쪽 edge probe도 같은 범위를 보였습니다. 이전에 균일했던
아래쪽 띠의 probe도 바탕 평균은 유지하면서 최대 `0.616`을 기록해 선이 남아 있음을 증명했습니다. 서로
다른 full-surface 색을 둔 terminal 둘의 30프레임 전환은 switch frame 1개, flicker·blank·overlap·native
mismatch frame 0개로 끝났습니다. non-key capture는 전후 모두 `windowFocused=false`를 유지했습니다.

## D1c. 표면은 포인터를 보고하고, 코어가 포커스를 옮긴다

페이지는 자기 클릭을 직접 받고 그 위의 문서는 그것을 전혀 보지 못하므로, 브라우저 안을 클릭해도
포커스된 pane 은 그대로였습니다 — 2026-08-17 실측이며, 같은 pane 의 탭을 클릭하면 옮겨갔습니다.

그것의 이름은 `content-view-activated` 이고 `core/contentview/events.go` 와
`lib/contentViewEvents.ts` 에 있습니다. "사용자가 이 view 를 클릭했다 — pane binding 이 따라야 하는
유일한 사실" 이라는 주석이 있었지만 아무것도 발행하지 않았고 아무것도 구독하지 않았습니다. 개념은
정해져 있었고 배선이 없었습니다.

세 부분이며 각각 자기만 기록하는 것만 보유합니다.

네이티브 view 를 소유한 플러그인은 클릭을 보고 **점 하나와 그것이 떨어진 창 핸들**을 보고합니다. 그것이
어느 표면인지는 판단하지 않습니다. 이전 시도는 여기서 네이티브 view 트리를 걸었고 제목 표시줄 높이만큼
어긋났습니다. `hitTest:` 는 자기 점을 수신자의 superview 좌표로 받는데 그 걸음이 이미 한 번 변환한
뒤였기 때문입니다.

컴포지터는 **그 점 아래에 어떤 표면이 있는지** 답합니다 — `SurfaceAt` 입니다. 적용된 모든 사각형을
그것이 선언된 계약(A2)으로 보유하기 때문입니다. 선언된 것이 아니라 적용된 것입니다. 점이 화면에서 왔기
때문입니다. layer 기준 최상위이며, 보이지 않거나 완전히 투명한 표면은 클릭 대상이 아닙니다. 서비스가
이미 가진 숫자에 대한 사각형 판정이므로 확인에 창이 필요 없습니다.

코어는 **포커스가 무슨 뜻인지** 판단합니다 — 어느 pane, 어느 탭, 조명이 무엇을 따르는지 —
`content-view-activated` 위에서입니다. 표면을 소유한 플러그인은 보고 하나를 쓰고 나머지를 얻으며, 두
플러그인이 서로 다르게 답할 수 없습니다.

플러그인에 구독으로 제공하지 않습니다. 플러그인이 스스로 포커스를 옮기는 것은 한 가지 일에 대한 두 번째
규칙입니다.

## D1a. label: 모양은 코어의 것, 종류는 플러그인의 것

표면 label 은 `<kind>.<window>.<viewId>` 입니다 — 구분자와 필드 알파벳은 NAMING.md N3 의 것이고,
조립자는 `frontend/src/lib/surfaceLabels.ts` 하나입니다.

**가운데의 창**이 값을 애플리케이션 전체에서 유일하게 만듭니다. view id 는 창 하나 안에서 이미
유일하므로, 창 부분 없이 다시 만든 label 은 창 둘이 값 하나를 만들게 하고, 두 번째 창이 첫 번째 창의
표면을 주소로 잡습니다. 그래서 모양은 코어의 것이고 `frontend/src/lib/surfaceLabels.ts` 에 있으며,
플러그인은 label 을 조립하지 않고 `app.webview.label(kind, viewId)` 에서 받습니다.

**종류**는 플러그인의 낱말이며, 선언이 `data-native-surface` 에 넣는 것과 같은 낱말입니다. 2026-08-16
실측: 코어가 `brw-` 를 보유했고 `app.webview.label(viewId)` 로 브라우저에 코어 자신의 식별자를
건넸습니다. 브라우저를 그리는 그 유일한 플러그인은 코어를 고치지 않고는 교체할 수 없었고, 두 번째
종류의 표면은 label 을 얻을 곳이 없었습니다. 이제 `history_gate_test.go` 가 `core/`, `frameworks/`,
`frontend/src` 어디든 기록된 표면 종류에 대해 빌드를 실패시킵니다.

읽기는 반대 방향이며 종류를 보지 않습니다. `viewIdFromSurfaceLabel` 은 창 부분 앞의 모든 것을 읽지 않고
건너뛰므로, 이 코어가 한 번도 들어 본 적 없는 플러그인도 view 로 해석됩니다. view 에서 label 로 갈
때는 코어가 **선언을 읽습니다.** `surfaceLabelOfView` 는 label 을 다시 만드는 대신 요소에서
`data-native-surface-id` 를 가져옵니다. 다시 만들려면 종류가 필요하고, 그렇게 만든 label 은 플러그인이
한 번도 쓰지 않은 값에 대해 자기끼리만 일치합니다. 그것은 아무것도 찾지 못하면서 결함도 보고하지 않는
조회입니다.

## D2. 여는 호출도 닫는 호출도 없다

선언이 곧 수명입니다. `webview_close` 와 `webview_recover` 는 이유와 함께 서비스하지 않는다고
선언되어 있습니다. 표면 하나를 닫는 명령은 두 번째 writer 이고, 다음 전체 commit 이 선언에 맞춰
조정하면서 그것을 곧바로 되돌려 놓습니다. 호출자는 읽을 것도 없이 그것이 돌아오는 것을 보게 됩니다.

## D3. 한 번의 전달에 완전한 인벤토리가 들어간다

diff 가 아닙니다. 낡은 sequence, 부분 인벤토리, 두 번째 writer 는 무엇이 바뀌기 전에 모두 거부하며,
그것을 적용한 같은 commit 에서 receipt 하나가 돌아옵니다.

## D4. sequence 는 오르기만 한다

백엔드는 이미 지나온 번호를 거부합니다. 앞선 관측자를 대체한 관측자는 그것이 멈춘 지점에서 재개합니다.
1 부터 다시 시작하면 이후의 모든 commit 이 거부되고, 화면은 마지막으로 도착한 인벤토리에서 멈추며 거부는
receipt 에서만 보입니다.

## D5. 외부 호출은 컴포지터의 읽기 상태 lock을 소유하지 않는다

`Commit`, `Deliver`, `Drain`은 writer transaction이며 서로 직렬화합니다. Receipt, composition,
hit test, history를 보호하는 mutex는 window를 해석하거나 backend를 호출하기 전에 놓습니다. 이 호출은
AppKit main thread에 동기 진입할 수 있고, AppKit pointer callback은 `SurfaceAt`을 호출해 같은 상태를
읽기 때문입니다.

2026-08-28 terminal pane 세 개에서 실측했습니다. Commit이 compositor state mutex를 잡은 채 terminal
`Apply`의 `dispatch_sync(main)`을 기다렸고, main thread의 native mouse-down은 `SurfaceAt`에 들어와
그 mutex를 기다렸습니다. 양쪽이 영원히 기다리면서 terminal place/display 호출이 쌓였고 macOS는 앱을
응답 없음으로 판정했습니다. CPU는 거의 idle이었습니다. Retry나 timeout은 lock cycle을 숨길 뿐입니다.

따라서 compositor는 별도 backend-writer lock을 둡니다. Backend가 적용 중인 동안 reader는 마지막 완료
snapshot을 반환합니다. 성공 결과는 짧은 state lock 안에서 다음 완료 snapshot이 됩니다. Backend는
writer transaction을 재귀 호출하지 않습니다. Owner test는 모든 backend 호출 직전에 즉시 lock probe를
실행하고 platform system gate는 여러 surface를 열고 클릭해 application main loop가 계속 응답하는지
검증합니다.

---

# A. 적용 — 네이티브 계층의 응답

## A1. 두 반쪽은 한 commit 에서 온다

`Latest(window)` 는 짝지어진 합성 하나를 답합니다. 표면마다 문서가 선언한 것, 네이티브 계층이 보고한
것, 그리고 둘의 차이입니다. 선언을 문서에서 대신 읽으면 나중 프레임을 이전 적용과 비교하게 되고, 그
차이는 네이티브 계층 탓이 됩니다.

뺄셈은 2026-08-16 부터 컴포지터의 것입니다. 두 반쪽을 한 순간에 보유하는 쪽이 그것이기 때문입니다.
코어는 그날까지 자기 것을 따로 가지고 있었으므로 숫자 하나에 정의가 둘이었고, 사람이 읽는 값은 어느
경로가 답했는지에 달려 있었습니다.

## A2. 좌표 계약은 CSS 좌상단이다

두 반쪽 모두입니다. 플랫폼 자신의 원점은 드라이버 안에서 한 번 변환하므로, 읽는 쪽은 비교할 수 없는 두
숫자를 빼는 일이 없습니다. `surface.composition` 은 자기가 답하는 프레임을 이름 짓습니다.

## A2a. 요소가 움직이는 동안 선언을 다시 읽는다

표면이 어디에 소유되는지를 바꾸는 것은 셋입니다. 선언 노드에 쓴 속성, 그 상자의 크기 변화, 그리고 노드의
**이동**입니다. 앞의 둘에는 이벤트가 있습니다. 셋째에는 없습니다 — pane 의 위치를 애니메이션하는 엔진은
스타일을 쓰지도 크기를 바꾸지도 않습니다 — 그래서 mutation 과 resize 에서만 사각형을 다시 읽는 표면은
자기 pane 이 떠나는 동안 가만히 서 있습니다.

2026-08-17 실측, 왼쪽 위에 터미널, 그 아래에 브라우저, 오른쪽에 브라우저가 있는 창: pane 이 190ms 동안
165 에서 584 로 이동하는 내내 페이지는 165 에 머물렀고, 그다음 한 프레임 만에 반대쪽 끝에 나타났습니다.
포커스를 가진 pane 이 바뀌는 모든 이동에서 자기 pane 으로부터 420 포인트 떨어진 채 166ms 였습니다. 그
동안의 모든 합성 읽기는 어긋남 0 을 보고했습니다. 두 반쪽이 같은 낡은 commit 에서 왔기 때문입니다(A1).

그래서 관측자는 선언된 요소들을 프레임마다 한 번 측정하고, 그중 하나가 달라지면 commit 합니다. 가만히
있는 창은 아무것도 commit 하지 않습니다. 읽기는 프레임마다 사각형 몇 개이고, 차이가 있을 때만 스냅샷을
예약합니다. 이 변경 뒤 같은 여섯 이동에서 페이지는 자기 pane 에서 읽기 한두 번 안에 머뭅니다. 그것이
하한입니다. 사각형은 레이아웃 commit 뒤에 측정되고 프로세스 구분을 넘어 적용되기 때문입니다.

## A3. 반쪽만 있는 표면은 차이가 아니다

선언됐고 한 번도 적용되지 않은 것은 `unapplied` 로 갑니다. 화면에 있고 한 번도 선언되지 않은 것은
`undeclared` 로 갑니다. 원장만 보는 확인은 그것을 볼 수 없습니다. 그 확인이 걷는 것이 원장이기
때문입니다. 어느 쪽이든 차이에 접어 넣으면 차이가 없는 것에 숫자를 답하게 되고, 0 으로 접어 넣으면
표면이 없는 pane 을 옳다고 부르게 됩니다.

---

# V. 판정 — 무엇이 RED 인가

## V-1. 탭과 스페이스 전환은 녹화 프레임 시계를 사용한다

`tab.switchScan` 과 `space.switchScan` 은 유한한 `window.record` 녹화를 시작합니다. Recorder callback은
프레임 파일 하나가 저장된 뒤에만 실행되며 `applyAtFrame` 은 그 callback에서 대상을 활성화합니다.
활성화에는 고유한 `causeTraceId`가 붙고 검사는 그 정확한 layout transaction의 terminal event를
기다린 다음 event 기반 presentation barrier를 기다립니다. 요청한 시작 view가 완전히 표시된 뒤에만
녹화를 시작합니다. 그렇지 않으면 시작 view의 늦은 복구를 측정 대상 전환으로 잘못 분류합니다. 경과
시간을 기다리거나 layout 상태를 polling하지 않습니다.

저장된 각 프레임은 공개 visibility 모델에서 양쪽을 측정합니다. DOM view는 탭 슬롯의
`contentVisible=true`일 때 표시된 것입니다. Native view는 최신 compositor receipt의 live surface가
보이거나 `ParkedPicture`가 있어야 합니다. 내용이 보이는 동안 `surfaceVisible` 결정과 적용된 live
surface receipt가 일치해야 합니다. 결과는 `blankFrames`, `overlapFrames`, `nativeMismatchFrames`를
보고합니다. Pixel 판정은 Core `capture_analyze`를 사용하며 절대 잡음 바닥보다 크더라도 실측 전환
최고치의 40%보다 작은 변화는 추가 전환 프레임이 아닙니다.

Snap 또는 같은 geometry 전환은 pixel 전환 프레임이 정확히 하나여야 합니다. 선언된 glide는 캡처
프레임 여러 개에 걸칠 수 있으며, 이 경우 GREEN은 기록된 motion journey가 모두 finish이고 cancel·
incomplete가 없으며 blank, overlap, native mismatch 프레임이 모두 0인 상태입니다. WKWebView의 non-key
창에서는 완료된 animation 상태가 finish callback보다 먼저 보일 수 있습니다. 유한 검사는 마지막 상태를
한 번만 조정합니다. `finished`는 완료이고, 제거된 `idle` animation은 playback rate를 반영한 선언 시간이
지났으며 landed rectangle이 target과 0.5px 미만으로 일치할 때만 완료입니다. 더 이르거나 다른 위치에서
제거되면 cancel입니다. 이는 마지막 상태 읽기 한 번이며 polling이나 추가 대기가 아닙니다. 명령은 원래
탭 또는 스페이스를 별도의 정확한 layout transaction으로 복원합니다.

## V0. `sok layout.alignment` 가 사람이 보는 것이다

`surface.composition` 은 선언과 적용을 비교하고 둘 다 한 commit 에서 옵니다. 그래서 그 commit 이 낡은
동안에도 둘은 서로 일치하며, 자기 pane 에서 420 포인트 떨어져 그려진 페이지가 어긋남 0 으로
읽힙니다(A2a). 페이지가 **어디 있는지** 답하는 읽기는 선언 요소의 **지금**과 표면의 **지금**을
비교합니다.

```
dom        이 순간 선언 요소의 상자
declared   마지막 commit 이 보낸 상자, 요소에 되쓴 값
applied    네이티브 계층이 보유한 상자
lag        dom 대 declared      — 선언이 얼마나 뒤처졌는지
drift      declared 대 applied  — 네이티브 계층이 받은 것으로 무엇을 했는지
off        dom 대 applied       — 사람이 보는 전체 거리
regions[]  같은 패스에서 읽은 rail 들
panes[]    같은 패스에서 읽은 pane 들
over       페이지가 region 의 띠 안으로 얼마나 그려졌는지
```

region 과 pane 이 같은 패스에서 오는 이유는 이음매가 두 사각형의 차이이기 때문입니다. 한 프레임 차이로
읽으면 움직이는 창과 깨진 창을 구별할 수 없습니다 — 2026-08-17 실측으로 83 포인트 겹침이 나왔는데, 그것은
이동 중인 pane 에 대한 정직한 읽기 둘이었습니다.

**GREEN 은 변화 이후 읽기 한두 번 안의 `off` 와 `over`, 그리고 아무것도 움직이지 않는 동안의 0
입니다.**

## D4a. 페이지는 비켜서고 그 그림은 남는다

문서가 페이지 위에 그리는 모든 것은 실제로는 그 아래에 그려집니다. 카드, pane 을 가로지르는 rail, 폭을
가져가는 region 이 그렇습니다. 표면을 문서 아래로 놓는 z-index 는 없으므로, 그중 무엇이든 보여 주는
유일한 방법은 페이지를 화면에서 치우는 것입니다. 그리고 비어 버린 pane 은 사람이 그리기에 실패한 view
로 읽는 것입니다. 2026-08-17 에 두 반쪽이 그 말 그대로 보고됐습니다. 플러그인 관리자를 열자 브라우저가
비었고, 이동하는 rail 이 페이지 아래로 지나가면서 85 에서 119ms 동안 155 에서 160 포인트를 가렸습니다.

그래서 parked 표면은 자기 그림을 남깁니다. `ContentViewHost.picture(label)` 이 표면이 보여 주는 것을
data URL 로 답하고 — 그 종류 자신의 백엔드가 그것을 만들고 컴포지터는 메시지를 읽지 않고 전달하므로,
코어의 어떤 것도 브라우저나 엔진을 이름 짓지 않습니다 — 문서가 표면이 돌아올 때까지 같은 상자에
그것을 그립니다.

측정이 쓴 규칙 셋:

- **표면이 사라지기 전에 찍습니다.** 이미 숨겨진 표면에는 찍을 것이 없습니다.
- **페이지가 돌아올 때까지 유지하며**, 요청이 아니라 마지막 commit 의 답에서 읽습니다. 보이라는 요청이
  들어온 시점에 버렸더니 pane 이 읽기 한 번 동안 둘 다 없는 상태였습니다.
- **같은 활성 내용이 가려지는 동안만 유지합니다.** 비활성 탭·space·workspace 사슬은 그림을 놓습니다.
  그대로 두면 새 활성 소유자를 덮습니다. 레이아웃 움직임은 그림으로 바꾸지 않고 live surface를
  compositor transaction에 유지합니다.

그것이 무엇이라고 주장하는 것이 곧 그것이 하는 일입니다. 스크롤하지 않고, 클릭을 받지 않으며, 한 순간
낡았습니다. 그래서 가능한 순간 곧바로 표면을 되돌려 놓습니다.

이후 실측, 앞에 놓인 창에서 지정한 창의 포커스 이동 여섯 경로 전부: 페이지가 region 을 가리는 시간
0ms, 네이티브 계층이 문서의 사각형을 정확히 보유, 선언은 한 번도 뒤처지지 않음, 어떤 pane 도 자기 틀
없이 있지 않음.

## D4b. Capture-only snapshot도 같은 소유자를 합성한다

플랫폼의 capture-only window snapshot은 의도적으로 document-only이며 native child surface는 그
document의 픽셀이 아닙니다. 이것을 완전한 window screenshot으로 반환했을 때 engine state와 compositor
geometry가 모두 올바른 terminal도 빈 화면처럼 보였습니다.

`surface.snapshot {id}`는 선언되고 적용된 surface owner 하나의 정확한 PNG를 공개합니다.
`window.snapshot`은 framework receipt가 `documentOnly=true`일 때만 보이도록 적용된 모든 surface에
같은 owner interface를 사용합니다. Core는 각 그림을 요청한 CSS-pixel 영역으로 clip하고 PNG pixel
scale에 맞추며 applied alpha와 layer 순서를 보존해 document 이미지 위에 그립니다. 보이는 surface가
PNG를 반환하지 않으면 이름 붙여 실패합니다. 불완전한 이미지는 증거가 아닙니다. Interactive capture는
이미 compositor 픽셀을 포함하므로 다시 합성하지 않습니다.

v7 capture-only 실측은 window input을 전후 모두 non-key로 유지하면서 `nativeComposed=true`,
`surfaces=2`, `drawn=2`, `documentOnly=false`를 반환했습니다. 직접 확인한 이미지에는 두 native
terminal, 서로 다른 alpha, glyph, cursor, engine 소유 selection 범위가 모두 보였습니다. 유한한
`window.record` loop도 모든 frame에 같은 연산을 사용하며 호출자가 interval, frame count, frame별
deadline, byte budget을 명시합니다. v7 3-frame 실행은 화면이 변하지 않아 같은 SHA-256의 589,723-byte
PNG 세 개를 썼고, 각 frame에 두 native terminal과 selection이 들어 있었습니다. 전후 window input은
non-key를 유지했습니다.

## D4c. Native divider 주입은 요청 시간을 유지한다

`ui.input.drag`는 native pane divider에 지정한 `steps`와 `durationMs`를
`window_input_pointer_drag`에 전달합니다. Framework는 down 한 번, 지정한 유한 시간 동안 지정한 수의
move, up 한 번을 전달합니다. 이 명령은 window focus와 system pointer 위치를 변경하지 않습니다. 따라서
녹화된 drag는 최종 ratio만이 아니라 중간 DOM과 native-surface geometry도 측정할 수 있습니다.

## V0a. `sok layout.trace` 가 모든 프레임이 보유한 것이다

평면을 지나는 읽기 한 번은 왕복 비용이 듭니다 — 이 머신에서 15 에서 25ms 이고 프레임은 16.7ms 입니다.
그래서 한두 프레임 동안 자기 pane 보다 뒤처진 페이지는 운에 따라 표본 하나나 둘에 걸립니다. 같은 움직임이
한 실행에서는 0ms 로, 다음 실행에서는 52ms 로 기록됐고, 화면을 보던 사람이 옳았던 지점에서 읽기는
아무것도 말하지 않았습니다.

`layout.trace.start {ms}` 는 창 안에서, 애니메이션 프레임마다 한 번, 페인트 전에 기록합니다. 모든
region, 모든 pane, 모든 표면의 `dom` / `declared` / `applied` 입니다. 네이티브 반쪽은 마지막 commit 의
답이며 그 답에는 이미 적용된 사각형이 들어 있으므로, 그것을 위해 왕복하지 않습니다. 각 프레임은 다음을
진술합니다.

```
drawn          어느 시계가 기록했는지: 창의 프레임 시계, 또는 창이 그리지 않을 때 녹화를 유지하는
               타이머. 움직임에 대한 판정을 담을 수 있는 것은 앞의 것뿐이다.
appliedAgeMs   네이티브 반쪽이 얼마나 오래됐는지 — 읽기의 지연이 아니라 파이프라인의 지연
commitMs       그것을 나른 commit 의 비용
sinceLastMs    앞선 읽기로부터의 간격
tickMs         녹화가 그 프레임에서 든 비용(실측 1ms)
```

공개 프레임 시계가 멈춘 창은 아무것도 기록하지 않으므로, `layout.trace.start` 는 첫 읽기를 기다리고 빈
추적을 답하는 대신 그 이유와 함께 거부합니다. capture-only Darwin 창은 컴포지터에 남고 alpha 0 이며
non-key 이므로, 전면 애플리케이션을 가져가지 않고도 문서 프레임 시계를 유지합니다. 비공개 WebKit 가림
스위치나 `window.occlusion` 명령은 이 계약에 관여하지 않습니다.

2026-08-17 실측, 지정한 pane 셋짜리 창: 선언은 요소를 정확히 따르고(모든 경우 `lag` 0), 네이티브 계층은
받은 것을 그대로 보유하며(나이를 보정한 차이 0), commit 은 한가한 머신에서 1 에서 2ms, 부하가 걸린
머신에서 45 에서 71ms 이고, 창 자신의 프레임 시계는 17ms 마다가 아니라 18 에서 32ms 마다 돕니다.
페이지는 자기 pane 보다 commit 하나만큼 늦으므로, 사람이 보는 것은 그 두 숫자가 정합니다.

## V1. `sok surface.composition` 이 판정이다

```
worst                  모든 표면과 성분에 걸친 가장 큰 차이
unapplied[]            선언됐고 적용된 적 없음
undeclared[]           적용됐고 선언된 적 없음
misparented[]          선언한 창이 아닌 다른 창에 적용됨
nativeParentPresent    붙일 컨테이너가 있는지
failure/failedSequence 도착하지 못한 가장 최근 시도
```

**GREEN 은 `worst` 0, 모든 목록이 비어 있음, 실패 없음입니다.** 허용치 없이 정확히 0 입니다. 두 반쪽은
commit 하나를 함께 이동하는 같은 float64 이므로 0 에 닿을 수 있습니다. 측정 없이 고른 허용치는 다음 좌표
결함의 첫 100분의 1 포인트를 가립니다.

답은 **창마다** 나옵니다. `sok surface.composition window=<name>` 은 그 창 하나의 인벤토리이며 다른
창의 것이 아닙니다. 2026-08-16 실측, 창을 보지 않는 읽기: 오케스트레이터와 workspace 창이 각각 같은 표면
하나를 같은 사각형에서 어긋남 0 으로 답했는데, 브라우저가 있는 것은 그중 하나뿐이었습니다.

`misparented` 가 따로인 이유는 창이 거리가 아니기 때문이며, 그래서 `worst` 에 접히지 않습니다. 선언에서
되풀이하는 대신 네이티브 객체에서 되읽습니다. 백엔드가 view 가 어느 창에 들어갔는지 보고하고 컴포지터가
그것을 자기가 건넨 창과 비교합니다. 이 답의 다른 모든 숫자는 *어떤* 창 안의 사각형을 기술하므로, 사각형이
아무도 보지 않는 창 안에 있어도 전부 옳게 읽힙니다. 창을 보고하지 않는 백엔드는 믿는 대신 misparented
로 보고합니다. 창을 되읽는 기능이 구현되지 않은 백엔드가 만드는 것이 바로 그 무응답입니다.

`nativeParentPresent` 가 따로인 이유는 컨테이너가 없는 것과 선언이 없는 것이 둘 다 `worst` 0 인데 그중
하나는 깨진 창이기 때문입니다. `failure` 가 따로인 이유는 컴포지터가 마지막으로 도착한 인벤토리로 계속
답하므로, 새 인벤토리를 전부 거부하는 계층이 영원히 0 을 보고하기 때문입니다.

2026-08-16 macOS 999×535 에서, 그리고 1200×800 에서 다시 실측: 브라우저 표면 하나, 분할·gutter 크기
조절·최대화·복원을 거쳐 `worst` 0.

### V1.1. 모든 표면 종류는 인벤토리 하나를 사용한다

`surface.inventory` 는 현재 창의 공개 사실 세 가지를 비교합니다. 뷰 상태, DOM 네이티브 표면 선언,
컴포지터가 마지막으로 수락한 인벤토리입니다. 브라우저와 터미널 표면은 같은 명령과 같은 규칙을
사용합니다. `surface.composition` 은 좌표와 적용 판정이고, `surface.inventory` 는 소유권과 존재 판정입니다.

프레임워크 어댑터의 `list` 와 `alive` 는 컴포지터 receipt 를 읽습니다. DOM 선언은 요청이며 네이티브
계층이 수락했다는 증거가 아닙니다. 프레임워크 전용 webview 목록은 다른 표면 종류를 열거할 수 없으므로
불완전합니다. 이전 `webview.surfaces` 명령은 alias 로 남기지 않고 제거합니다.

표면의 창 필드는 공개 `<kind>.<window>.<view>` label 문법으로 해석합니다. 부분 문자열 검색과 종류 allowlist 는
금지합니다. 전자는 문장부호에 의존하고 후자는 새 표면 종류를 인벤토리에서 감춥니다.

마지막 label 필드는 창 안에서 표면을 식별하며 뷰 소유권을 추론하는 값이 아닙니다. 터미널 뷰 하나가 pane
표면 여러 개를 선언할 수 있습니다. 소유권은 선언의 공개 `data-tab-id` 상위 요소에서 읽습니다. 인벤토리는
누락된 관계를 각각 보고합니다.

```
ghosts[]    컴포지터가 수락했지만 DOM 선언에 없음
unowned[]   선언되고 수락됐지만 현재 상태 뷰가 선언을 소유하지 않음
unapplied[] DOM 에 선언됐지만 수락된 컴포지터 인벤토리에 없음
orphans[]   label 이 활성 parent window 를 가리키지 않음
```

## V2. 동사는 선언이 아니다

back, forward, reload, stop 은 선언된 source 를 있는 그대로 두므로 선언으로 표현할 수 없습니다. 그것들은
메시지로 이동합니다. 컴포지터는 그 표면이 적용된 인벤토리에 있는지 확인하고 읽지 않은 채 전달하며, 그
종류의 백엔드가 동사를 읽습니다. 동사를 아는 컴포지터라면 종류가 추가될 때마다 고쳐야 합니다.

`navigate` 는 새 주소를 기록에 되씁니다. 선언된 값에 그대로 두면 다음 commit 이 source 가 바뀐 것으로
보고 표면을 원래 자리로 다시 만듭니다.

## V3. 페이지가 자기에 대해 진술하는 것은 자기가 요청받은 것과 다르다

리다이렉트, 실패한 적재, 아직 진행 중인 적재는 모두 선언된 주소에서는 보이지 않고, 아직 칠해지지 않은
화면에서는 셋이 같아 보입니다. `pageState` 는 표면을 읽습니다. 보고는 같은 사실을 일어나는 대로
밀어내며, 페이지가 이미 듣고 있는 content view 이벤트로 나뉩니다(`core/contentview`).

상태 전체가 보고 하나로 이동합니다. 그 뒤에 두 번째 속성을 읽으면 나중 순간에 대해 답하게 되고, 한 프레임
일찍 켜진 뒤로 가기 버튼이 그 차이가 눈에 보이게 된 것입니다.

## V4. 모든 거부는 이름을 담는다

알 수 없는 동사, 빠진 url, 0 인 step, 이 백엔드가 보유하지 않은 표면, 종료 뒤의 메시지가 그렇습니다.
아무 말도 없으면 호출자는 화면이 동의하지 않는데도 페이지가 이동했다고 보고합니다.

---

# K. 알려진 것, 고치지 않은 것

다시 발견하게 두는 대신 적어 둡니다(L2).

- **캡처는 합성물이며, 답이 그것을 진술합니다.** 창 캡처는 이 프로세스 자신의 계층을 보유합니다.
  네이티브 표면은 다른 프로세스에서 그리므로 그 사각형은 평평하게 도착합니다(2026-08-16 실측: 같은
  표면의 `status` 가 제목 "Example Domain", 진행 1, loading false 를 답하는 동안 브라우저 pane 은 단색
  블록이었습니다). 캡처는 각 표면에 자기 픽셀을 요청해 이미지를 완성하고, 답은 `surfaces`, `drawn`,
  그리고 `skipped` 각각의 이유를 이름 짓습니다.

  **합성물은 무엇이 화면에 있다는 증거가 아닙니다.** 그것은 인벤토리가 기록한 사각형에 표면의 픽셀을
  그립니다. 사람이 그 사각형을 볼 수 있든 없든 그렇습니다. 인벤토리가 창별이 되기 전인 2026-08-16 실측:
  오케스트레이터의 캡처가 workspace 창의 브라우저를 그 안에 그렸는데, 좌표는 1300×900 문서가 계산한
  것이었고 창은 999×617 이었습니다. 그 그림은 어느 쪽에도 없던 페이지의 그림이었습니다. "이것이 화면에
  있는가" 는 `sok window.monitors` 의 `presence` — `visible`, `key`, `main`, `miniaturized`,
  `occluded`, `alpha` — 와 `sok surface.composition` 의 `misparented` 로 읽습니다.
- **Windows 와 Linux 에는 드라이버가 없습니다.** 이름과 함께 실패합니다. nil 을 답하는 빈 구현은 이동이
  끝났다고 보고하면서 pane 을 비워 두게 되고, 그것은 이 빌드가 다루지 않는 플랫폼이 아니라 깨진
  플러그인으로 읽힙니다.
- **이동 보고의 `inPage` 는 항상 false 입니다.** 이 호스트가 관측하는 속성으로는 문서 안의 이동과 새
  문서를 구분할 수 없습니다. true 라고 주장하면 문서가 바뀌었을 수도 있는데 바뀌지 않았다고 소비자에게
  말하게 됩니다.

### Browser release 멱등성 — 2026-08-30

Browser 0.0.12는 login-shell tool 계약으로 SDK 0.0.18을 선택합니다. source commit `d5a87a6`에서
서로 독립적으로 실행한 `make attest` 출력 두 개는 같은 6개 파일을 포함했고 byte 단위로 같았습니다.
완료된 첫 출력에 다시 attest하자 release와 build receipt가 모두 `unchanged`를 반환했습니다. 같은
출력을 local release store에 게시한 결과는 `published` 뒤 `unchanged`였으며 store digest는
`2f9a12b7601d89be9326c0c9f784c707982b4ba2502af832fa8ce70700dde6a0`입니다.

격리 capture-only 설치는 artifact
`2cefbcbbdf96ebbb7e0830ccc5c5f9c023859d86bf49d2722a052eb2fcafe79f`를 해석했고 Example Domain을
`progress=1`까지 로드했으며 coordinate drift가 0인 native surface 하나를 보고했습니다. capture에는
browser chrome과 합성된 native page가 함께 보였습니다.

### Browser tab 전환 관측 — 2026-08-30

격리 browser 0.0.11에서 같은 pane에 native tab 두 개를 열고 `tab.switchScan`을 실행했습니다.
30 frame의 기계 결과는 `clean=true`, `flickerFrames=0`, `blankFrames=[]`, `overlapFrames=[]`,
`nativeMismatchFrames=[]`였습니다. 포커스를 주지 않은 캡처에는 두 tab header와 활성 Example Domain
페이지가 보였습니다. 별도로 pane만 지정한
navigation은 같은 pane의 여러 tab을 구분하지 못한다는 RED를 확인했습니다. browser 0.0.10이 명시적
`tab` target을 추가했고, browser 0.0.11은 모든 browser command에 그 target을 적용했습니다.
runtime `navigate(tab=...)`와 `status(tab=...)`가 두 tab의 일치하는 webview ID를 반환했으며,
0.0.11 candidate는 51개 테스트가 GREEN이고 local immutable release로 저장됐습니다.

Browser 0.0.12는 clean owner checkout에서 SDK 0.0.18의 `make attest`로 다시 생성했습니다. Generated
`main.js` check, typecheck, 51개 test, 두 candidate byte 비교, package receipt, native attestation이 모두
통과했습니다. 독립적으로 생성한 release를 같은 immutable local version에 publish한 결과는
`unchanged`, digest `2f9a12b7601d89be9326c0c9f784c707982b4ba2502af832fa8ce70700dde6a0`이었습니다.
Browser frontend output은 mutable source directory나 기억한 `dist`가 아니라 선언된 release artifact입니다.

### 보더 geometry 관측 — 2026-08-30

arm64 Core의 격리 browser release 0.0.9에서 선택한 workspace의 browser surface는
`(x=5,y=120,w=989,h=468)`이었습니다. pane frame과 focus boundary는 모두
`(x=5,y=87,w=989,h=525)`였고, frame은 1px 구조 border, focus boundary는 1px outline을
보고했습니다. 두 rectangle이 일치하므로 이 실행은 browser 보더 geometry에 대해 GREEN입니다.
수정된 kit release를 사용하는 terminal을 설치해 같은 selector를 측정하기 전에는 terminal parity를
증명하지 않습니다.

### Browser와 terminal 혼합 lighting — 2026-08-30

격리된 2-pane layout에 browser tab 3개와 terminal tab 2개를 열었습니다. 수정 전에는 같은 idle
amount에서 browser page의 원래 238 중 183이 남았지만 terminal은 원래 255 중 127만 남았습니다.
native view를 fade하면 이미 dim된 document와 다시 섞이므로 `alpha=0.5`가 50% retained light를
뜻하지 않았습니다.

native webview service는 이제 각 native host에 대해 window compositor 계층에 pointer-transparent
black veil을 둡니다. capture-only compositor도 같은 연산을 사용합니다. page를 opaque로 그린 뒤
`1 - alpha`인 검은 veil 하나를 그립니다. 결과는 browser `238→119`, terminal `255→127`로 integer
pixel 반올림 범위에서 둘 다 50%였습니다. pane focus를 20회 왕복한 뒤에도 browser는 119를 유지해
veil이 누적되지 않음을 증명했습니다.

활성 pane frame과 focus-boundary rectangle은 양쪽에서 각각 같았습니다. 왼쪽은
`(5,87,489.5,525)`, 오른쪽은 `(504.5,87,489.5,525)`입니다. 두 pane에서 양방향으로 실행한 네 번의
30-frame browser↔terminal scan은 모두 switch frame 하나로 끝났고 flicker, blank, overlap, native
mismatch, cancelled motion, incomplete motion frame이 모두 0이었습니다.

### Plugin 교체 중 native display 수명 — 2026-08-30

격리 설치 제품에서 terminal surface 세 개를 실행한 채 Browser 0.0.12를 enable하자 Core가
`SIGSEGV`로 종료됐습니다. Channel frame callback의 `soksakChannelDisplay`와 compositor의
`soksakTerminalSurfaceRemove`가 같은 borrowed native view에 동시에 접근했습니다. Terminal engine,
Browser, PTY의 결함이 아니라 native object 수명 경쟁이었습니다.

terminal-surface service `ec576f9`는 두 규칙을 시행합니다. Backend는 native driver가 view 소유권을
넘겨받아 release하기 전에 channel binding을 제거합니다. Frame callback은 channel mutex를 잡은 동안
bound view와 IOSurface를 각각 retain하고, mutex를 푼 뒤 main thread에서 display하고 두 short lease를
release합니다. 이름 있는 RED는 native release가 unbind보다 먼저 실행됐음을 증명했고 GREEN은
unbind가 release보다 먼저이며 display lease는 channel lock 안에서 얻고 display는 lock 밖에서 실행함을
증명했습니다. Service owner 전체 gate는 GREEN입니다.

수정된 Core는 Browser가 enabled인 동일 environment에서 terminal tab 세 개를 복원하고 Example Domain
browser tab을 열었습니다. Browser disable→enable 교체 뒤에도 Core PID는 같았습니다.
`surface.inventory`는 state view 네 개와 applied surface 네 개, ghost·unowned·unapplied·orphan 0을
보고했습니다. Terminal↔terminal 세 번과 browser↔terminal 세 번의 24/30-frame scan은 모두 switch
frame 하나, flicker·blank·overlap·native mismatch·cancelled motion·incomplete motion 0이었습니다.
Non-key composed capture에는 browser와 tab header 네 개가 보였고 전후 `windowFocused=false`였습니다.

같은 설치 상태는 공통 composition·border gate도 통과했습니다. `surface.inventory`는 declaration 네 개와
accepted surface 네 개, ghost·unowned·unapplied·orphan 0을 보고했습니다. `surface.composition`은 terminal
surface 세 개와 browser surface 모두 drift 0, misparented 0이었습니다. `layout.verify`가 pane과 focus
boundary를 같은 `(5,87,989,525)`로 측정했고 `worst=0`이었습니다. Terminal과 browser Plugin body도 모두
`(5,120,989,468)`이었습니다. Browser webview만 `y=151`, height 437인 이유는 선언된 31px browser chrome이
`y=120..151`을 사용하기 때문이며 compositor inset이 아닙니다. `ui.validate`는 element 14개에서 border
rule 34개를 검사해 violation 0을 보고했고 composed capture에서 focused outline 네 변이 모두 보였습니다.
