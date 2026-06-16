// soksak-plugin-window — 좌측 사이드바 하단의 "창밖 풍경" (soksak-plugin-spec v1).
//
// 원작: oliviale (Olivia Ng) 의 CodePen "CSS Animations Experiment Part II"
//   https://codepen.io/oliviale/pen/ELPvLM  (라이선스는 원본 CodePen 을 따름 — 크레딧 유지).
// 원본은 jQuery + Pug + SCSS + 수동 4토글(Dusk/Day/Sunset/Night). 여기서는 SVG 아트워크를
// 그대로 가져오되 jQuery 를 제거하고 순수 DOM/CSS, 토글 대신 실제 현재 시각에 자동 추종한다.
//
// 성능(docs/PERFORMANCE.md): 애니메이션 루프 없음. 폴링 대신 다음 경계까지 setTimeout 1개만
// 예약(nextTransitionMs). 위치 전환은 transform(레이아웃 0 — GPU 합성), 색은 fill(작은 영역
// 페인트), transition 은 구체 속성만(all 금지). 유휴 시 CPU 0.

// ── 순수 함수(테스트 전용 named export — 로더는 default 만 소비) ───────────────────
// 경계(현지 시각, 분): day 07:00(420) / sunset 17:00(1020) / dusk 18:30(1110) / night 20:00(1200).
// night 는 자정~07:00 과 20:00~자정 양쪽 — 기본값 night 에서 경계 통과 시 갱신.
const BOUNDS = [
  { min: 420, phase: "day" },
  { min: 1020, phase: "sunset" },
  { min: 1110, phase: "dusk" },
  { min: 1200, phase: "night" },
];
const PHASES = ["day", "sunset", "dusk", "night"];
const DAY_MS = 24 * 60 * 60 * 1000;

export function phaseForTime(date) {
  const min = date.getHours() * 60 + date.getMinutes();
  let phase = "night";
  for (const b of BOUNDS) {
    if (min >= b.min) phase = b.phase;
  }
  return phase;
}

// 다음 경계까지 ms(분/초/ms 정밀). 오늘 남은 경계가 없으면 익일 첫 경계(07:00)까지.
export function nextTransitionMs(date) {
  const ms =
    ((date.getHours() * 60 + date.getMinutes()) * 60 + date.getSeconds()) * 1000 +
    date.getMilliseconds();
  const bounds = BOUNDS.map((b) => b.min * 60_000);
  for (const b of bounds) {
    if (b > ms) return b - ms;
  }
  return bounds[0] + DAY_MS - ms;
}

