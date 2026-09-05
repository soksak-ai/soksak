---
kind: canonical
status: active
canonical: PANE-PLANE.md
---

# pane 평면 — 스페이스마다 평면 하나, 배치는 라이브러리가

스페이스는 자기 pane 들을 공유 격자선 하나의 평면 위에 둔다. 그 평면은 `split-pane`
라이브러리 (`frontend/package.json` 의 의존성) 의 것이다. 코어는 pane, 변, 선을 지정하고
라이브러리가 만든 상태를 돌려받는다. 코어가 그리는 모든 rect·divider·drop
zone 은 그 상태에서 px 로 읽는다. 코어 안에서 rect 를 계산하는 곳은 없다.

## 범위

코어가 라이브러리로 무엇을 대체했는지, 라이브러리에 없어서 코어가 자기 상태 위의 표현으로
남긴 것이 무엇인지, 그리고 규칙과 그 검사 지점. 사이드바의 섹션은 자기 split tree
(`state/splitTree.ts`) 를 그대로 쓴다. 사이드바는 스페이스 안이 아니다.

날짜가 따로 없으면 2026-09-05 에 지정된 창에서 실측했다.

---

# A. 무엇이 무엇을 대체했는가

코어의 이전 개념, 그 자리를 맡는 라이브러리 개념, 판정. *대체* 로 표시된 행은 코어 구현이
남아 있지 않다.

| 코어 (이전) | 라이브러리 | 판정 |
| --- | --- | --- |
| `SplitTree<Pane>`, `sizes` 비율의 재귀 트리 | `SplitPaneState`: 공유선 `xs/ys` 와 카드마다 span (R1) | 대체 |
| `computeSplitLayout` — 퍼센트 셀과 폭 0 거터 | `rects()`, `dividers()` px | 대체 |
| 모든 셀 사방의 `PANE_INSET` | 복도 `gap` (R5: 안쪽 변에 half gap, 테두리는 flush); 평면 = 호스트를 pane inset 만큼 안쪽으로 | 대체, 같은 기하 |
| `verticalLines.ts` — 허용치 안의 x 를 묶어 한 선으로 이동 | R1: 선은 숫자 하나; `moveBoundary(axis, line)` | 대체 |
| `MIN_PANE_FRAC` 과 `minPaneFracForSpan` | px 의 `minSize`: `MIN_PANE_PX` = 헤더 밴드 셋 + 푸터 | 대체 |
| 트리 순회로 얻는 `gutterAddress` | 카드 span 이 변의 선을 이름 짓는다; 주소 형식 `pane+edge` 는 그대로 | 대체 |
| `hitTestCells`, 5구역 | `zoneAt(x, y, {headerPx, footerPx, centreOnly})` | 대체 |
| `insertBeside`, `removeLeaf`, 이동 = 제거 후 삽입 | `splitToward` (R4), `close` (R7), `move` — 각각 한 연산 | 대체 |
| `(host − railWidth)` 위의 퍼센트 rail station, `projectRailCssRect`, `unprojectRailX`, `snapRailStation`, `cleanRailLines` | rail 은 `width` 를 가진 `fixed` 카드 (R2); `standings`, `insertAt`, `moveTo` | 대체 |
| 숫자로 저장하고 clean line 으로 검증하던 PIN station, `LAYOUT_CONFLICT` | 카드의 slot 이 곧 위치이고 slot 은 가로지를 수 없다 (R3): `{mode: "pin"}` 만 | 대체; 오류 코드 소멸 |
| station 을 보존하던 `railWidthResize` | R5: 폭이 선언된 카드 옆의 드래그는 그 폭을 바꾸고 반대쪽 slot 이 값을 치른다 | 대체 |
| `serializeSplitTree` 와 복원 마이그레이션 (`vlNormalized`, `railPlacementNormalized`) | `toJSON()` 과 `checkState()`; 옛 레코드는 이름을 대고 거부 | 대체 |

라이브러리에 없는 것. 이것들은 `state/panePlane.ts` 에서 라이브러리 상태 위에 계산한 표현이지
두 번째 기하가 아니다.

| 라이브러리에 없는 것 | 코어의 seam |
| --- | --- |
| rail 이 옆에 설 수 있도록 포커스 pane 을 왼쪽 pane 과 교환 | `pullToFront`: 같은 행에서 선을 비우는 가장 가까운 교환, 각 pane 은 자기 폭; 표시 전용, 저장 안 함 |
| pane 하나를 스페이스 전체로 | `soloPlane`: 그 pane 과 rail 의 평면, rail 은 서 있던 쪽에 |
| 축의 모든 slot 을 균등하게 | `equalizeAxis` (`centerBoundary` 는 라이브러리 것) |
| SIDEBAR S2, 포커스 pane 에 대해 rail 이 설 선 | `flowRailLine`: pane 왼쪽 변 이전의 가장 가까운 standing, rail 없는 평면에서 측정 |

