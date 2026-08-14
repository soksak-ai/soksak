import { memo, useRef, useState } from "react";
import { execute } from "../commands/registry";
import { isComposingEnter } from "../lib/imeKeys";
import { Icon } from "../ui/icons/Icon";
import { ProgramMenu } from "./ProgramMenu";
import { type Program, type Project } from "../state/sessions";
import { useCloseConfirm } from "../state/closeConfirm";
import { useProgramRegistry } from "../plugins/programRegistry";
import { useT } from "../i18n";

// Content tab bar (middle of the three-column layout). Switches between independent content
// areas (split grids) inside one project.
// Auto numbering 1,2,3,… + rename (double click) + close + `+` menu (terminal / agent ▸
// Claude·Codex / browser — new content with the selected program).

// memo boundary (principle 2): a store write for another project does not re-render this.
export const ContentTabs = memo(function ContentTabs({
  project,
  vertical = false,
}: {
  project: Project;
  vertical?: boolean;
}) {
  const t = useT();
  const requestCloseContent = useCloseConfirm((s) => s.requestCloseContent);
  const hasPrograms = useProgramRegistry((s) => s.order.length > 0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(
    null,
  );

  const commit = (id: string, raw: string, fallback: string) => {
    void execute("space.rename", { project: project.id, space: id, title: raw.trim() || fallback }, {});
    setEditingId(null);
  };

  const toggleMenu = () => {
    if (menuPos) {
      setMenuPos(null);
      return;
    }
    const r = addBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ left: r.left, top: r.bottom + 2 });
  };

  // Create through the command — calling the store directly drops observation, normalization,
  // and gates entirely. Measured (2026-07-31): this spot called the store directly, and a space
  // the user created with + left not one line in the activity ledger. When what happened cannot
  // be read from outside, tracing the cause turns into guessing. Same path as the space.create
  // the CLI and AI call, or the two diverge.
  const pick = (program: Program) => {
    void execute("space.create", { project: project.id, program }, {});
    setMenuPos(null);
  };

  return (
    <div className={`space-tabs${vertical ? " vertical" : ""}`}>
      {project.spaces.map((c, idx) => (
        <div
          key={c.id}
          className={`space-tab${c.id === project.activeSpaceId ? " active" : ""}${editingId === c.id ? " editing" : ""}`}
          data-node={`tab/space/${idx}`}
          onClick={() => void execute("space.activate", { project: project.id, space: c.id }, {})}
          onDoubleClick={() => setEditingId(c.id)}
          title={c.title}
        >
          {editingId === c.id ? (
            <input
              className="space-tab-rename"
              defaultValue={c.title}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commit(c.id, e.target.value, c.title)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (isComposingEnter(e)) return; // Enter that confirms IME composition is not a commit
                if (e.key === "Enter")
                  commit(c.id, e.currentTarget.value, c.title);
                else if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <span className="space-tab-title">{c.title}</span>
          )}
          {project.spaces.length > 1 && editingId !== c.id && (
            <button
              type="button"
              className="icon-btn icon-btn--mini space-tab-close"
              data-node={`tab/space/${idx}/close`}
              title={t("space.close")}
              onClick={(e) => {
                e.stopPropagation();
                requestCloseContent(project.id, c.id);
              }}
            >
              <Icon name="close" size="md" />
            </button>
          )}
        </div>
      ))}
      {/* With zero registered programs there is no + at all (no built-ins §2.6 — no reason to open an empty menu) */}
      {hasPrograms && (
        <button
          ref={addBtnRef}
          type="button"
          className="icon-btn space-tab-add"
          // Address — this path is verified only when a machine can press this button (§R2: when
          // testing is hard, build the verifiable surface first). While the address was missing
          // there was no way to reproduce "+ does not create" from outside.
          data-node="tab/space/add"
          title={t("space.new")}
          onClick={toggleMenu}
        >
          <Icon name="add" />
        </button>
      )}
      {menuPos && (
        <ProgramMenu
          pos={menuPos}
          onPick={pick}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
});