// ── 뷰 마크업(원본 SVG 인라인 — 정적 자체 마크업, 외부 데이터 아님) ─────────────────
// id/class 는 skw- 스코프(전역 충돌 회피). 위치/색은 CSS 가 phase 클래스로 제어.
const SVG = {
  sky:
    '<svg width="250px" viewBox="0 0 113.39 99.21">' +
    '<linearGradient id="skw-sky-sunset" gradientUnits="userSpaceOnUse" x1="0%" y1="0%" x2="100%" y2="0%" gradientTransform="rotate(-25)">' +
    '<stop offset="0%" stop-color="#f7ffa9"/><stop offset="40%" stop-color="#ffcc33"/><stop offset="100%" stop-color="#ffbe1d"/></linearGradient>' +
    '<linearGradient id="skw-sky-dusk" gradientUnits="userSpaceOnUse" x1="0%" y1="0%" x2="100%" y2="0%" gradientTransform="rotate(45)">' +
    '<stop offset="0%" stop-color="#ffd4fe"/><stop offset="30%" stop-color="#ffd4fe"/><stop offset="100%" stop-color="#ffd26a"/></linearGradient>' +
    '<polygon fill="#B3EFFF" id="skw-sky" points="111.971,97.368 111.971,1.842 1.419,1.842 1.419,9.042 1.419,97.368"/></svg>',
  sun:
    '<svg width="90px" viewBox="0 0 90.71 90.71"><g>' +
    '<circle opacity="0.1" fill="#FFECDC" cx="45.355" cy="45.354" r="43.212"/>' +
    '<circle opacity="0.3" fill="#FFEBDE" cx="45.355" cy="45.354" r="31.131"/>' +
    '<circle id="skw-sun" fill="#f9db5a" cx="45.355" cy="45.354" r="21.374"/></g></svg>',
  clouds:
    '<svg width="80px" viewBox="0 0 42.52 19.84"><g>' +
    '<path fill="#fff" d="M38.582,8.005c1.865,0,3.393,1.673,3.393,3.717l0,0c0,2.042-1.527,3.716-3.393,3.716H24.039h-0.484c-2.676,0-4.847-2.378-4.847-5.309c0-2.932,2.17-5.309,4.847-5.309c0,0,2.242-4.247,7.756-4.247c3.453,0,6.787,1.925,6.787,7.432H38.582z"/>' +
    '<path fill="#FCFCFC" d="M20.863,11.667c1.908,0,3.471,1.71,3.471,3.8l0,0c0,2.09-1.563,3.8-3.471,3.8H5.998H5.501c-2.736,0-4.956-2.431-4.956-5.428s2.219-5.428,4.956-5.428c0,0,2.292-4.342,7.929-4.342c3.532,0,6.939,1.968,6.939,7.598H20.863z"/></g></svg>',
  stars:
    '<svg width="210px" viewBox="0 0 99.21 25.51"><g fill="#FFFFFF" opacity="0.6">' +
    '<ellipse cx="97.067" cy="11.361" rx="0.727" ry="0.832"/>' +
    '<ellipse cx="2.144" cy="3.901" rx="0.728" ry="0.831"/>' +
    '<ellipse cx="14.743" cy="10.455" rx="0.727" ry="0.831"/>' +
    '<ellipse cx="66.439" cy="9.407" rx="0.728" ry="0.831"/>' +
    '<ellipse cx="77.518" cy="1.332" rx="0.728" ry="0.831"/>' +
    '<ellipse cx="82.514" cy="13.459" rx="0.728" ry="0.831"/></g></svg>',
  moon:
    '<svg width="35px" viewBox="0 0 15.59 19.28">' +
    '<path opacity="0.85" fill="#FFFFFF" d="M13.718,16.993c-5.085,0-9.208-4.122-9.208-9.208c0-2.97,1.407-5.608,3.589-7.292C3.722,1.205,0.381,5,0.381,9.579c0,5.086,4.123,9.208,9.209,9.208c2.116,0,4.063-0.716,5.619-1.916C14.722,16.95,14.226,16.993,13.718,16.993z"/></svg>',
  mountain:
    '<svg width="250px" viewBox="0 0 113.39 36.85">' +
    '<path id="skw-mountain" fill="#87D6D6" d="M111.971,0.478C106.576,2.7,95.837,16.269,88.655,15C81.29,13.699,68.052,6.244,62.31,3.639C56.566,1.036,41.955,16.42,36.835,15.948c-5.118-0.474-17.355-9.232-23.475-8.403c-3.964,0.537-8.932,4.276-11.941,6.844v21.983h110.552V0.478z"/></svg>',
  hill:
    '<svg width="250px" viewBox="0 0 113.39 17.86">' +
    '<path id="skw-hill" fill="#38C6B1" d="M111.971,12.132c-4.609-0.766-8.889-1.889-12.432-3.579C86.127-0.36,71.48-3.606,43.082,6.31c-6.086,0.811-7.853,0.51-17.234-2.951C18.487,0.644,8.764,1.176,1.419,2.621v15.017h110.551V12.132z"/></svg>',
  land:
    '<svg width="250px" viewBox="0 0 113.39 24.09">' +
    '<path id="skw-land" fill="#4CB5AB" d="M111.971,23.82V3.328C84.865-6.96,12.407,11.765,1.419,14.708v9.112H111.971z"/></svg>',
  trees:
    '<svg width="210px" viewBox="0 0 85.04 41.1">' +
    '<g><rect class="skw-trunk" x="75.121" y="26.724" fill="#8C5F50" width="2.166" height="8.666"/>' +
    '<rect class="skw-trunk" x="67.539" y="28.89" fill="#8C5F50" width="2.168" height="6.5"/></g>' +
    '<g><path class="skw-tree" fill="#A0D755" d="M83.785,21.309c0,4.187-3.393,7.581-7.58,7.581s-7.582-3.395-7.582-7.581c0-9.749,3.395-20.579,7.582-20.579S83.785,11.56,83.785,21.309z"/>' +
    '<path class="skw-tree" fill="#A0D755" d="M75.121,24.933c0,3.382-2.91,6.125-6.5,6.125c-3.588,0-6.498-2.743-6.498-6.125c0-7.873,2.91-16.622,6.498-16.622C72.211,8.311,75.121,17.06,75.121,24.933z"/></g>' +
    '<g opacity="0.2"><path fill="#FFFFFF" d="M72.955,21.309c0-8.892,1.883-18.68,4.332-20.333c-0.354-0.16-0.715-0.247-1.082-0.247c-4.188,0-7.582,10.83-7.582,20.579c0,4.187,3.395,7.581,7.582,7.581c0.369,0,0.729-0.035,1.082-0.086C74.84,28.277,72.955,25.127,72.955,21.309z"/>' +
    '<path fill="#FFFFFF" d="M66.457,24.933c0-7.106,1.383-14.901,3.191-16.359c-0.334-0.157-0.676-0.263-1.025-0.263c-3.588,0-6.5,8.749-6.5,16.622c0,3.382,2.912,6.125,6.5,6.125c0.35,0,0.691-0.034,1.025-0.084C67.84,30.508,66.457,27.984,66.457,24.933z"/></g>' +
    '<g><rect class="skw-trunk" x="3.466" y="35.946" fill="#8C5F50" width="1.475" height="4.424"/>' +
    '<path class="skw-tree" fill="#A0D755" d="M7.153,34.472c0,1.628-1.32,2.949-2.949,2.949S1.254,36.1,1.254,34.472c0-5.162,1.32-11.799,2.949-11.799S7.153,29.31,7.153,34.472z"/>' +
    '<path opacity="0.2" fill="#FCFCFC" d="M3.466,34.472c0-4.233,0.666-9.452,1.58-11.194c-0.267-0.383-0.55-0.604-0.842-0.604c-1.629,0-2.949,6.637-2.949,11.799c0,1.628,1.32,2.949,2.949,2.949c0.295,0,0.573-0.057,0.842-0.137C4.135,36.919,3.466,35.806,3.466,34.472z"/></g></svg>',
  cat:
    '<svg width="80px" viewBox="0 0 15.59 15.59"><path d="M14.42,11.993c-0.104-1.334-0.709-2.336-1.57-3.153c-0.479-0.449-0.906-0.563-1.414-0.563c0,0-0.204,0.005-0.041,0.212c0.215,0.271,1.791,2.328,1.768,4.011c-0.029,1.948-1.958,1.837-1.958,1.837c0.812-1.542,0.402-3.001,0.276-3.512c-0.238-0.943-0.709-1.857-1.417-2.738C9.191,6.988,8.312,6.468,7.425,6.523c-0.379-0.654-0.716-1.18-1.011-1.61C8.02,3.479,6.974,2.787,6.063,0c-0.211,0.591-0.38,1.028-0.507,1.31c-0.644-0.08-2.071-0.08-2.714,0C2.716,1.028,2.547,0.591,2.336,0C1.423,2.794,0.374,3.467,1.999,4.909c0.173,3.278,0.849,4.149,1.942,5.732c0.9,1.304,0.675,1.768,1.098,3.569c-3.197,2.014,2.223,1.241,3.063,1.2C10.266,15.305,14.777,16.6,14.42,11.993z"/></svg>',
};

