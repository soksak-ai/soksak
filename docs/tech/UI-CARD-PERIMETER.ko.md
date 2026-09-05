# 카드·레일 외곽선 계약

이 문서는 sidebar, pane, DOM surface, native surface가 같은 카드 규칙을
사용하기 위한 정본이다. 구현의 현재 상태를 설명하는 문서가 아니라, 구현이
따라야 하는 계약이다.

## C1. 카드가 유일한 perimeter 단위다

sidebar와 pane은 모두 `layout-card` 구조를 갖는다. 역할을 구분할 때는
`layout-card--sidebar` 또는 `layout-card--pane` modifier만 추가한다. 역할별로
다른 DOM 순서, 다른 perimeter 계산, 다른 간격 공식을 만들지 않는다.

카드의 공개 구조는 다음 순서를 따른다.

```text
layout-card
└── card-chrome
└── card-surface
└── card-status
```

native surface는 카드의 body slot 안, perimeter 안쪽에 배치된다. slot 이 border 의
lane 을 지불하므로(UI-GEOMETRY B5) 하나의 perimeter 는 DOM 이 한 번만 그린다.

## C2. 테마가 카드 모양을 결정한다

테마는 카드의 radius, border token/width, background, shadow를 선언한다.
DOM은 이 선언을 곳곳에서 해석하지 않고 동일한 정규화 결과를 소비한다. `flat`, `card`, `floating`은 표시 토큰의 차이일 뿐 구조 분기가
아니다.

## C3. rect는 한 번만 계산한다

layout solver가 `CardRect`를 한 번 계산하고 공개한다. sidebar, pane, surface
slot, native perimeter, inspector는 이 `CardRect`를 읽는다. `railStation`,
`targetRect`, `railWidth`를 조합해 같은 사각형을 다시 만드는 보조 계산은
카드 perimeter에 사용할 수 없다.

공개 상태에는 최소한 `cardId`, `role`, `rect`, `themeRevision`,
`geometryOwner`가 있어야 한다. `geometryOwner`는 하나의 카드에 하나만
존재해야 한다.

## C4. rail은 카드와 별도의 connector다

rail은 카드 perimeter와 구분되는 별도 연결선이다. rail은 grid의 gap을 지나
카드 perimeter 를 드나들 수 있으므로, 카드 자체의 border와 동일한 도형으로
합치면 안 된다.

rail의 기하 소유자는 하나의 `rail-connector`로 고정한다. connector의 시작·종료
점과 굴곡은 canonical `CardRect`의 안쪽 외곽선에서 산출하며, 임의의
`railStation + railWidth + targetRect` 재계산으로 만들지 않는다. 카드에
들어가는 접점은 카드 border와 같은 token·stroke 규칙을 사용하고, gap을
통과하는 선은 connector 규칙을 사용한다.

관계 오버레이는 rail/pane/union 카드 외곽선을 그리지 않는다. rail connector와
카드 perimeter는 서로 다른 소유자지만 같은 rect·theme revision을 소비한다.

## C5. 검증 기준

RED는 다음을 기계적으로 검출해야 한다.

- sidebar와 pane의 공통 `layout-card` 구조·순서 누락
- 하나의 `cardId`에 둘 이상의 `geometryOwner`
- DOM rect와 native perimeter rect 불일치
- relation overlay의 rail/pane/union perimeter path 생성
- 동일한 rail connector를 둘 이상의 레이어가 생성
- rail connector의 카드 접점이 canonical CardRect perimeter에서 벗어남
- 테마별 radius·border token 불일치

GREEN은 동일한 `CardRect`와 token으로 DOM/native를 각각 검증하고,
`window.snapshot`으로 모든 native surface 위의 perimeter를 사람이 확인한다.
