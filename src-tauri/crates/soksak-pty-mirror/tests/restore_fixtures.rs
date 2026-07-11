// 복원 픽스처(플랜 §5.5 M1) — cold byte restore 계약의 지뢰 5종을 실패 테스트로 못박는다.
// 계약: Mirror 가 세션 출력 전량을 먹은 뒤 내놓는 복원 시퀀스를 신선한 터미널(Screen 판정자)에
// 먹이면, 원본 세션의 화면 상태(스크롤백·보이는 화면·alt-screen·private mode·커서)가 재현되고,
// 재생 중 터미널이 PTY 에 되쓰는 바이트는 0 이어야 한다(이중응답 차단).
//
// RED 근거(랜딩 당시): M1 세대의 Mirror 실체 = raw 스크롤백 링(당시 데몬 warm 재부착이
// 재생하던 바이트 꼬리). 링은 바이트 단위로 잘리므로 ① 이스케이프 중간 절단 ② UTF-8
// 중간 절단 ③ alt-screen 진입점 유실 ④ private mode 세트 유실 ⑤ 재생분 안의 질의
// 재응답이 그대로 드러났다. M2(미러+직렬화기)가 같은 계약을 GREEN 으로 만들었다 —
// 이 픽스처들이 그 회귀 감지망이다.

use soksak_pty_mirror::{Mirror, Screen};

const COLS: u16 = 80;
const ROWS: u16 = 24;
// 데몬 세션 링 용량(soksak-ptyd)과 같은 값 — 절단 지점을 실물 조건으로 배치한다.
const RING: usize = 1_048_576;

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

fn judge_of(bytes: &[u8]) -> Screen {
    let mut s = Screen::new(COLS, ROWS);
    s.feed(bytes);
    s
}

fn restored_of(m: &Mirror) -> Screen {
    let mut s = Screen::new(COLS, ROWS);
    s.feed(&m.rehydrate());
    s
}

// 원본과 복원본의 화면 상태 등가 단언 — 계약의 본문.
fn assert_state_restored(original: &Screen, restored: &Screen, ctx: &str) {
    assert_eq!(original.alt_active(), restored.alt_active(), "{ctx}: alt-screen 활성 상태");
    assert_eq!(original.modes(), restored.modes(), "{ctx}: private mode 집합");
    let (oh, rh) = (original.history_rows(), restored.history_rows());
    assert_eq!(
        Screen::text_of(&oh),
        Screen::text_of(&rh),
        "{ctx}: 스크롤백 텍스트"
    );
    assert_eq!(oh, rh, "{ctx}: 스크롤백 셀(스타일 포함)");
    let (ov, rv) = (original.visible_rows(), restored.visible_rows());
    assert_eq!(Screen::text_of(&ov), Screen::text_of(&rv), "{ctx}: 보이는 화면 텍스트");
    assert_eq!(ov, rv, "{ctx}: 보이는 화면 셀(스타일 포함)");
    assert_eq!(original.cursor(), restored.cursor(), "{ctx}: 커서 위치");
}

// 트루컬러 wide 문자 행(80칸·바이트 길이 고정 1046) — 행마다 색이 달라 정렬 오차가 보인다.
// 행의 첫 바이트가 이스케이프 시작(\x1b)이라 절단 지점을 이스케이프 중간에 놓을 수 있다.
// 행이 1KB 를 넘어야 링(1MB)이 스크롤백 창(1000행)보다 적은 행을 담는다 — 절단 손상이
// 비교 창 안에 남는 실물 조건(짙은 화면일수록 링이 담는 시간이 짧다)이다.
fn heavy_row(i: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(1046);
    for j in 0..40 {
        let r = 100 + ((i * 7 + j * 13) % 156);
        let g = 100 + ((i * 11 + j * 3) % 156);
        let b = 100 + ((i * 5 + j * 17) % 156);
        v.extend_from_slice(format!("\x1b[0;1;38;2;{r};{g};{b}m가").as_bytes());
    }
    v.extend_from_slice(b"\x1b[0m\r\n");
    assert_eq!(v.len(), 1046);
    v
}

