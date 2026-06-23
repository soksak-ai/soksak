// 타이틀바 우측 컨트롤 그룹(사이드바·다크모드·설정) 좌측에 플러그인 헤더 액션을 flex 로 순차 렌더.
// 레지스트리(headerActions)를 구독해 등록/해지/갱신에 반응. 각 버튼은 data-node(titlebar/<id>)로
// 노출되어 ui.tree/ui.input.click 으로 조작·검증 가능(호스트 크롬 노드).

import { useEffect, useState } from "react";
import { getHeaderActions, subscribeHeaderActions } from "./headerActions";

export function PluginHeaderActions() {
  const [actions, setActions] = useState(getHeaderActions);
  useEffect(
    () => subscribeHeaderActions(() => setActions([...getHeaderActions()])),
    [],
  );
  return (
    <>
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`icon-btn${a.active ? " active" : ""}`}
          title={a.title}
          aria-label={a.title ?? a.label}
          data-node={`titlebar/${a.id.replace(/:/g, "/")}`}
          onClick={a.onClick}
        >
          {a.icon ? (
            // 아웃라인 아이콘 — 코어 Icon 과 동일 기하(md 14px, currentColor stroke, round caps).
            // 본문은 신뢰 출처(플러그인은 이미 코드 실행 권한 보유 — 전체신뢰 모델).
            <svg
              viewBox="0 0 24 24"
              width={14}
              height={14}
              aria-hidden
              focusable={false}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: a.icon }}
            />
          ) : (
            a.label
          )}
        </button>
      ))}
    </>
  );
}
