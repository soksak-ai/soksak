# soksak-plugin-shark

앱 위를 **유유자적 헤엄쳐 다니는 SOKSAK 상어 마스코트** 플러그인. 워드마크 SOKSAK
자체가 상어(S=머리, K=꼬리지느러미)이고, 그 상어가 창 전체를 상하좌우 자율주행한다.
**이동 속도가 헤엄 역동(1~10단계)과 연동** — 멀리 질주할 땐 꼬리를 격렬히 치고,
느긋이 순항할 땐 잔잔하게 흐른다.

## 설치 / 활성화

```
# git 저장소를 ~/.soksak/plugins/ 로 clone 하거나, dev 로 로컬 경로 로드
sok plugin.dev.load '{"path":"/path/to/soksak-plugin-shark"}'   # 개발 로드
```

활성화하면 즉시 상어가 헤엄을 시작한다.

## 명령

| 명령 | 설명 |
|---|---|
| `plugin.soksak-plugin-shark.toggle` | 상어 보이기/숨기기(숨기면 rAF 완전 정지) |
| `plugin.soksak-plugin-shark.mode '{"reactive":true}'` | 반응형 on/off — on 이면 커서가 가까이 오면 슬쩍 피한다(off=순수 장식, 통과) |
| `plugin.soksak-plugin-shark.speed '{"liveliness":1.5}'` | 활기 배수 0.3~3 (이동·헤엄 전반 속도) |

## 어떻게 동작하나

- **헤엄 = 순운동학 사슬(forward kinematics)**: 머리(SO)는 강체로 목에서 함께 yaw
  (+ S\|O 미세 분리), 몸통(K·S·A) 관절각이 머리→꼬리로 전파·누적되어 꼬리(K)가
  최대로 쓸린다(후방 집중 thunniform — 실제 상어 추진). 관절은 연결되어 끊기지 않는다.
- **속도→역동**: 현재 속도를 1~10 레벨로 매핑해 관절각 진폭·헤엄 주파수를 조절한다.
  평소 잔잔(1~3), 먼 목표로 질주하면 8~10.
- **브라우저 위도 지나간다**: 상어는 메인 webview 의 DOM 오버레이다. soksak 의
  레이어 역전(DOM 이 항상 네이티브 브라우저 webview 위에 합성됨) 덕에 브라우저 패널
  위로도 자연스럽게 헤엄친다.

## 퍼포먼스 (부가물 — 앱에 영향 0)

- **격리된 합성 레이어**: `position:fixed` + `contain:strict` + 래퍼 `will-change:transform`
  이라 상어 애니메이션이 앱 본문(터미널) 리페인트를 유발하지 않는다.
- **30fps 상한** — 부가물 비용 절반.
- **가려지거나 토글 끄면 rAF 완전 정지** — 안 보일 때 비용 0(`visibilitychange` +
  WebKit occlusion throttle).
- **매 프레임 레이아웃 읽기 0** — 창 크기는 캐시, 리사이즈 때만 갱신.
- **반응형 모드일 때만 mousemove 부착**.

## License

MIT