// 마지막을 정확한 바이트 수로 맞추는 패딩 줄("PAD:xxx…\r\n").
fn pad_line(len: usize) -> Vec<u8> {
    assert!(len >= 7, "pad too small: {len}");
    let mut v = b"PAD:".to_vec();
    v.extend(std::iter::repeat(b'x').take(len - 6));
    v.extend_from_slice(b"\r\n");
    v
}

// ── ① mid-escape tail — 링 절단이 이스케이프 시퀀스 한가운데 떨어진다 ─────────

#[test]
fn mid_escape_tail_restores_exact_rows() {
    // rows 블록을 정확히 RING+3 바이트로 만들면, 링(마지막 RING 바이트)은 rows[0] 의
    // "\x1b[3…" 에서 3바이트 들어간 "8;2;…" 부터 시작한다 — 이스케이프 중간 절단.
    let mut rows: Vec<u8> = Vec::new();
    let mut i = 0;
    while rows.len() < RING + 3 - 2000 {
        rows.extend(heavy_row(i));
        i += 1;
    }
    rows.extend_from_slice(b"\x1b[31mTAIL-END-MARK\x1b[0m\r\n");
    let deficit = RING + 3 - rows.len();
    rows.extend(pad_line(deficit));
    assert_eq!(rows.len(), RING + 3, "절단 정렬이 픽스처의 전제");

    let mut stream = b"SEED-MARK\r\n".to_vec();
    stream.extend_from_slice(&rows);

    let original = judge_of(&stream);
    let mut m = Mirror::new(COLS, ROWS);
    m.feed(&stream);
    let restored = restored_of(&m);

    assert!(
        Screen::text_of(&restored.visible_rows())
            .iter()
            .chain(Screen::text_of(&restored.history_rows()).iter())
            .any(|l| l.contains("TAIL-END-MARK")),
        "복원본에 꼬리 마커가 있어야 한다"
    );
    assert_state_restored(&original, &restored, "mid-escape tail");
}

// ── ② CJK/unicode 폭 — UTF-8 문자 중간 절단 + wide 문자 열 정렬 ───────────────

#[test]
fn cjk_width_survives_mid_char_cut() {
    // wide 문자 행(첫 문자 '한' = 3바이트). rows 블록 == RING+1 이면 링은 '한'의
    // 두 번째 바이트부터 시작한다 — UTF-8 중간 절단.
    fn cjk_row(i: usize) -> Vec<u8> {
        let mut v = b"\xed\x95\x9c".to_vec(); // '한'
        for j in 0..39 {
            let r = 100 + ((i * 3 + j * 19) % 156);
            let g = 100 + ((i * 13 + j * 7) % 156);
            let b = 100 + ((i * 17 + j * 5) % 156);
            v.extend_from_slice(format!("\x1b[0;1;7;38;2;{r};{g};{b}m나").as_bytes());
        }
        v.extend_from_slice(b"\x1b[0m\r\n");
        assert_eq!(v.len(), 1101);
        v
    }

    let mut rows: Vec<u8> = Vec::new();
    let mut i = 0;
    while rows.len() < RING + 1 - 2000 {
        rows.extend(cjk_row(i));
        i += 1;
    }
    // 열 정렬 마커: 좁은/넓은 혼합 + 줄 경계에 걸리는 wide 문자(선두 스페이서 경로).
    rows.extend_from_slice("CJK-MIX abc\u{1b}[35m가나다\u{1b}[0mdef END|\r\n".as_bytes());
    let edge: Vec<u8> = {
        let mut v = vec![b'a'; 79];
        v.extend_from_slice("가\r\n".as_bytes());
        v
    };
    rows.extend_from_slice(&edge);
    let deficit = RING + 1 - rows.len();
    rows.extend(pad_line(deficit));
    assert_eq!(rows.len(), RING + 1, "절단 정렬이 픽스처의 전제");

    let mut stream = b"CJK-SEED\r\n".to_vec();
    stream.extend_from_slice(&rows);

    let original = judge_of(&stream);
    let mut m = Mirror::new(COLS, ROWS);
    m.feed(&stream);
    let restored = restored_of(&m);

    assert_state_restored(&original, &restored, "cjk width");
}

