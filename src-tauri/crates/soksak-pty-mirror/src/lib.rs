//! 헤드리스 PTY 미러 + 복원 직렬화기 — 세션 출력 바이트를 소비해 화면 상태(스크롤백·
//! alt-screen·private mode)를 유지하고, 재부착/체크포인트가 재생할 수 있는 페인트
//! 시퀀스를 만들어 낸다(플랜 §5.5 M1/M2, docs/RESTORE.md 사다리 2·3단의 실체).
//!
//! 계약 두 조각:
//!   [`Mirror`]  복원 경로의 단위 — 출력 스트림을 먹고(`feed`) 복원 시퀀스를 낸다.
//!               warm 재부착은 [`Mirror::rehydrate`](화면 상태 재현), cold 체크포인트는
//!               [`Mirror::cold_paint`](비활성 텍스트 평면화)를 쓴다.
//!   [`Screen`]  판정자·프로브 — alacritty_terminal 로 바이트를 실제 렌더해 그리드·모드·
//!               커서를 읽고, 터미널이 PTY 에 되쓰려는 응답(DA1/DSR 답)을 포획한다.
//!               픽스처가 "원본 화면 == 복원 화면, 재생 중 PTY write 0바이트"를 이걸로
//!               단언한다.
//!
//! 불변식(재생 가드): 미러는 절대 응답하지 않는다 — 질의(DA1/DSR/OSC)의 단일 응답자는
//! 프론트 xterm 하나다. 미러가 삼킨 응답 요구는 [`Mirror::suppressed_replies`] 로
//! 관찰만 된다. 복원 시퀀스에는 질의 바이트가 실리지 않는다(이중응답 원천 차단).

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor};

/// 미러가 유지하는 스크롤백 행 수. 바이트 충실 복원의 바닥이다 — 전체 의미 이력은
/// command_blocks(app.data)가 소유하고, 이 수치는 화면 재현용 창이다.
pub const MIRROR_SCROLLBACK_LINES: usize = 1000;

// ── 판정용 스냅샷 타입 ───────────────────────────────────────────────────────

/// 셀 한 칸의 비교 가능한 스냅샷. wide 문자는 스냅 1개(점유 2칸)로 나오고 스페이서
/// 셀은 생략된다 — "폭"은 `wide` 가 진실이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellSnap {
    pub ch: char,
    pub fg: ColorSnap,
    pub bg: ColorSnap,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub strikeout: bool,
    pub hidden: bool,
    pub wide: bool,
}

/// 색 스냅샷 — alacritty 타입을 밖으로 새지 않게 자체 표현으로 고정한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColorSnap {
    Default,
    Named(u8),
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// 복원 대상 private mode 집합의 스냅샷(rehydrate 가 재현해야 하는 전부).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModeSnap {
    pub bracketed_paste: bool,
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub mouse_click: bool,
    pub mouse_drag: bool,
    pub mouse_motion: bool,
    pub sgr_mouse: bool,
    pub utf8_mouse: bool,
    pub focus_in_out: bool,
    pub alternate_scroll: bool,
    pub show_cursor: bool,
    pub line_wrap: bool,
    pub insert: bool,
}

// ── 이벤트 프록시 — 터미널이 PTY 에 쓰려는 응답을 포획한다 ─────────────────────

#[derive(Clone, Default)]
struct ReplyTap(Arc<Mutex<Vec<String>>>);

impl EventListener for ReplyTap {
    fn send_event(&self, event: Event) {
        if let Event::PtyWrite(text) = event {
            self.0.lock().unwrap_or_else(|e| e.into_inner()).push(text);
        }
    }
}

// ── Screen — 판정자·프로브 ───────────────────────────────────────────────────