라이브러리 소관이 아니어서 코어에 그대로 두되 입력이 px 로 바뀐 것: rail 과 옆 pane 의 관계
테두리, 배치 phase 와 journal (SIDEBAR T), 명령으로 바뀐 rect 를 보간하는 rect tracker, 이동 전
네이티브 서피스 staging. 라이브러리의 DOM 바인딩 (`SplitPaneView`) 은 쓰지 않는다. 여기서
pane 하나는 여섯 층 (cell, frame, focus boundary, slot, picture, lighting) 을 CSS 규칙 하나로
배치하고, slot 은 view 로 키가 잡혀 pane 사이 이동에서 remount 되지 않는다 — 카드당 엘리먼트
하나라면 remount 된다.

---

# P. 평면

## P1. 스페이스마다 평면 하나, 소유자는 라이브러리

`Space.layout` 은 라이브러리 상태이고 `Space.panes` 는 각 pane 이 든 것이다. 둘은 pane id 로
이어지고, rail 을 뺀 평면의 모든 카드는 pane 이다 (`normalizeActiveGroupC` 가 아니면 던진다).
`split-pane` 을 import 하는 파일은 `state/panePlane.ts` 하나다.

검사: `frontend/src/state/panePlane.test.ts`, `frontend/src/state/paneInvariant.test.ts`.

## P2. 평면은 px 이고 상자는 실측한다

평면은 콘텐츠 영역의 안쪽 직사각형 — 호스트를 사방 `--pane-inset` 만큼 안쪽으로 (UI-GEOMETRY
R1b) — 이고 복도는 그 inset 의 두 배다. 호스트가 `state/planeBox.ts` 에 실측해 두고, 소켓으로 온
명령도 드래그와 같은 상자에서 배치한다. 첫 실측 전 상자는 0×0 이다. 첫 렌더는 그 안에서
그리되 rail 을 비추지 않고, 스토어는 그 위에 아무것도 배치하지 않는다 (폭 0 평면에서는 모든
standing 이 px 0 이라 포커스 pane 에 고른 선이 마지막 선이었다).

선언한 rect 와 그려진 rect 는 디바이스 픽셀까지 같다. `layout.verify` 는 pane 하나에서
`settled true, worst 0`, rail 이 선 pane 셋에서 분할·리사이즈·이동·최대화·복귀에 걸쳐 `worst
0.009–0.016` 을 답했다.

검사: `frontend/src/components/GroupArea.render.test.tsx`,
`frontend/src/commands/catalogLayoutVerify.test.ts`.

## P3. 선은 pane 과 변으로 지정한다

선 앞에 선이 하나 더해지면 번호가 밀리므로 번호는 이름이 아니다. `pane.resize` 와
`pane.equalize` 는 선을 `{pane, edge}` 로 지정한다. 정본은 그 선 위에 변이 선 pane 중 읽기
순서 첫 pane 의 right|bottom 이고, left|top 은 입력 별칭이다. DOM 의 divider 도 같은 주소
(`gutter/<pane>/<edge>`) 를 단다.

`ratio` 는 선 앞 slot 을 그 선에서 만나는 두 slot 의 합으로 나눈 값이며 **선이 서 있는 px 에서
잰다**. 폭이 선언된 slot (rail) 은 그 폭으로 그려지지만 선 위의 몫은 그것이 아니다. 비율을
선에서 읽던 동안 rail 옆 80px 드래그는 26.5px 에 내려앉았다.

검사: `frontend/src/lib/gutterAddress.test.ts`, `frontend/src/commands/paneGutter.test.ts`.

## P4. 바닥 아래 분할은 평면이 거부한다

어느 반쪽도 `MIN_PANE_PX` 를 지킬 수 없으면 `splitWithNewView` 는 `TOO_SMALL` 을 답하고 아무것도
하지 않는다. 바닥은 라이브러리의 것이지 DOM 실측이 아니다.

검사: `frontend/src/commands/paneSplitFloor.test.ts`.

---

# R. 평면 위의 rail

## R1. rail 은 카드이고 평면과 함께 저장된다

