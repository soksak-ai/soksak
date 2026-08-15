// layout.suggest pure functions(A4) — placement strategy. Input is the window.monitors facts(physical px)
// as-is, output is one placement proposal per window(physical px — window.place runs in the same coordinate
// system). The core supplies facts only and every judgement rule is here(fact/strategy separation — settled
// decision). 0 side effects.

export interface MonitorFact {
  index: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface WindowFact {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
  monitor: number | null;
}

export interface Placement {
  label: string;
  monitor: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SuggestInput {
  monitors: MonitorFact[];
  windows: WindowFact[];
  // spread: role-based distribution — the orchestrator takes a whole monitor that has no workspace(if one
  //         exists), on a single monitor the right 1/3 side by side. A workspace takes its own monitor whole.
  // grid:   all windows in an even grid on the first monitor(tiling for observation).
  strategy: "spread" | "grid";
  // Window role(optional) — label→role. An unspecified window counts as workspace.
  roles?: Record<string, "orchestrator" | "workspace">;
}

export function suggestLayout(input: SuggestInput): Placement[] {
  const { monitors, windows, strategy } = input;
  if (monitors.length === 0 || windows.length === 0) return [];
  const roles = input.roles ?? {};
  if (strategy === "grid") return grid(monitors[0], windows);

  // spread
  const orch = windows.filter((w) => roles[w.label] === "orchestrator");
  const work = windows.filter((w) => roles[w.label] !== "orchestrator");
  const out: Placement[] = [];

  // Workspace: proposes the whole of its own monitor(absent → primary=0).
  const workMonitors = new Set<number>();
  for (const w of work) {
    const m = monitors[w.monitor ?? 0] ?? monitors[0];
    workMonitors.add(m.index);
    out.push(full(w.label, m));
  }

  // Orchestrator: if some monitor has no workspace, that monitor whole(fixed position of the observation
  // screen); if all are occupied(single monitor included), the right 1/3 of the primary monitor — the
  // workspace shrinks to the left 2/3 so both stay visible side by side without overlap.
  const free = monitors.find((m) => !workMonitors.has(m.index));
  for (const o of orch) {
    if (free) {
      out.push(full(o.label, free));
    } else {
      const m = monitors[0];
      const orchW = Math.floor(m.w / 3);
      const workW = m.w - orchW;
      // Shrink the workspace proposal on the same monitor to the left 2/3(removes overlap).
      for (const p of out) {
        if (p.monitor === m.index) {
          p.x = m.x;
          p.w = workW;
        }
      }
      out.push({ label: o.label, monitor: m.index, x: m.x + workW, y: m.y, w: orchW, h: m.h });
    }
  }
  return out;
}

function full(label: string, m: MonitorFact): Placement {
  return { label, monitor: m.index, x: m.x, y: m.y, w: m.w, h: m.h };
}

// Even grid — cols = ceil(sqrt(n)), rows = as many as needed. The last col/row absorbs the remainder pixels.
function grid(m: MonitorFact, windows: WindowFact[]): Placement[] {
  const n = windows.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cw = Math.floor(m.w / cols);
  const ch = Math.floor(m.h / rows);
  return windows.map((w, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      label: w.label,
      monitor: m.index,
      x: m.x + c * cw,
      y: m.y + r * ch,
      w: c === cols - 1 ? m.w - cw * (cols - 1) : cw,
      h: r === rows - 1 ? m.h - ch * (rows - 1) : ch,
    };
  });
}