// ── ③ alt-screen 진입/이탈 — TUI 화면과 그 뒤의 프라임 스크롤백이 함께 재현된다 ──

#[test]
fn alt_screen_state_and_primary_scrollback_restore() {
    // 프라임 화면에 스크롤백 마커 → alt 진입 → 프레임 스팸(> RING, 1049h 가 링 밖으로
    // 밀려남) → 최종 TUI 프레임 + 커서 숨김. 복원본은 alt 활성 + 최종 프레임 + 프라임
    // 스크롤백(마커)이어야 한다.
    fn frame(k: usize) -> Vec<u8> {
        let mut v = b"\x1b[H".to_vec();
        for row in 1..=22usize {
            v.extend(format!("\x1b[{row};1H").into_bytes());
            v.extend(format!("F{k:03}-{row:02}:").into_bytes());
            for j in 0..36 {
                let r = 100 + ((k * 7 + row * 3 + j * 13) % 156);
                let g = 100 + ((k * 5 + row * 11 + j * 3) % 156);
                let b = 100 + ((k * 13 + row * 7 + j * 17) % 156);
                v.extend(format!("\x1b[38;2;{r};{g};{b}m나").into_bytes());
            }
            v.extend_from_slice(b"\x1b[0m");
        }
        v
    }

    let mut stream = Vec::new();
    // 화면(24행)보다 많은 줄 — 일부가 실제 스크롤백으로 밀려 들어간 상태에서 alt 진입.
    for n in 1..=30 {
        stream.extend(format!("SCROLLBACK-MARK line{n}\r\n").into_bytes());
    }
    stream.extend_from_slice(b"\x1b[?1049h");
    let alt_start = stream.len();
    let mut k = 0;
    while stream.len() - alt_start < RING + 500 {
        stream.extend(frame(k));
        k += 1;
    }
    stream.extend_from_slice(b"\x1b[2J\x1b[H");
    stream.extend_from_slice("\u{250c} TUI-FINAL-MARK \u{2510}\r\n".as_bytes());
    stream.extend_from_slice("\u{2502} \u{1b}[33minner\u{1b}[0m body \u{2502}\r\n".as_bytes());
    stream.extend_from_slice("\u{2514}\u{2500}\u{2500}\u{2500}\u{2518}".as_bytes());
    stream.extend_from_slice(b"\x1b[2;3H\x1b[?25l");

    let original = judge_of(&stream);
    assert!(original.alt_active(), "픽스처 전제: 원본은 alt-screen 활성");
    let mut m = Mirror::new(COLS, ROWS);
    m.feed(&stream);
    let mut restored = restored_of(&m);

    assert_state_restored(&original, &restored, "alt-screen active");

    // alt 활성 중 프라임은 관찰 불가(비활성 그리드) — 복원본의 alt 를 벗겨서, 얼려
    // 운반된 프라임 화면과 스크롤백이 실제로 그 밑에 깔려 있는지 확인한다.
    restored.feed(b"\x1b[?1049l");
    assert!(
        Screen::text_of(&restored.history_rows()).iter().any(|l| l.contains("SCROLLBACK-MARK")),
        "alt 뒤에 얼어 있던 프라임 스크롤백이 복원되어야 한다"
    );
    assert!(
        Screen::text_of(&restored.visible_rows()).iter().any(|l| l.contains("SCROLLBACK-MARK line30")),
        "alt 뒤에 얼어 있던 프라임 화면이 복원되어야 한다"
    );

    // 이탈: alt 를 끝내면 프라임 화면과 스크롤백이 그대로 돌아온다.
    let exit: &[u8] = b"\x1b[?25h\x1b[?1049lBACK-MARK\r\n";
    let mut full = stream.clone();
    full.extend_from_slice(exit);
    let original2 = judge_of(&full);
    assert!(!original2.alt_active(), "픽스처 전제: 이탈 후 프라임");
    m.feed(exit);
    let restored2 = restored_of(&m);
    assert!(
        Screen::text_of(&restored2.visible_rows()).iter().any(|l| l.contains("BACK-MARK")),
        "이탈 후 프라임 화면 마커"
    );
    assert_state_restored(&original2, &restored2, "alt-screen exited");
}