const STYLE =
  ".skw-root{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;" +
  "height:100%;box-sizing:border-box;padding:12px 8px;background:var(--bg);overflow:hidden}" +
  ".skw-root .skw-window{position:relative;background:#fff;padding:10px;line-height:0}" +
  ".skw-root .skw-window::before{content:'';position:absolute;left:0;right:0;margin:0 auto;height:14px;" +
  "top:100%;width:112%;margin-left:-6%;background:#f4c7c7}" +
  ".skw-root .skw-cat{position:absolute;z-index:10;bottom:-5px;right:-26px;color:#39342f}" +
  ".skw-root .skw-illu{position:relative;width:250px;max-width:100%;overflow:hidden}" +
  ".skw-root .skw-sky{display:block}" +
  ".skw-root .skw-mountain,.skw-root .skw-hill,.skw-root .skw-land,.skw-root .skw-trees," +
  ".skw-root .skw-sun,.skw-root .skw-clouds,.skw-root .skw-moon,.skw-root .skw-stars" +
  "{position:absolute;left:0;right:0;margin:auto;line-height:0}" +
  ".skw-root .skw-mountain{bottom:45px}.skw-root .skw-hill{bottom:45px}" +
  ".skw-root .skw-trees{bottom:25px}.skw-root .skw-land{bottom:3px}" +
  // 위치 전환은 transform 만(레이아웃 0). 기본값=night 모습(해는 작게 아래로 — 사실상 숨김).
  ".skw-root .skw-sun{top:10px;transition:transform 1s ease;transform:translate(-20px,110px) scale(0.2)}" +
  ".skw-root .skw-moon,.skw-root .skw-stars{top:25px;opacity:0;transition:opacity 1s ease}" +
  ".skw-root .skw-clouds{top:50px;transition:transform 1s ease .1s;transform:translateX(260px)}" +
  // 색 전환은 구체 속성만(작은 SVG 영역 페인트).
  ".skw-root path,.skw-root polygon,.skw-root circle,.skw-root rect{transition:fill 1s ease}" +
  // day
  ".skw-root .skw-time.day .skw-sun{transform:translate(0,0) scale(1)}" +
  ".skw-root .skw-time.day .skw-clouds{transform:translateX(0)}" +
  // sunset
  ".skw-root .skw-time.sunset .skw-sun{transform:translate(-80px,50px) scale(1)}" +
  ".skw-root .skw-time.sunset #skw-sun{fill:#fff}" +
  ".skw-root .skw-time.sunset #skw-sky{fill:url(#skw-sky-sunset)}" +
  ".skw-root .skw-time.sunset #skw-mountain{fill:#efbb2b}" +
  ".skw-root .skw-time.sunset #skw-hill{fill:#e6ad28}" +
  ".skw-root .skw-time.sunset #skw-land{fill:#de9f26}" +
  ".skw-root .skw-time.sunset .skw-tree{fill:#747c0b}" +
  ".skw-root .skw-time.sunset .skw-trunk{fill:#3f3e3d}" +
  // dusk
  ".skw-root .skw-time.dusk .skw-sun{transform:translate(140px,50px) scale(1)}" +
  ".skw-root .skw-time.dusk #skw-sun{fill:#ffffda}" +
  ".skw-root .skw-time.dusk #skw-sky{fill:url(#skw-sky-dusk)}" +
  ".skw-root .skw-time.dusk #skw-mountain{fill:#f1a3a2}" +
  ".skw-root .skw-time.dusk #skw-hill{fill:#e09c9c}" +
  ".skw-root .skw-time.dusk #skw-land{fill:#c4918d}" +
  ".skw-root .skw-time.dusk .skw-tree{fill:#ce791c}" +
  ".skw-root .skw-time.dusk .skw-trunk{fill:#8c5f50}" +
  // night
  ".skw-root .skw-time.night .skw-moon,.skw-root .skw-time.night .skw-stars{opacity:1;transition:opacity 1s ease .5s}" +
  ".skw-root .skw-time.night #skw-sky{fill:#17377f}" +
  ".skw-root .skw-time.night #skw-mountain{fill:#73addf}" +
  ".skw-root .skw-time.night #skw-hill{fill:#659fcd}" +
  ".skw-root .skw-time.night #skw-land{fill:#508bb5}" +
  ".skw-root .skw-time.night .skw-tree{fill:#1c2c3b}" +
  ".skw-root .skw-time.night .skw-trunk{fill:#3f3e3d}";

