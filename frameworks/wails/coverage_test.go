package wails

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/boot"
	"github.com/soksak/soksak-core/core/control"
)

// invokeCall finds the backend commands the frontend calls by name.
var invokeCall = regexp.MustCompile(`invoke(?:Command)?[A-Za-z]*<?[^>(]*>?\(\s*"([a-z][a-z0-9_]*)"`)

// unserved is what the frontend calls and this build does not answer yet.
//
// Every entry is a feature that fails the moment a user reaches it. The list is
// here rather than in a document because a document does not fail: while it was
// only written down, "the boot commands are all served" was true and sounded
// like the application worked — it did not, and opening a project stopped on
// the first missing name.
//
// Removing an entry is the definition of progress. Adding one is a decision:
// the frontend now calls something this backend does not answer, and that must
// be a choice rather than a discovery made by a user.
var unserved = map[string]string{
	// Project lifecycle. Nothing about a workspace is reachable without these.
	"validate_project_root":  "project",
	"project_release":        "project",
	"window_manifest_upsert": "project",

	// Files and watching.
	"read_text_file":  "files",
	"write_text_file": "files",
	"watch_dir":       "files",
	"unwatch_dir":     "files",
	"list_children":   "files",
	"shell_which":     "files",

	// Terminal and PTY.
	"spawn_terminal":         "terminal",
	"write_terminal":         "terminal",
	"resize_terminal":        "terminal",
	"close_terminal":         "terminal",
	"ack_terminal":           "terminal",
	"pty_pane_alive":         "terminal",
	"pty_read_sealed_screen": "terminal",
	"pty_sidecar_request":    "terminal",
	"pty_daemon_status":      "terminal",
	"pty_daemon_restart":     "terminal",
	"pty_daemon_upgrade":     "terminal",

	// Child processes.
	"process_spawn":             "process",
	"process_kill":              "process",
	"process_list":              "process",
	"process_write":             "process",
	"process_stdin_close":       "process",
	"process_reclaim_by_window": "process",
	"cleanup_stale":             "process",

	// Windows.
	"titlebar_backing": "window",

	// Native surfaces.
	"webview_close":   "surface",
	"webview_recover": "surface",
	"webview_visible": "surface",

	// Storage beyond the key-value pairs boot needs.
	"data_get":             "storage",
	"data_put":             "storage",
	"data_delete":          "storage",
	"data_query":           "storage",
	"data_search":          "storage",
	"data_count":           "storage",
	"data_define":          "storage",
	"data_migrate_ns":      "storage",
	"data_restore":         "storage",
	"data_kv_delete":       "storage",
	"data_kv_keys":         "storage",
	"data_retention_reap":  "storage",
	"data_retention_trim":  "storage",
	"data_encrypt_status":  "storage",
	"data_encrypt_rotate":  "storage",
	"data_encrypt_recover": "storage",
	"plugin_data_read":     "storage",
	"plugin_data_write":    "storage",
	"plugin_data_list":     "storage",

	// Secrets.
	"secret_set":     "secret",
	"secret_has":     "secret",
	"secret_delete":  "secret",
	"secret_keys":    "secret",
	"secret_backend": "secret",

	// Sidecars and services.
	"sidecar_open":     "sidecar",
	"sidecar_send":     "sidecar",
	"sidecar_close":    "sidecar",
	"service_dispatch": "sidecar",
	"service_bus_push": "sidecar",

	// Daemon and schedule.
	"daemon_start":      "daemon",
	"daemon_stop":       "daemon",
	"daemon_status":     "daemon",
	"daemon_logs":       "daemon",
	"daemon_reap":       "daemon",
	"daemon_run_once":   "daemon",
	"schedule_register": "daemon",
	"schedule_cancel":   "daemon",
	"schedule_list":     "daemon",
	"schedule_poke":     "daemon",

	// Everything else the frontend reaches for.
	"activity_recent":        "misc",
	"ai_session_untrack":     "misc",
	"app_relaunch":           "misc",
	"app_shutdown_commit":    "misc",
	"clipboard_read":         "misc",
	"clipboard_write":        "misc",
	"clipboard_watch_start":  "misc",
	"clipboard_watch_stop":   "misc",
	"cmd_result":             "misc",
	"download_verify":        "misc",
	"ipc_hello_info":         "misc",
	"notify_activate":        "misc",
	"plugin_remove":          "misc",
	"remote_confirm_resolve": "misc",
	"skill_refresh_spawn":    "misc",
	"unit_dev_set":           "misc",
	"unit_dev_remove":        "misc",
	"update_check":           "misc",
	"update_apply":           "misc",
	"verify_and_link":        "misc",
	"ws_connect":             "misc",
	"ws_send":                "misc",
	"ws_close":               "misc",

	// Added by the gate on 2026-08-15.
	"ensure_project_dir":      "project",
	"ipc_last_project_window": "project",
	"project_claim":           "project",

	// Added by the gate on 2026-08-15.
	"read_file_base64":  "files",
	"write_file_base64": "files",

	// Added by the gate on 2026-08-15.
	"pty_pane_pid": "terminal",

	// Added by the gate on 2026-08-15.
	"webview_health_query": "window",
	"webview_list":         "window",

	// Added by the gate on 2026-08-15.
	"engine_surface_stats": "surface",

	// Added by the gate on 2026-08-15.
	"data_backup":                  "storage",
	"data_canary":                  "storage",
	"data_encrypt_change_recovery": "storage",
	"data_encrypt_convert":         "storage",
	"data_encrypt_enable":          "storage",
	"data_export":                  "storage",
	"data_import":                  "storage",
	"data_kv_delete_many":          "storage",
	"data_kv_entries":              "storage",
	"data_kv_history":              "storage",
	"data_kv_undo":                 "storage",
	"data_ns_remove":               "storage",
	"data_reclaim":                 "storage",
	"data_repair":                  "storage",
	"data_verify":                  "storage",

	// Added by the gate on 2026-08-15.
	"secret_status": "secret",

	// Added by the gate on 2026-08-15.
	"media_proxy_info": "sidecar",
	"service_status":   "sidecar",
	"sidecar_dev_new":  "sidecar",

	// Added by the gate on 2026-08-15.
	"schedule_set": "daemon",

	// Added by the gate on 2026-08-15.
	"binary_integrity":       "install",
	"host_unit_target":       "install",
	"npm_global_dirs":        "install",
	"plugin_dev_new":         "install",
	"plugin_dev_new2":        "install",
	"probe_binary":           "install",
	"theme_install":          "install",
	"unit_dev_validate_path": "install",
	"unit_install_begin":     "install",
	"unit_install_commit":    "install",
	"unit_install_read_utf8": "install",
	"unit_install_rollback":  "install",
	"unit_install_stage":     "install",

	// Added by the gate on 2026-08-15.
	"ai_session_active":  "ai",
	"ai_session_detect":  "ai",
	"ai_session_dir":     "ai",
	"ai_session_find":    "ai",
	"ai_session_inspect": "ai",
	"ai_session_lineage": "ai",

	// Added by the gate on 2026-08-15.
	"app_shutdown_prepare": "control",
	"ipc_cli_dir":          "control",
	"ipc_socket_path":      "control",
	"net_udp_request":      "control",
	"net_udp_send":         "control",
	"notify_show":          "control",
}

