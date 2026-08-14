import { moduleState } from "../lib/moduleState";
// Notification sound — builtins are synthesized with Web Audio (no binary asset shipped), custom
// sounds load from a URL/asset path. Frontend only (0 backend dependency). AudioContext is created
// lazily and resumed when suspended (desktop web views usually allow it — silence if blocked,
// best-effort). Notifications use 0 system access, so the permission gate is on the api surface.

// Outside the hot-swap boundary — a fresh value drops both the "already done" memory and the lazy initialization,
// and the filler does not fill again.
const ms = moduleState("ui/sound#state", () => ({
  ctx: null as AudioContext | null,
}));
function audio(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    if (!ms.ctx) ms.ctx = new Ctor();
    if (ms.ctx.state === "suspended") void ms.ctx.resume();
    return ms.ctx;
  } catch {
    return null;
  }
}

interface Note {
  freq: number;
  start: number; // start offset (seconds)
  dur: number;
  gain?: number;
  type?: OscillatorType;
}

function playNotes(notes: Note[]): void {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.freq;
    const t0 = now + n.start;
    const peak = n.gain ?? 0.15;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + n.dur + 0.02);
  }
}

// Builtin sounds — short oscillator patterns. Selected by mailbox push type.
const BUILTINS: Record<string, Note[]> = {
  default: [{ freq: 660, start: 0, dur: 0.18 }],
  ping: [{ freq: 880, start: 0, dur: 0.12, type: "triangle" }],
  chime: [
    { freq: 660, start: 0, dur: 0.16 },
    { freq: 990, start: 0.12, dur: 0.22 },
  ],
  success: [
    { freq: 660, start: 0, dur: 0.1 },
    { freq: 880, start: 0.09, dur: 0.1 },
    { freq: 1180, start: 0.18, dur: 0.2 },
  ],
  alert: [
    { freq: 740, start: 0, dur: 0.14, type: "square", gain: 0.12 },
    { freq: 740, start: 0.18, dur: 0.14, type: "square", gain: 0.12 },
  ],
};

export const BUILTIN_SOUNDS = Object.keys(BUILTINS);

// Outside the hot-swap boundary — a replaced map would stay empty: the filling side has already
// recorded the fill and does not fill again.
const bufCache = moduleState("ui/sound#bufCache", () => new Map<string, AudioBuffer>());
// Builtin name: synthesize. Otherwise treat as a URL/asset path, load and play (cached). Failure is
// silent (best-effort).
export async function playSound(sound: string): Promise<void> {
  if (Object.prototype.hasOwnProperty.call(BUILTINS, sound)) {
    playNotes(BUILTINS[sound]);
    return;
  }
  const ac = audio();
  if (!ac) return;
  try {
    let buf = bufCache.get(sound);
    if (!buf) {
      const res = await fetch(sound);
      const arr = await res.arrayBuffer();
      buf = await ac.decodeAudioData(arr);
      bufCache.set(sound, buf);
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start();
  } catch (e) {
    console.warn("sound playback failed:", sound, e);
  }
}
