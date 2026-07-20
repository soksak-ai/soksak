// Headless boot — for CI, cron, and any GUI-less automation. The main (control-plane) window
// still boots so its webview hosts the command registry and the socket, but it is hidden and the
// process claims no dock/foreground. Project windows are on-demand, so a headless boot creates
// none — the orchestra(main) vs project-window split holds without extra guards. Environments
// with no display server (Linux CI runners) run this process under xvfb: the window is created
// against a virtual display and hidden here. Toggle with SOKSAK_HEADLESS=1|true.
use tauri::{AppHandle, Manager};

/// Pure predicate over the SOKSAK_HEADLESS value — only an explicit truthy toggle enables it.
pub fn is_headless_value(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1") | Some("true") | Some("TRUE") | Some("True"))
}

pub fn is_headless() -> bool {
    is_headless_value(std::env::var("SOKSAK_HEADLESS").ok().as_deref())
}

/// Hide the main window (its webview stays alive) and drop the dock/foreground presence. Called
/// once at the tail of boot setup, only when `is_headless()`.
pub fn apply(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

#[cfg(test)]
mod tests {
    use super::is_headless_value;

    #[test]
    fn headless_only_for_explicit_truthy_values() {
        for on in ["1", "true", "TRUE", "True", " 1 ", "  true  "] {
            assert!(is_headless_value(Some(on)), "{on:?} should enable headless");
        }
        for off in ["0", "", "no", "false", "gui", "2"] {
            assert!(!is_headless_value(Some(off)), "{off:?} must not enable headless");
        }
        assert!(!is_headless_value(None), "unset must not enable headless");
    }
}
