import { describe, it, expect, beforeEach } from "vitest";
import { useViewLabels, resolveViewLabel } from "./viewLabels";

// viewLabels — viewKey 별 사용자 지정 탭 라벨(코어 영속). 사이드바 뷰(좌·우)가 공유하는 generic
// 오버라이드 채널(플러그인 특례 아님). 미지정이면 manifest title 폴백.

beforeEach(() => {
  useViewLabels.setState({ labels: {} });
});

describe("viewLabels 스토어", () => {
  it("set: viewKey 라벨 지정", () => {
    useViewLabels.getState().setLabel("soksak-plugin-folderpop.folders", "폴더팝");
    expect(useViewLabels.getState().labels["soksak-plugin-folderpop.folders"]).toBe("폴더팝");
  });

  it("set 빈 문자열/공백 = 오버라이드 제거(manifest 폴백 복귀)", () => {
    const s = useViewLabels.getState();
    s.setLabel("x.y", "커스텀");
    s.setLabel("x.y", "   ");
    expect(useViewLabels.getState().labels["x.y"]).toBeUndefined();
  });

  it("clear: 명시적 제거", () => {
    const s = useViewLabels.getState();
    s.setLabel("x.y", "커스텀");
    s.clearLabel("x.y");
    expect(useViewLabels.getState().labels["x.y"]).toBeUndefined();
  });
});

describe("resolveViewLabel", () => {
  it("오버라이드 있으면 그것, 없으면 fallback(manifest title)", () => {
    useViewLabels.getState().setLabel("x.y", "내라벨");
    expect(resolveViewLabel("x.y", "기본")).toBe("내라벨");
    expect(resolveViewLabel("z.w", "기본")).toBe("기본");
  });
});
