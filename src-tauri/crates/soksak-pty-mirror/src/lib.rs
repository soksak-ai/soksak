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
        // 꼬리의 "빈" 셀(무스타일 공백)은 비교 노이즈 — 잘라낸다.
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

/// 이 세대(M1)의 정직한 실체 = raw 스크롤백 링. 오늘의 warm 재부착이 재생하는 그
/// 바이트 꼬리를 그대로 계약 아래 놓는다 — 픽스처 5종(mid-escape 꼬리·CJK 폭·
/// alt-screen·private mode·재생 가드)이 이 실체에서 RED 다. M2 가 이 내부를
/// alacritty 미러+직렬화기로 바꿔 같은 계약을 GREEN 으로 만든다.
pub struct Mirror {
    ring: Vec<u8>,
    capacity: usize,
}

impl Mirror {
    pub fn new(_cols: u16, _rows: u16) -> Self {
        // 링 용량은 데몬 실물과 같은 값(soksak-ptyd 의 세션 링) — 시험용 축소 금지.
        Mirror { ring: Vec::new(), capacity: 1_048_576 }
    }

    /// 세션 출력 바이트 소비. 절대 응답하지 않는다.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.ring.extend_from_slice(bytes);
        if self.ring.len() > self.capacity {
            let cut = self.ring.len() - self.capacity;
            self.ring.drain(..cut);
        }
    }

    pub fn resize(&mut self, _cols: u16, _rows: u16) {}

    /// warm 재부착 재생 시퀀스 — 신선한 터미널에 먹이면 세션의 화면 상태(스크롤백·
    /// alt-screen·모드·커서)가 재현되어야 하고, 질의 바이트가 실려서는 안 된다.
    pub fn rehydrate(&self) -> Vec<u8> {
        self.ring.clone()
    }

    /// cold 체크포인트 페인트 — 화면 이력을 비활성 텍스트로 평면화한 시퀀스.
    /// alt-screen 이 활성이었다면 그 프레임 내용도 (모드 전환 없이) 텍스트로 실린다.
    pub fn cold_paint(&self) -> Vec<u8> {
        self.ring.clone()
    }

    /// 미러가 삼킨 응답 요구 수(DA1/DSR 등). 관찰 전용 — 응답 경로는 존재하지 않는다.
    pub fn suppressed_replies(&self) -> u64 {
        0
    }
}
