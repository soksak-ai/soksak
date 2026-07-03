// Chromium 서브프로세스 helper — renderer/GPU/utility 가 이 바이너리로 뜬다(cefsimple 의 분리-helper
// 패턴). 하는 일은 framework 로드(helper 상대 경로 해소) + execute_process 뿐. 브라우저(메인) 프로세스
// 는 앱 본체(dylib 의 initialize)가 담당하며 이 바이너리를 직접 실행하지 않는다.
//
// 배치: dist/soksak-sidecar-chromium Helper.app/Contents/MacOS/<이 바이너리>. LibraryLoader(helper=true)
// 가 실행파일 기준 ../../../../Chromium Embedded Framework.framework 를 해소한다 — dist 디렉토리가
// CEF 정본 macOS 배치의 Frameworks 디렉토리 역할(무코드 성립).

#[cfg(target_os = "macos")]
fn main() {
    use cef::args::Args;
    use cef::library_loader::LibraryLoader;

    let exe = std::env::current_exe().expect("current_exe");
    let loader = LibraryLoader::new(&exe, /*helper=*/ true);
    if !loader.load() {
        eprintln!("[chromium-helper] framework 로드 실패");
        std::process::exit(1);
    }
    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let args = Args::new();
    let code = cef::execute_process(Some(args.as_main_args()), None, std::ptr::null_mut());
    std::process::exit(code);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("soksak-sidecar-chromium-helper: macOS 전용");
    std::process::exit(1);
}