/// 바이트를 실제 렌더해 읽는 헤드리스 터미널. 픽스처의 판정자이자, "이 바이트를
/// 먹은 터미널이 PTY 에 무엇을 되쓰려 했는가"(captured_replies)의 프로브다.
pub struct Screen {
    term: Term<ReplyTap>,
    parser: Processor,
    replies: Arc<Mutex<Vec<String>>>,
    cols: u16,
    rows: u16,
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Self {
        let tap = ReplyTap::default();
        let replies = tap.0.clone();
        let config = Config { scrolling_history: MIRROR_SCROLLBACK_LINES, ..Config::default() };
        let term = Term::new(config, &TermSize::new(cols as usize, rows as usize), tap);
        Screen { term, parser: Processor::new(), replies, cols, rows }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        self.term.resize(TermSize::new(cols as usize, rows as usize));
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// 이 화면이 PTY 에 되쓰려 한 응답들(DA1/DSR/OSC 질의 답). 재생 가드의 프로브 —
    /// 복원 시퀀스를 먹인 화면에서 이게 비어 있지 않으면 이중응답이다.
    pub fn captured_replies(&self) -> Vec<String> {
        self.replies.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn alt_active(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// 커서 위치(화면 기준 0-base row, col).
    pub fn cursor(&self) -> (usize, usize) {
        let p = self.term.grid().cursor.point;
        (p.line.0.max(0) as usize, p.column.0)
    }

    pub fn modes(&self) -> ModeSnap {
        let m = self.term.mode();
        ModeSnap {
            bracketed_paste: m.contains(TermMode::BRACKETED_PASTE),
            app_cursor: m.contains(TermMode::APP_CURSOR),
            app_keypad: m.contains(TermMode::APP_KEYPAD),
            mouse_click: m.contains(TermMode::MOUSE_REPORT_CLICK),
            mouse_drag: m.contains(TermMode::MOUSE_DRAG),
            mouse_motion: m.contains(TermMode::MOUSE_MOTION),
            sgr_mouse: m.contains(TermMode::SGR_MOUSE),
            utf8_mouse: m.contains(TermMode::UTF8_MOUSE),
            focus_in_out: m.contains(TermMode::FOCUS_IN_OUT),
            alternate_scroll: m.contains(TermMode::ALTERNATE_SCROLL),
            show_cursor: m.contains(TermMode::SHOW_CURSOR),
            line_wrap: m.contains(TermMode::LINE_WRAP),
            insert: m.contains(TermMode::INSERT),
        }
    }

    /// 보이는 화면(위→아래). 행 끝의 스타일 없는 공백은 잘라 비교를 안정화한다.
    pub fn visible_rows(&self) -> Vec<Vec<CellSnap>> {
        (0..self.rows as i32).map(|l| self.snap_row(Line(l))).collect()
    }

    /// 스크롤백(가장 오래된 것부터). 화면 위로 밀려난 행들만.
    pub fn history_rows(&self) -> Vec<Vec<CellSnap>> {
        let grid = self.term.grid();
        let hist = grid.history_size() as i32;
        (-hist..0).map(|l| self.snap_row(Line(l))).collect()
    }

    /// 행 텍스트만(스타일 무시) — 마커 존재 단언용.
    pub fn text_of(rows: &[Vec<CellSnap>]) -> Vec<String> {
        rows.iter().map(|r| r.iter().map(|c| c.ch).collect()).collect()
    }

    fn snap_row(&self, line: Line) -> Vec<CellSnap> {
        let grid = self.term.grid();
        let row = &grid[line];
        let mut out: Vec<CellSnap> = Vec::new();
        for col in 0..self.cols as usize {
            let cell = &row[Column(col)];
            if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            out.push(CellSnap {
                ch: cell.c,
                fg: snap_color(&cell.fg),
                bg: snap_color(&cell.bg),
                bold: cell.flags.contains(Flags::BOLD),
                dim: cell.flags.contains(Flags::DIM),
                italic: cell.flags.contains(Flags::ITALIC),
                underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
                inverse: cell.flags.contains(Flags::INVERSE),
                strikeout: cell.flags.contains(Flags::STRIKEOUT),
                hidden: cell.flags.contains(Flags::HIDDEN),
                wide: cell.flags.contains(Flags::WIDE_CHAR),
            });
        }
        // 꼬리의 "빈" 셀(무스타일 공백)은 비교 노이즈 — 잘라낸다. 직렬화기의 꼬리
        // 생략과 같은 기준(is_blank_default) — 단일 진실.
        while out.last().map_or(false, |c| {
            c.ch == ' '
                && c.fg == ColorSnap::Default
                && c.bg == ColorSnap::Default
                && !(c.bold || c.dim || c.italic || c.underline || c.inverse || c.strikeout || c.hidden)
        }) {
            out.pop();
        }
        out
    }
}

fn snap_color(color: &Color) -> ColorSnap {
    match color {
        Color::Named(NamedColor::Foreground) | Color::Named(NamedColor::Background) => {
            ColorSnap::Default
        }
        Color::Named(n) => ColorSnap::Named(*n as u8),
        Color::Indexed(i) => ColorSnap::Indexed(*i),
        Color::Spec(rgb) => ColorSnap::Rgb(rgb.r, rgb.g, rgb.b),
    }
}

// ── Mirror — 복원 경로의 단위 ────────────────────────────────────────────────

/// 세션 출력 전량을 헤드리스로 렌더해 화면 상태를 유지하고, 복원 시퀀스를 그리드에서
/// 합성한다. 재생 바이트는 전부 합성물이라 질의가 실릴 수 없다(이중응답 원천 차단).
///
/// alt-screen 뒤에 얼어 있는 프라임 화면: alacritty 는 비활성 그리드를 공개하지
/// 않으므로, alt 진입 시퀀스(`CSI ? …47/1047/1049… h`)를 피드 경계에서 감지해 진입
/// 직전의 프라임 페인트를 얼려 둔다(alt 활성 중 프라임은 불변이라 staleness 0).
pub struct Mirror {
    screen: Screen,
    // alt 진입 직전에 얼린 프라임 페인트 + 커서. alt 이탈 시 해제.
    frozen_primary: Option<FrozenPrimary>,
    // 청크 경계에 걸린 alt-진입 후보 시퀀스의 보류 버퍼(ESC 부터).
    held: Vec<u8>,
}

struct FrozenPrimary {
    paint: Vec<u8>,
    cursor: (usize, usize),
}

enum Candidate {
    // 청크가 후보 중간에서 끝났다 — 나머지가 와야 판정 가능.
    NeedMore,
    // alt 진입 DECSET(길이 = 시퀀스 전체 바이트 수).
    AltEnter(usize),
    // 후보 아님.
    No,
}

// b[0]==ESC 전제. `CSI ? <params> h` 이고 params 에 47|1047|1049 가 있으면 alt 진입.
fn classify_alt_enter(b: &[u8]) -> Candidate {
    if b.len() < 2 {
        return Candidate::NeedMore;
    }
    if b[1] != b'[' {
        return Candidate::No;
    }
    if b.len() < 3 {
        return Candidate::NeedMore;
    }
    if b[2] != b'?' {
        return Candidate::No;
    }
    let mut j = 3;
    while j < b.len() && (b[j].is_ascii_digit() || b[j] == b';') {
        j += 1;
        if j - 3 > 32 {
            return Candidate::No; // 비정상 파라미터 길이 — 보류 상한
        }
    }
    if j >= b.len() {
        return Candidate::NeedMore;
    }
    if b[j] != b'h' {
        return Candidate::No;
    }
    let hit = b[3..j]
        .split(|c| *c == b';')
        .any(|p| p == b"47" || p == b"1047" || p == b"1049");
    if hit {
        Candidate::AltEnter(j + 1)
    } else {
        Candidate::No
    }
}

impl Mirror {
    pub fn new(cols: u16, rows: u16) -> Self {
        Mirror { screen: Screen::new(cols, rows), frozen_primary: None, held: Vec::new() }
    }

    /// 세션 출력 바이트 소비. 절대 응답하지 않는다 — 응답 요구는 관찰값으로만 남는다.
    pub fn feed(&mut self, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.held);
        data.extend_from_slice(bytes);
        let mut fed = 0; // data[..fed] 는 이미 스크린에 들어갔다
        let mut i = 0;
        while i < data.len() {
            if data[i] != 0x1b {
                i += 1;
                continue;
            }
            match classify_alt_enter(&data[i..]) {
                Candidate::NeedMore => {
                    // 후보가 청크 끝에 걸렸다 — 프리픽스만 먹이고 나머지는 보류.
                    self.screen.feed(&data[fed..i]);
                    self.held = data[i..].to_vec();
                    return;
                }
                Candidate::AltEnter(len) => {
                    self.screen.feed(&data[fed..i]);
                    if !self.screen.alt_active() {
                        self.frozen_primary = Some(FrozenPrimary {
                            paint: paint_primary(&self.screen),
                            cursor: self.screen.cursor(),
                        });
                    }
                    self.screen.feed(&data[i..i + len]);
                    fed = i + len;
                    i = fed;
                }
                Candidate::No => {
                    i += 1;
                }
            }
        }
        self.screen.feed(&data[fed..]);
        // alt 이탈 후에는 프라임이 다시 라이브다 — 냉동 해제.
        if !self.screen.alt_active() {
            self.frozen_primary = None;
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.screen.resize(cols, rows);
    }

    /// warm 재부착 재생 시퀀스 — 신선한 터미널에 먹이면 세션의 화면 상태(스크롤백·
    /// alt-screen·모드·커서)가 재현된다. 전부 그리드 합성물이라 질의 바이트가 없다.
    pub fn rehydrate(&self) -> Vec<u8> {
        let mut out = b"\x1b[0m".to_vec();
        if self.screen.alt_active() {
            if let Some(fp) = &self.frozen_primary {
                out.extend_from_slice(&fp.paint);
                out.extend(cup(fp.cursor));
            }
            out.extend_from_slice(b"\x1b[?1049h");
            out.extend(paint_alt(&self.screen));
            out.extend(cup(self.screen.cursor()));
        } else {
            out.extend(paint_primary(&self.screen));
            out.extend(cup(self.screen.cursor()));
        }
        out.extend(mode_sets(&self.screen.modes()));
        out
    }

    /// cold 체크포인트 페인트 — 화면 이력을 비활성 텍스트로 평면화한 시퀀스. alt-screen
    /// 이 활성이었다면 그 프레임 내용이 (모드 전환 없이) 텍스트 블록으로 이어진다.
    /// 죽은 세션의 잔상은 텍스트가 정직하다 — 프로세스 없는 alt-screen 은 만들지 않는다.
    pub fn cold_paint(&self) -> Vec<u8> {
        let mut out = b"\x1b[0m".to_vec();
        if self.screen.alt_active() {
            if let Some(fp) = &self.frozen_primary {
                out.extend_from_slice(&fp.paint);
            }
            out.extend_from_slice(b"\r\n");
            out.extend(paint_alt_flat(&self.screen));
        } else {
            out.extend(paint_primary(&self.screen));
        }
        out.extend_from_slice(b"\x1b[0m\r\n");
        out
    }

    /// alt-screen 활성 여부(체크포인트 메타·고지용).
    pub fn alt_active(&self) -> bool {
        self.screen.alt_active()
    }

    /// 미러가 삼킨 응답 요구 수(DA1/DSR 등). 관찰 전용 — 응답 경로는 존재하지 않는다.
    pub fn suppressed_replies(&self) -> u64 {
        self.screen.captured_replies().len() as u64
    }
}

// ── 직렬화기 — 그리드 → SGR 런(공개 API 만, 사적 API 의존 금지) ────────────────

fn cup((row, col): (usize, usize)) -> Vec<u8> {
    format!("\x1b[{};{}H", row + 1, col + 1).into_bytes()
}

// 직렬화기·판정자 공용 "빈 셀" 기준 — 꼬리 생략의 단일 진실.
fn cell_is_blank_default(cell: &alacritty_terminal::term::cell::Cell) -> bool {
    cell.c == ' '
        && matches!(cell.fg, Color::Named(NamedColor::Foreground))
        && matches!(cell.bg, Color::Named(NamedColor::Background))
        && !cell.flags.intersects(
            Flags::BOLD
                | Flags::DIM
                | Flags::ITALIC
                | Flags::ALL_UNDERLINES
                | Flags::INVERSE
                | Flags::STRIKEOUT
                | Flags::HIDDEN,
        )
        && cell.zerowidth().is_none()
}

#[derive(Default, PartialEq, Clone)]
struct SgrKey {
    fg: Option<String>,
    bg: Option<String>,
    attrs: Vec<&'static str>,
}

fn sgr_key(cell: &alacritty_terminal::term::cell::Cell) -> SgrKey {
    let mut attrs = Vec::new();
    if cell.flags.contains(Flags::BOLD) {
        attrs.push("1");
    }
    if cell.flags.contains(Flags::DIM) {
        attrs.push("2");
    }
    if cell.flags.contains(Flags::ITALIC) {
        attrs.push("3");
    }
    if cell.flags.intersects(Flags::ALL_UNDERLINES) {
        attrs.push("4");
    }
    if cell.flags.contains(Flags::INVERSE) {
        attrs.push("7");
    }
    if cell.flags.contains(Flags::HIDDEN) {
        attrs.push("8");
    }
    if cell.flags.contains(Flags::STRIKEOUT) {
        attrs.push("9");
    }
    SgrKey { fg: color_code(&cell.fg, false), bg: color_code(&cell.bg, true), attrs }
}

// 셀 색 → SGR 코드 조각. 기본색은 None(리셋 상태 그대로).
fn color_code(color: &Color, is_bg: bool) -> Option<String> {
    let base = if is_bg { 40 } else { 30 };
    let bright = if is_bg { 100 } else { 90 };
    let ext = if is_bg { 48 } else { 38 };
    match color {
        Color::Named(NamedColor::Foreground) if !is_bg => None,
        Color::Named(NamedColor::Background) if is_bg => None,
        Color::Named(n) => {
            let i = *n as usize;
            if i < 8 {
                Some(format!("{}", base + i))
            } else if i < 16 {
                Some(format!("{}", bright + (i - 8)))
            } else {
                None // 파서가 셀에 넣지 않는 특수 이름(커서 등) — 기본색으로
            }
        }
        Color::Indexed(i) => Some(format!("{ext};5;{i}")),
        Color::Spec(rgb) => Some(format!("{ext};2;{};{};{}", rgb.r, rgb.g, rgb.b)),
    }
}

fn emit_sgr(out: &mut Vec<u8>, key: &SgrKey) {
    let mut parts: Vec<String> = vec!["0".into()];
    parts.extend(key.attrs.iter().map(|s| s.to_string()));
    if let Some(fg) = &key.fg {
        parts.push(fg.clone());
    }
    if let Some(bg) = &key.bg {
        parts.push(bg.clone());
    }
    out.extend(format!("\x1b[{}m", parts.join(";")).into_bytes());
}

// 한 행을 SGR 런으로 페인트. 반환 = 이 행이 자연 개행(wrap)으로 이어지는가.
// wrap 행은 전체 폭을 그대로 내보내(재생 시 같은 지점에서 다시 감긴다), 아닌 행은
// 꼬리의 빈 셀을 생략한다(판정자와 같은 기준).
fn paint_row(
    out: &mut Vec<u8>,
    screen: &Screen,
    line: Line,
    style: &mut SgrKey,
) -> bool {
    let grid = screen.term.grid();
    let row = &grid[line];
    let cols = screen.cols as usize;
    let wrapped = row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
    // 생략 가능한 꼬리 길이(wrap 행은 0).
    let mut last = cols;
    if !wrapped {
        while last > 0 && cell_is_blank_default(&row[Column(last - 1)]) {
            last -= 1;
        }
    }
    for col in 0..last {
        let cell = &row[Column(col)];
        if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            continue;
        }
        let key = sgr_key(cell);
        if key != *style {
            emit_sgr(out, &key);
            *style = key;
        }
        let mut buf = [0u8; 4];
        out.extend_from_slice(cell.c.encode_utf8(&mut buf).as_bytes());
        if let Some(zw) = cell.zerowidth() {
            for c in zw {
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    wrapped
}

// 프라임 페인트: 스크롤백 전체 + 보이는 화면 전 행. 모든 행을 그려야(빈 행 포함)
// 원본과 같은 바닥 정렬로 끝난다 — 커서는 호출자가 CUP 으로 되돌린다.
fn paint_primary(screen: &Screen) -> Vec<u8> {
    let mut out = Vec::new();
    let mut style = SgrKey::default();
    let hist = screen.term.grid().history_size() as i32;
    let rows = screen.rows as i32;
    for l in -hist..rows {
        let wrapped = paint_row(&mut out, screen, Line(l), &mut style);
        if !wrapped && l != rows - 1 {
            out.extend_from_slice(b"\r\n");
        }
    }
    out.extend_from_slice(b"\x1b[0m");
    out
}

// alt 화면 페인트(재수화용): 행마다 CUP 절대주소 — 스크롤이 일어나지 않는다.
fn paint_alt(screen: &Screen) -> Vec<u8> {
    let mut out = b"\x1b[2J".to_vec();
    let mut style = SgrKey::default();
    for l in 0..screen.rows as i32 {
        let row_start = out.len();
        out.extend(format!("\x1b[{};1H", l + 1).into_bytes());
        let before = out.len();
        paint_row(&mut out, screen, Line(l), &mut style);
        if out.len() == before {
            out.truncate(row_start); // 빈 행은 CUP 조차 생략
        }
    }
    out.extend_from_slice(b"\x1b[0m");
    out
}

// alt 화면 평면화(cold용): 내용 있는 행만 위→아래 텍스트 블록으로.
fn paint_alt_flat(screen: &Screen) -> Vec<u8> {
    let mut rows: Vec<Vec<u8>> = Vec::new();
    let mut style = SgrKey::default();
    for l in 0..screen.rows as i32 {
        let mut row = Vec::new();
        paint_row(&mut row, screen, Line(l), &mut style);
        rows.push(row);
    }
    while rows.last().map_or(false, |r| r.is_empty()) {
        rows.pop();
    }
    let mut out = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        out.extend_from_slice(row);
        if i != rows.len() - 1 {
            out.extend_from_slice(b"\r\n");
        }
    }
    out
}

// private mode 재수화 — 신선한 터미널의 기본값과 다른 것만 내보낸다.
fn mode_sets(m: &ModeSnap) -> Vec<u8> {
    let mut out = Vec::new();
    let mut set = |cond: bool, seq: &str| {
        if cond {
            out.extend_from_slice(seq.as_bytes());
        }
    };
    set(m.bracketed_paste, "\x1b[?2004h");
    set(m.app_cursor, "\x1b[?1h");
    set(m.app_keypad, "\x1b=");
    set(m.mouse_click, "\x1b[?1000h");
    set(m.mouse_drag, "\x1b[?1002h");
    set(m.mouse_motion, "\x1b[?1003h");
    set(m.sgr_mouse, "\x1b[?1006h");
    set(m.utf8_mouse, "\x1b[?1005h");
    set(m.focus_in_out, "\x1b[?1004h");
    set(m.insert, "\x1b[4h");
    // 기본 켜짐인 모드는 꺼짐만 내보낸다.
    set(!m.alternate_scroll, "\x1b[?1007l");
    set(!m.line_wrap, "\x1b[?7l");
    set(!m.show_cursor, "\x1b[?25l");
    out
}
