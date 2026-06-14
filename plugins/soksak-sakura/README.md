# sakura 벚꽃

앱 위로 벚꽃 잎이 흩날립니다. 좌우로 흔들리며 3D로 텀블해 떨어지고, 바람에 옆으로 흐릅니다. 화면을 벗어난 잎은 위로 재활용됩니다.

## 명령

- `toggle` — 켜기/끄기
- `density n` — 꽃잎 수(5~150, 기본 32)
- `fall speed` — 낙하 속도 배수(0.3~3)
- `wind strength` — 바람 세기(-2~2, 음수=왼쪽)

## 퍼포먼스 계약

부차 효과라 앱 성능에 영향 0을 목표로 합니다:

- **단일 `<canvas>` 1장**에 모든 꽃잎을 그린다 — 합성 레이어 1개(DOM 꽃잎 N개 = 레이어 N개 +
  3D 재합성으로 비쌌던 초판을 교체). 3D 텀블은 2D `scaleX(cos)` 플립으로 흉내(GPU 싼값).
- DPR 1.5 상한(꽃잎은 본래 소프트 — 레티나 불필요)으로 캔버스 픽셀·클리어 비용 절감.
- 프레임 상한 60fps, 매 프레임 레이아웃 읽기 없음.
- **비포커스·숨김·비가시 시 완전 정지** — throttle 이 아니라 rAF 중단(0 비용). 안 볼 때는 멈춘다.
- 꽃잎은 화면을 벗어나면 재활용 — 객체 생성/제거 없음.

영감: [jhammann/sakura](https://jhammann.github.io/sakura/), [ludwan/cherryBranch](https://github.com/ludwan/cherryBranch).