// TestEveryFrontendCallIsAccountedFor keeps the two halves of the application
// from drifting apart about which commands exist.
//
// One registry stops two implementations of one command from disagreeing about
// arguments. It says nothing about a command that is called and never
// registered — that gap is invisible until someone reaches the feature, and
// then it reads as a broken application rather than an unbuilt one.
func TestEveryFrontendCallIsAccountedFor(t *testing.T) {
	called := frontendCalls(t)
	if len(called) == 0 {
		// A scan that finds nothing reports no violations and enforces nothing.
		t.Fatal("no invoke calls were found; the scan root is wrong")
	}

	// The whole command surface, assembled the way the running process
	// assembles it. This gate lives beside the framework rather than beside the
	// core because this is the only package that can import both, and a gate
	// that reads a hand-written list of what the other half serves measures the
	// list instead of the build.
	registry := control.NewRegistry()
	boot.RegisterCore(registry, boot.Boot{})
	Register(registry, Deps{Host: startedHost(), NewID: counter("1")})

	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	// The residue: commands whose handlers close over the vendor's App and
	// Window directly, so there is no seam to hand a stub. Every name here is a
	// command this gate cannot prove — shrinking the list means giving those
	// handlers a host interface, the way the window group has one.
	for _, name := range []string{
		"window_set_background", "cmd_listener_ready", "webview_recovery_consume",
		"project_owners", "control_owner_answered",
	} {
		served[name] = true
	}

	var undeclared []string
	for _, name := range called {
		if served[name] {
			continue
		}
		if _, declared := unserved[name]; !declared {
			undeclared = append(undeclared, name)
		}
	}
	sort.Strings(undeclared)

	if len(undeclared) > 0 {
		t.Errorf("the frontend calls commands this backend neither serves nor declares unserved: %v\n"+
			"Serve them, or add them to `unserved` with the group they belong to.", undeclared)
	}

	// An entry that is now served must leave the list, or the list stops
	// describing the gap and starts hiding progress.
	var stale []string
	for name := range unserved {
		if served[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("these are served but still listed as unserved: %v", stale)
	}
}

func frontendCalls(t *testing.T) []string {
	t.Helper()
	root := filepath.Join("..", "..", "frontend", "src")

	seen := map[string]bool{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".ts") && !strings.HasSuffix(path, ".tsx") {
			return nil
		}
		// Tests name commands they mock, which says nothing about what the
		// running application calls.
		if strings.Contains(path, ".test.") {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, match := range invokeCall.FindAllStringSubmatch(string(source), -1) {
			seen[match[1]] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scanning the frontend: %v", err)
	}

	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