function viewHtml(phase) {
  return (
    "<style>" + STYLE + "</style>" +
    '<div class="skw-root"><div class="skw-window">' +
    '<div class="skw-cat">' + SVG.cat + "</div>" +
    '<div class="skw-illu"><div class="skw-time ' + phase + '">' +
    '<div class="skw-sky">' + SVG.sky + "</div>" +
    '<div class="skw-sun">' + SVG.sun + "</div>" +
    '<div class="skw-clouds">' + SVG.clouds + "</div>" +
    '<div class="skw-stars">' + SVG.stars + "</div>" +
    '<div class="skw-moon">' + SVG.moon + "</div>" +
    '<div class="skw-mountain">' + SVG.mountain + "</div>" +
    '<div class="skw-hill">' + SVG.hill + "</div>" +
    '<div class="skw-land">' + SVG.land + "</div>" +
    '<div class="skw-trees">' + SVG.trees + "</div>" +
    "</div></div></div></div>"
  );
}

// ── 상태 + 스케줄(폴링 없음 — 다음 경계까지 setTimeout 1개) ────────────────────────
let app = null;
let forced = null; // set 으로 강제된 phase(null = 자동 추종)
let timer = null;
const mounts = new Set(); // 마운트된 container — 전환 시 클래스 반영

function currentPhase() {
  return forced ?? phaseForTime(new Date());
}

