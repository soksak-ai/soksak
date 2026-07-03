# D 갈래 성능 게이트 (R11) — divider drag freeze-frame

측정: bare debug 인스턴스 1개에서 동일 시나리오(네이티브 브리지 연속 드래그 ~4.7s,
~30Hz move, chromium 뷰 위 root divider), CPU = 앱 메인 + CEF 프로세스 합산(0.3s 샘플).
스크립트: scripts/e2e/divider-freeze.sh 와 동일 구동 경로, 샘플러 = scripts/perf/lib.sh sample_cpu.

| 플러그인 상태 | 드래그 중 CPU avg | max |
|---|---|---|
| main (freeze 이전 — 드래그 중 30Hz bounds IPC) | 31.9% | 41.8% |
| feat/freeze-frame (드래그 중 bounds 유예 + 캡처 1회) | 10.4% / 14.4% (2회) | 15.0 / 33.2% |

판정: 퇴행 없음 — 드래그 중 CPU 약 1/2~1/3 로 개선. max 33.2% 1회는 캡처(SCK) 순간 스파이크로
드래그 시작 1샘플에 국한(지속 부하 아님).

참고: 소켓 panel.resize 스톰(s1)은 마우스 제스처 채널을 타지 않아 freeze 미개입 —
해당 경로는 유닛 604 + divider-freeze.sh 6단언으로 회귀 부재 확인. dev 인스턴스
기준선(20260704-042246-d-baseline-valid-dev.json)과는 인스턴스가 달라 직접 비교하지 않는다.
