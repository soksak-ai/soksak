// layout.suggest 순수함수(A4) — 배치 전략. 입력은 window.monitors 의 팩트(물리 px) 그대로,
// 출력은 창별 배치 제안(물리 px — window.place 가 같은 좌표계로 실행). 코어 Rust 는 팩트만
// 제공하고 판단 규칙은 전부 여기 있다(팩트/전략 분리 — 확정 결정). 부작용 0.

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
  // spread: 역할 기반 분산 — 오케스트레이터는 워크스페이스가 없는 모니터 전체(있으면),
  //         단일 모니터면 우측 1/3 나란히. 워크스페이스는 자기 모니터 전체.
  // grid:   전 창을 첫 모니터에 균등 그리드(관찰용 타일링).
  strategy: "spread" | "grid";
  // 창 역할(선택) — label→역할. 미지정 창은 project 로 본다.
  roles?: Record<string, "orchestrator" | "project">;
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

  // 워크스페이스: 자기 모니터(부재 시 주=0) 전체 사용 제안.
  const workMonitors = new Set<number>();
  for (const w of work) {
    const m = monitors[w.monitor ?? 0] ?? monitors[0];
    workMonitors.add(m.index);
    out.push(full(w.label, m));
  }

  // 오케스트레이터: 워크스페이스가 없는 모니터가 있으면 그 모니터 전체(감시 화면의 정위치),
  // 전부 점유돼 있으면(단일 모니터 포함) 주 모니터 우측 1/3 — 워크스페이스는 좌측 2/3 로
  // 양보해 겹침 없이 나란히 본다.
  const free = monitors.find((m) => !workMonitors.has(m.index));
  for (const o of orch) {
    if (free) {
      out.push(full(o.label, free));
    } else {
      const m = monitors[0];
      const orchW = Math.floor(m.w / 3);
      const workW = m.w - orchW;
      // 같은 모니터의 워크스페이스 제안을 좌측 2/3 로 축소(겹침 제거).
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

// 균등 그리드 — 열 = ceil(sqrt(n)), 행 = 필요 수. 나머지 픽셀은 마지막 열/행이 흡수.
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