세트가 서 있는 동안 rail 은 활성 스페이스 평면 위의, 폭이 선언된 `fixed` 카드이며 평면과 함께
저장된다. `settleRail` 은 FLOW 에서 포커스 pane 옆에 세우고 PIN 에서는 그대로 두며, 서는 세트가
없으면 물린다. 물릴 때 공간은 가져왔던 slot 으로 돌아가므로 (R5) pane 들은 비율을 지킨다. 물린
slot 이 남긴, 카드 없는 선은 지운다 (`tidy`): 두면 다음 stand 마다 그 옆에 내려앉아 두 열에 선이
넷, 그다음엔 겹친 쌍까지 다섯이 됐다.

검사: `frontend/src/state/sessions.railPlacement.test.ts`, `frontend/src/state/panePlane.test.ts`.

## R2. 서 있는 동안 rail 의 폭은 평면의 것

rail 의 어느 쪽 선을 끌든 평면 위의 폭이 바뀌고 (R5) place 의 폭이 메모리에서 따라오며 제스처가
끝날 때 기록된다. `sidebar.width` 는 둘 다 쓴다. 설정값은 rail 을 처음 세울 때 읽고, 서 있는
rail 은 자기 폭을 지킨다 — 부팅 시 settle 이 드래그로 399.7 이 된 rail 에 설정값 320 을 다시
씌운 적이 있다.

한계는 평면 위에서도 place 의 것이다 (`PLACE_WIDTH_BOUNDS.rail`, 160–640). 평면 자체의 바닥은
pane 의 것이므로, rail 의 어느 쪽 선이든 rail 이 place 의 한계 안에 남는 만큼만 움직인다
(`state/panePlane.ts` 의 `moveLine`). 2026-09-05 실측: pane 과 rail 사이 gutter 드래그가 rail 을
pane 바닥 123 까지 줄였고 그 값이 place 폭에 기록됐다 — rail 의 resizer 와 `sidebar.width` 가
거부하는 값이다.

검사: `frontend/src/state/sessions.moveBoundary.test.ts`,
`frontend/src/state/panePlane.test.ts` ("holds the rail to the place's width bounds").

## R3. 이동은 같은 상자의 평행 이동이다

phase 는 모양이 바뀌지 않고 자리만 바뀐 pane 을 움직인다. 복도의 절반 안의 폭·위치 변화는 같은
상자다. rail 이 평면 테두리에 내려앉으면 이웃에 half gap 을 물리는데 (R5), 그 2.7px 때문에 모든
rail 이동이 여정 없는 snap 이 됐었다. `layout.transition.journal` 은 이동을 보여준다: 포커스
pane 의 이웃이 rail 폭만큼 움직인 `traveling` 과 `railSurfaces 1`, 그다음 `settled`.

검사: `frontend/src/lib/railArrangement.test.ts`.

## R4. `rail.position` 은 선 번호를 받는다

`rail.position {mode: "pin", line}` 은 활성 스페이스 평면에서 rail 이 설 수 있는 선
(`standingLines`) 으로 rail 을 옮기고 고정한다. 설 수 없는 선은 거부한다. `effectiveStation` 과
`cleanLines` 는 px 다.

검사: `frontend/src/commands/catalogRailPosition.test.ts`.

---

# S. 저장

저장된 스페이스는 `{groups, plane}` 이다: 각 pane 이 든 것, 그리고 라이브러리가 말하는 그대로의
평면 — 선, 모든 카드의 span, rail 의 slot 과 폭, `paidBy`. `layout` 아래 split tree 를 든
레코드는 2026-09-05 이전 것이며 이름을 대고 거부한다. 다른 모양의 rail placement 는 표현이라
그 필드만 잃는다 (RESTORE R1). 창 `win-j6jvtf` 는 재시작 후 pane 셋과 자기 선 위의 rail 로
돌아왔다.

검사: `frontend/src/state/windowSnapshot.test.ts`, `frontend/src/state/windowSnapshotShape.test.ts`,
`frontend/src/state/restoreKeepsIds.test.ts`.

---

# K. 알려졌고 고치지 않은 것

- 평면 테두리 예외 (R5) 는 rail 이 테두리에 서거나 떠날 때 이웃의 폭을 최대 half gap 만큼
  바꾼다. 라이브러리의 규칙이고 그대로 그려진다. 코어는 숨기지 않고 R3 에서 허용한다.
- `tidy` 이전에 저장된 평면은 카드 없는 선을 들고 있을 수 있다. 다음 close 나 withdraw 에서
  사라진다. 저장된 레코드를 고쳐 쓰는 것은 없다.
