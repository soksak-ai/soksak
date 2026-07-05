#!/bin/bash
# 리사이즈 E2E 용 결정적 TUI 프로브 — alternate screen 에서 SIGWINCH 마다 전체
# 재그리기. 본문을 패턴으로 채워 blank 검출을 유효하게 하고, "마지막 줄"에
# 현재 cols×lines 마커(TUIDIM=CxL)를 둔다 → term.read(끝에서 1줄)로 TUI 가
# 리사이즈를 정확히 추종(SIGWINCH 전달+재그리기)했는지 기계 검증.
#
# 종료: INT/TERM 시 alternate screen 복원.

cleanup() { tput rmcup 2>/dev/null; exit 0; }
trap cleanup INT TERM

tput smcup 2>/dev/null

redraw() {
  # 실제 winsize(TIOCGWINSZ)를 직접 읽는다 — `tput cols` 는 terminfo 정적값(80)을 돌려줘
  # SIGWINCH 추종을 검증하지 못한다(실측: stty=54 vs tput=80). stty size = "rows cols".
  local c l sz
  sz=$(stty size 2>/dev/null) || sz="24 80"
  l=${sz% *}
  c=${sz#* }
  tput clear 2>/dev/null
  # 본문 채움(마지막 줄은 마커용으로 비움).
  local r
  for ((r = 1; r < l - 1; r++)); do
    printf 'TUIROW_%03d_AAAAAAAA_BBBBBBBB_CCCCCCCC_DDDDDDDD\n' "$r"
  done
  # 마지막 줄 = 마커(term.read 끝줄로 읽힘). 개행 없이.
  printf 'TUIDIM=%sx%s' "$c" "$l"
}

trap redraw WINCH
redraw
while true; do sleep 0.3; done