// ── ④ private mode rehydrate — bracketed paste·마우스·앱 커서가 링 창 밖에서도 산다 ──

#[test]
fn private_modes_rehydrate_after_ring_window() {
    let mut stream = Vec::new();
    // 세션 초기에 켜진 모드들 — 이후 출력이 링 용량을 넘어 세트 시퀀스가 창 밖으로 밀린다.
    stream.extend_from_slice(b"\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1h\x1b=\x1b[?1004h\x1b[?1007h");
    stream.extend_from_slice(b"MODES-SET-MARK\r\n");
    for i in 0..1200 {
        stream.extend(heavy_row(i));
    }
    stream.extend_from_slice(b"AFTER-FILL-MARK\r\n");
    assert!(stream.len() > RING + 4096, "픽스처 전제: 모드 세트가 링 창 밖");

    let original = judge_of(&stream);
    let m = original.modes();
    assert!(
        m.bracketed_paste && m.mouse_drag && m.sgr_mouse && m.app_cursor && m.app_keypad
            && m.focus_in_out && m.alternate_scroll,
        "픽스처 전제: 원본 모드 전부 켜짐: {m:?}"
    );

    let mut mirror = Mirror::new(COLS, ROWS);
    mirror.feed(&stream);
    let restored = restored_of(&mirror);

    assert_eq!(original.modes(), restored.modes(), "private mode 집합 재수화");
    assert_state_restored(&original, &restored, "private modes");
}

// ── ⑤ replay-guard — 재생분 안의 질의에 어떤 경로도 다시 응답하지 않는다 ─────────

#[test]
fn replay_never_answers_queries() {
    // DA1/DA2/DSR/OSC 질의가 세션 출력에 들어 있었다. 라이브 때는 프론트 xterm 이
    // 한 번 응답했다(단일 응답자). 복원 재생에서 두 번째 응답이 나오면 셸 stdin 오염이다.
    let mut stream = b"GUARD-MARK\r\n".to_vec();
    stream.extend_from_slice(b"\x1b[c");        // DA1
    stream.extend_from_slice(b"\x1b[>c");       // DA2
    stream.extend_from_slice(b"\x1b[6n");       // DSR 커서 질의
    stream.extend_from_slice(b"\x1b]11;?\x07"); // OSC 배경색 질의
    stream.extend_from_slice(b"AFTER-QUERY-MARK\r\n");

    // 프로브 대조: 이 바이트를 먹은 터미널은 실제로 응답을 만들려 한다(판정자 유효성).
    let original = judge_of(&stream);
    assert!(
        !original.captured_replies().is_empty(),
        "픽스처 전제: 질의 스트림은 터미널 응답을 유발한다"
    );

    let mut m = Mirror::new(COLS, ROWS);
    m.feed(&stream);

    // 미러 자신은 응답 경로가 없고, 삼킨 질의를 관찰값으로만 남긴다.
    assert!(m.suppressed_replies() > 0, "미러가 질의를 보고 삼켰음을 관찰");

    // 재생 시퀀스에 질의 바이트가 실려서는 안 된다(이중응답 원천 차단).
    let replay = m.rehydrate();
    for pat in [&b"\x1b[c"[..], &b"\x1b[>c"[..], &b"\x1b[6n"[..], &b"\x1b]11;?"[..]] {
        assert!(
            !replay.windows(pat.len()).any(|w| w == pat),
            "재생 시퀀스에 질의 {pat:?} 가 실림"
        );
    }

    // 재생을 먹인 터미널이 PTY 에 되쓰려는 바이트 = 0 ("재생 중 PTY write 0바이트").
    let restored = restored_of(&m);
    assert_eq!(
        restored.captured_replies(),
        Vec::<String>::new(),
        "재생 중 터미널 응답(PTY write)은 0바이트여야 한다"
    );

    // 내용은 그대로 재현된다(질의는 화면에 보이지 않는 바이트다).
    assert_state_restored(&original, &restored, "replay guard");
}
