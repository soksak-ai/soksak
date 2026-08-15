import { useProgramRegistry } from "../plugins/programRegistry";
import { localize, useT } from "../i18n";

// Single truth for the program <option> list — shared by settings, new workspace, and
// workspace settings. Every entry comes from plugin registration (no built-ins, §2.6; groups are optgroup).
// An unregistered current value (plugin inactive) gets its own option so the value is not lost —
// same fallback shape as the terminal view (isomorphic with the icon set's lucide fallback).
export function ProgramOptions({ current }: { current?: string }) {
  const t = useT();
  useProgramRegistry((s) => s.version);
  const { programs, order } = useProgramRegistry.getState();

  // select supports only one optgroup level — flatten the whole path ("a/b") into the group label.
  const flat = order.filter((id) => !programs[id]?.decl.path);
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const path = programs[id]?.decl.path;
    if (!path) continue;
    const g = localize(path);
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const known = new Set(order);

  return (
    <>
      {flat.map((id) => (
        <option key={id} value={id}>
          {localize(programs[id].decl.title)}
        </option>
      ))}
      {[...groups.entries()].map(([g, ids]) => (
        <optgroup key={g} label={g}>
          {ids.map((id) => (
            <option key={id} value={id}>
              {localize(programs[id].decl.title)}
            </option>
          ))}
        </optgroup>
      ))}
      {current && !known.has(current) && (
        <option value={current}>{t("common.inactive", { id: current })}</option>
      )}
    </>
  );
}
