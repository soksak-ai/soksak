// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if soksak_lib::plugin_runtime::helper_requested() {
        if let Err(error) = soksak_lib::plugin_runtime::run_helper_from_stdio() {
            eprintln!("[plugin-runtime-helper] {error}");
            std::process::exit(70);
        }
        return;
    }
    if soksak_lib::plugin_runtime::conformance_requested() {
        match soksak_lib::plugin_runtime::run_native_runtime_conformance() {
            Ok(report) => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
            Err(error) => {
                eprintln!("[plugin-runtime-conformance] {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    soksak_lib::run()
}
