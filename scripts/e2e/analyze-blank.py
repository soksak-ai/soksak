#!/usr/bin/env python3
"""리사이즈 E2E 의 blank(빈 프레임) 기계 측정.

screencapture 로 녹화한 영상에서 지정 영역(터미널 본문)의 프레임별 "내용 비율"
(배경색과 다른 픽셀 비율)을 계산해, 본문이 통째로 비는(blank) 현상을 검출한다.

판정 기준(명확·결정적):
  - baseline = 전체 프레임 내용 비율의 중앙값(드래그 전/후 정상 상태가 다수).
  - blank 프레임 = 내용 비율 < max(ABS_FLOOR, baseline * REL_FLOOR).
  - 핵심 지표 = "최장 연속 blank 프레임 수"(maxRun). 버그(매 프레임 캔버스
    리얼록 → 렌더 미완료)는 수십 프레임 연속 blank 를, 정상은 0~수 프레임의
    전환만 낸다.

출력: JSON {frames, baseline, blankFrames, maxRun, minRatio}
인자: <video> <cropL> <cropT> <cropR> <cropB>   (crop 은 0~1 비율)

종료코드는 항상 0 — 판정(GREEN/RED)은 호출자(resize.sh)가 maxRun 임계로 한다.
"""
import sys
import json
import subprocess
import tempfile
import glob
import os
from collections import Counter

ABS_FLOOR = 3.0   # 절대 바닥(%) — 이보다 낮으면 사실상 빈 화면
REL_FLOOR = 0.30  # 정상 대비 30% 미만이면 blank


def main():
    if len(sys.argv) < 6:
        print(json.dumps({"error": "usage: analyze-blank.py <video> <L> <T> <R> <B>"}))
        return
    video = sys.argv[1]
    L, T, R, B = (float(sys.argv[i]) for i in range(2, 6))
    try:
        from PIL import Image
    except ImportError:
        print(json.dumps({"error": "PIL(pillow) 필요: pip3 install pillow"}))
        return

    tmp = tempfile.mkdtemp(prefix="e2e-blank-")
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", video, os.path.join(tmp, "f%04d.png")],
            check=True,
        )
        files = sorted(glob.glob(os.path.join(tmp, "f*.png")))
        if not files:
            print(json.dumps({"error": "프레임 추출 실패(녹화 비었나)"}))
            return
        ratios = []
        for f in files:
            im = Image.open(f).convert("RGB")
            w, h = im.size
            body = im.crop((int(w * L), int(h * T), int(w * R), int(h * B)))
            bw, bh = body.size
            px = list(body.resize((max(1, bw // 4), max(1, bh // 4))).getdata())
            n = len(px)
            bg = Counter(px).most_common(1)[0][0]
            content = (
                sum(
                    1
                    for r, g, b in px
                    if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 55
                )
                / n
                * 100
            )
            ratios.append(content)
        srt = sorted(ratios)
        baseline = srt[len(srt) // 2]
        thresh = max(ABS_FLOOR, baseline * REL_FLOOR)
        blank = [i for i, c in enumerate(ratios) if c < thresh]
        # 최장 연속 blank.
        max_run = run = 0
        prev = -2
        for i in blank:
            run = run + 1 if i == prev + 1 else 1
            max_run = max(max_run, run)
            prev = i
        print(
            json.dumps(
                {
                    "frames": len(ratios),
                    "baseline": round(baseline, 1),
                    "threshold": round(thresh, 1),
                    "blankFrames": len(blank),
                    "maxRun": max_run,
                    "minRatio": round(min(ratios), 1),
                }
            )
        )
    finally:
        for f in glob.glob(os.path.join(tmp, "*.png")):
            os.remove(f)
        os.rmdir(tmp)


if __name__ == "__main__":
    main()
