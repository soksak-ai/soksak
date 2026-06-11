import { useEffect, useState } from "react";
import { getCwdOfHost, subscribeCwd } from "../terminal/paneHosts";
import type { View, ViewGroup } from "../state/sessions";
import { useT } from "../i18n";

// 분할창(그룹) 하단 스테이터스 바. 활성 뷰 정보:
//   - 터미널: 현재 작업 디렉토리(cwd, 셸 통합 이벤트 구독 — 폴링 없음)
//   - 파일: 경로 + 수정 여부 + 코드/프리뷰 모드

function TerminalStatus({ paneId }: { paneId: string }) {
  const t = useT();
  const [cwd, setCwd] = useState<string | undefined>(() => getCwdOfHost(paneId));
  useEffect(() => {
    setCwd(getCwdOfHost(paneId));
    return subscribeCwd(paneId, setCwd);
  }, [paneId]);
  return (
    <>
      <span className="egs-left" title={cwd}>
        {cwd ?? "~"}
      </span>
      <span className="egs-right">{t("view.terminal")}</span>
    </>
  );
}

function FileStatus({ view }: { view: Extract<View, { kind: "file" }> }) {
  const t = useT();
  return (
    <>
      <span className="egs-left" title={view.path}>
        {view.path}
      </span>
      <span className="egs-right">
        {view.dirty ? "● " : ""}
        {view.mode === "code" ? t("viewer.code") : t("viewer.preview")}
      </span>
    </>
  );
}

function BrowserStatus({ view }: { view: Extract<View, { kind: "browser" }> }) {
  const t = useT();
  return (
    <>
      <span className="egs-left" title={view.url}>
        {view.url}
      </span>
      <span className="egs-right">{t("program.browser")}</span>
    </>
  );
}

export function GroupStatusBar({ group }: { group: ViewGroup }) {
  const active = group.views.find((v) => v.id === group.activeViewId);
  return (
    <div className="egroup-status">
      {active?.kind === "terminal" ? (
        <TerminalStatus paneId={active.focusedPaneId} />
      ) : active?.kind === "file" ? (
        <FileStatus view={active} />
      ) : active?.kind === "browser" ? (
        <BrowserStatus view={active} />
      ) : null}
    </div>
  );
}
