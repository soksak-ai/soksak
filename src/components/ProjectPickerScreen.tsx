// 프로젝트 픽커 — 프로젝트 0개 창(새 창 부트·P6 열화)의 첫 화면. 새 창은 워크스페이스를
// 자동 부팅하지 않는다(P6 UX): 최근 프로젝트에서 고르거나 새 프로젝트를 만든다.
// 데이터원 = recentProjects(core kv, 크로스윈도우) + project_owners(다른 창 점유 표시).
// 반응성: data-change(recent 갱신)·project-registry-change(점유 변화) listen — 폴링 0.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";
import { addProjectClaimed } from "../state/projectRegistry";
import { listRecentProjects, type RecentProject } from "../state/recentProjects";
import { NewProjectModal } from "./NewProjectModal";

interface Owners {
  owners: { root: string; window: string }[];
}

export function ProjectPickerScreen() {
  const t = useT();
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [ownedBy, setOwnedBy] = useState<Map<string, string>>(new Map());
  const [newOpen, setNewOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [list, owners] = await Promise.all([
      listRecentProjects(),
      invoke<Owners>("project_owners").catch(() => ({ owners: [] }) as Owners),
    ]);
    setRecents(list);
    setOwnedBy(new Map(owners.owners.map((o) => [o.root, o.window])));
  }, []);

  useEffect(() => {
    void refresh();
    const uns: Array<() => void> = [];
    let disposed = false;
    // 점유 변화(다른 창 열기/닫기)·최근 목록 변화(다른 창에서 열기) 모두 재조회.
    void listen("project-registry-change", () => void refresh()).then((u) => {
      if (disposed) u();
      else uns.push(u);
    });
    void listen<{ ns: string; id: string | null }>("data-change", (e) => {
      if (e.payload.ns === "core" && e.payload.id === "recentProjects") void refresh();
    }).then((u) => {
      if (disposed) u();
      else uns.push(u);
    });
    return () => {
      disposed = true;
      for (const u of uns) u();
    };
  }, [refresh]);

  const open = useCallback(async (r: RecentProject) => {
    // 다른 창 점유면 addProjectClaimed 가 그 창을 포커스한다(비활성 표시는 안내일 뿐 차단 아님).
    await addProjectClaimed({ alias: r.alias, root: r.root });
  }, []);

  return (
    <div className="picker-screen" data-node="picker">
      <div className="picker-card">
        <div className="picker-head">
          <span className="picker-title">{t("picker.title")}</span>
        </div>
        <div className="picker-list">
          {recents.length === 0 && (
            <div className="picker-empty">{t("picker.empty")}</div>
          )}
          {recents.map((r, idx) => {
            const owner = ownedBy.get(r.root);
            return (
              <button
                type="button"
                key={r.root}
                className={`picker-item${owner ? " picker-item--open" : ""}`}
                data-node={`picker/item/${idx}`}
                title={r.root}
                onClick={() => void open(r)}
              >
                <span className="picker-item-alias">{r.alias}</span>
                <span className="picker-item-root">{r.root}</span>
                {owner && (
                  <span className="picker-item-owner">
                    {t("picker.openIn", { window: owner })}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="picker-actions">
          <button
            type="button"
            className="dbtn dbtn-acc"
            data-node="picker/new"
            onClick={() => setNewOpen(true)}
          >
            <Icon name="add" size="sm" /> {t("project.new")}
          </button>
        </div>
      </div>
      {newOpen && <NewProjectModal onClose={() => setNewOpen(false)} />}
    </div>
  );
}