function applyPhase() {
  const phase = currentPhase();
  for (const el of mounts) {
    const t = el.querySelector(".skw-time");
    if (t) t.className = "skw-time " + phase;
  }
}

function schedule() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (forced != null) return; // 강제 중엔 자동 전환 멈춤
  // +250ms 여유로 경계를 확실히 넘긴 뒤 재평가(부동소수/타이머 조기발화 방지).
  timer = setTimeout(() => {
    timer = null;
    applyPhase();
    schedule();
  }, nextTransitionMs(new Date()) + 250);
}

function mount(container) {
  container.innerHTML = viewHtml(currentPhase());
  mounts.add(container);
}

function unmount(container) {
  mounts.delete(container);
  container.replaceChildren();
}

export default {
  activate(ctx) {
    app = ctx.app;

    // 뷰 — 좌측 사이드바(매니페스트 placements). disposable 은 subscriptions 자동 수거.
    ctx.subscriptions.push(app.ui.registerView("panel", { mount, unmount }));

    // state — 현재/자동 phase 와 다음 전환(E2E·디버그용). sok plugin.soksak-plugin-window.state
    ctx.subscriptions.push(
      app.commands.register("state", {
        description: "현재 시간대 상태와 다음 전환 시각을 돌려준다",
        params: {},
        handler: () => {
          const now = new Date();
          const ms = nextTransitionMs(now);
          return {
            phase: currentPhase(),
            forced: forced != null,
            auto: phaseForTime(now),
            now: now.toISOString(),
            nextPhase: phaseForTime(new Date(now.getTime() + ms + 1000)),
            nextInMs: ms,
          };
        },
      }),
    );

    // set — phase 강제(미리보기/검증). 인자 없거나 빈 phase = 자동 추종 복귀.
    ctx.subscriptions.push(
      app.commands.register("set", {
        description: "시간대를 강제하거나(day|sunset|dusk|night) 인자 없이 자동 추종으로 복귀",
        params: {
          phase: {
            type: "string",
            description: "day|sunset|dusk|night (생략 시 자동 추종 복귀)",
            required: false,
          },
        },
        handler: (p) => {
          const v = p && p.phase;
          if (v != null && v !== "" && !PHASES.includes(v)) {
            throw new Error(`phase 는 ${PHASES.join("|")} 또는 생략(자동 복귀)`);
          }
          forced = v ? v : null;
          applyPhase();
          schedule();
          return { phase: currentPhase(), forced: forced != null };
        },
      }),
    );

    schedule(); // 자동 전환 타이머 시작
    ctx.subscriptions.push({
      dispose() {
        if (timer != null) clearTimeout(timer);
        timer = null;
        mounts.clear();
        app = null;
      },
    });
  },

  deactivate() {},
};
