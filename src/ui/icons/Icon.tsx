// 시맨틱 아이콘 컴포넌트 — 앱의 유일한 아이콘 표면. 크기는 3단 토큰으로 고정해
// 들쭉날쭉함을 구조적으로 제거한다(컨테이너가 아니라 아이콘이 크기를 소유).
// 색은 currentColor — 컨테이너 텍스트 색을 그대로 따른다.

import { memo } from "react";
import { useSettings } from "../../state/settings";
import { getIconGlyph, useIconRegistry } from "./registry";
import type { IconName } from "./types";

const SIZE = { xs: 8, sm: 12, md: 14, lg: 16 } as const;
export type IconSize = keyof typeof SIZE;

export const Icon = memo(function Icon({
  name,
  size = "md",
}: {
  name: IconName;
  size?: IconSize;
}) {
  const setId = useSettings((s) => s.iconSet);
  // 셋 등록/해제(플러그인 활성·비활성) 시 리렌더.
  useIconRegistry((s) => s.version);
  const g = getIconGlyph(setId, name);
  const px = SIZE[size];
  const stroke = g.f === "stroke" || g.f === "both";
  const fill = g.f === "fill" || g.f === "both";
  return (
    <svg
      viewBox={g.v}
      width={px}
      height={px}
      aria-hidden
      focusable={false}
      fill={fill ? "currentColor" : "none"}
      stroke={stroke ? "currentColor" : "none"}
      strokeWidth={stroke ? 2 : undefined}
      strokeLinecap={stroke ? "round" : undefined}
      strokeLinejoin={stroke ? "round" : undefined}
      // 본문은 신뢰 출처만: 체크인된 추출 생성물 + validateIconSetData 통과한
      // 플러그인 데이터(전체신뢰 모델 — 플러그인은 이미 코드 실행 권한 보유).
      dangerouslySetInnerHTML={{ __html: g.b }}
    />
  );
});
