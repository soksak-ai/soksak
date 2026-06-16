# 창밖 풍경 (soksak-plugin-window)

좌측 사이드바 하단에 **창밖 풍경**을 띄운다. 흰 액자 안의 하늘·해·달·별·구름·산·언덕·땅·나무가
**현재 시각**을 따라 변한다 — 아침엔 해가 뜨고, 저녁엔 노을이 지고, 밤엔 달과 별이 뜬다.
전환은 1초에 걸쳐 부드럽게 일어난다.

## 시간대

현지 시각 기준 자동 추종(토글 없음):

| phase | 시각 |
|---|---|
| `day` | 07:00–16:59 |
| `sunset` | 17:00–18:29 |
| `dusk` | 18:30–19:59 |
| `night` | 20:00–06:59 |

## 권한

- `ui` — 좌측 사이드바에 뷰를 띄운다(호스트가 배치 소유).
- `commands` — 아래 두 명령을 등록한다.

현재 시각은 로컬 `Date` 로 읽으며 네트워크·저장소 권한은 쓰지 않는다.

## 명령 (CLI/MCP 자동 노출)

```bash
sok plugin.soksak-plugin-window.state
# → { phase, forced, auto, now, nextPhase, nextInMs }

sok plugin.soksak-plugin-window.set '{"phase":"night"}'   # 강제(미리보기/검증)
sok plugin.soksak-plugin-window.set '{}'                  # 자동 추종 복귀
```

## 성능

애니메이션 루프가 없다. 다음 시간대 경계까지 `setTimeout` 1개만 예약하고(폴링 없음),
전환 순간에만 1초 CSS transition 이 돈다 — 위치는 `transform`(레이아웃 0), 색은 `fill`.
유휴 시 CPU 0.

## 크레딧

원작: **oliviale (Olivia Ng)** 의 CodePen "CSS Animations Experiment Part II"

- 원본: <https://codepen.io/oliviale/pen/ELPvLM>
- Part I: <https://codepen.io/oliviale/details/jxPgKv>

원본은 jQuery + Pug + SCSS + 수동 4토글(Dusk/Day/Sunset/Night). 이 플러그인은 SVG 아트워크를
그대로 가져오되 jQuery 를 걷어내고 순수 DOM·시각 자동 추종으로 포팅했다. 원작 SVG 의 저작권은
원작자에게 있으며 라이선스는 원본 CodePen 을 따른다 — 재배포 시 이 크레딧을 유지할 것.
