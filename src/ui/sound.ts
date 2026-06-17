// 알림 소리 — 내장음은 Web Audio 로 합성(바이너리 에셋 동봉 불필요), 커스텀음은 URL/asset 경로
// 로드. 순수 프론트(Rust 의존 0). AudioContext 는 지연 생성, suspended 면 resume 시도(데스크톱
// 웹뷰는 대개 허용 — 막히면 무음, best-effort). 알림은 시스템 접근 0이라 권한 게이트는 api 표면에서.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface Note {
  freq: number;
  start: number; // 시작 오프셋(초)
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

// 내장 사운드 — 짧은 오실레이터 패턴. 메일함 푸시 타입이 골라 쓴다.
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

const bufCache = new Map<string, AudioBuffer>();

// 내장음 이름이면 합성, 아니면 URL/asset 경로로 보고 로드·재생(캐시). 실패는 무음(best-effort).
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
    console.warn("사운드 재생 실패:", sound, e);
  }
}
