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
	"github.com/soksak/soksak-core/core/files"
	"github.com/soksak/soksak-core/core/identity"
	"github.com/soksak/soksak-core/core/process"
	"github.com/soksak/soksak-core/core/store"
	"github.com/soksak/soksak-core/core/terminal"
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

	// Files and watching.

	// Terminal and PTY.
	"ack_terminal":           "terminal",
	"pty_read_sealed_screen": "terminal",
	"pty_sidecar_request":    "terminal",
	"pty_daemon_status":      "terminal",
	"pty_daemon_restart":     "terminal",
	"pty_daemon_upgrade":     "terminal",

	// Child processes.
	"cleanup_stale": "process",

	// Windows.
	"titlebar_backing": "window",

	// Native surfaces.
	"webview_close":   "surface",
	"webview_recover": "surface",
	"webview_visible": "surface",

	// Storage beyond the key-value pairs boot needs.
	"data_encrypt_status":  "storage",
	"data_encrypt_rotate":  "storage",
	"data_encrypt_recover": "storage",

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
	"ai_session_untrack":     "misc",
	"app_relaunch":           "misc",
	"app_shutdown_commit":    "misc",
	"clipboard_read":         "misc",
	"clipboard_write":        "misc",
	"clipboard_watch_start":  "misc",
	"clipboard_watch_stop":   "misc",
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
	"ipc_last_project_window": "project",

	// Added by the gate on 2026-08-15.

	// Added by the gate on 2026-08-15.
	"pty_pane_pid": "terminal",

	// Added by the gate on 2026-08-15.
	"webview_health_query": "window",
	"webview_list":         "window",

	// Added by the gate on 2026-08-15.
	"data_canary":                  "storage",
	"data_encrypt_change_recovery": "storage",
	"data_encrypt_convert":         "storage",
	"data_encrypt_enable":          "storage",
	"data_kv_history":              "storage",
	"data_kv_undo":                 "storage",

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
	// A store is opened because several groups refuse by name without one, and
	// a refusal is not registration — the gate would then read a served command
	// as missing.
	home := t.TempDir()
	kv, err := store.OpenKV(filepath.Join(home, "soksak.db"))
	if err != nil {
		t.Fatalf("opening the store: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })

	boot.RegisterCore(registry, boot.Boot{
		Identity: identity.Resolve("com.soksak.dev", identity.Environment{Home: home}),
		KV:       kv,
		UserHome: t.TempDir(),
		Now:      func() int64 { return 0 },
		PidAlive: func(int) bool { return false },
		Run:      files.SystemRunner{},
		Spawner:  process.OSSpawner{},
		// A spawner with nowhere to deliver is refused, so the gate supplies a
		// consumer that reads and drops. It measures which commands register,
		// never what they emit.
		ProcessSink: discardProcessOutput{},
		Sessions:    idleSessions{},
	})
	Register(registry, Deps{Host: startedHost(), NewID: counter("1")})
	// The surface group reads a composition rather than holding one, so the
	// gate hands it one that was never committed. Which names register depends
	// on the dependencies being present, never on what they answer.
	RegisterSurface(registry, SurfaceDeps{
		Composition:  stubComposition{},
		NativeParent: func() bool { return false },
	})
	// The renderer command bridge registers the one name a page answers with.
	// A gate that assembled everything but this would read cmd_result as
	// missing while the running process serves it.
	RegisterRendererCommands(registry, func(string, string, any) error { return nil })

	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	// What this cannot see: whether the launcher actually supplies each of those
	// dependencies. It proves the groups register what they claim; main.go
	// handing them a real store, spawner and session owner is a separate fact,
	// and the only witness to it is starting the process.
	//
	// The residue: commands whose handlers close over the vendor's App and
	// Window directly, so there is no seam to hand a stub. Every name here is a
	// command this gate cannot prove — shrinking the list means giving those
	// handlers a host interface, the way the window group has one.
	for _, name := range []string{
		"window_set_background", "cmd_listener_ready", "webview_recovery_consume",
		"control_owner_answered",
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

// discardProcessOutput is a consumer that is always there and never looks. It
// exists so this gate can register the spawning commands; nothing here asserts
// on delivery.
type discardProcessOutput struct{}

func (discardProcessOutput) EmitProcessOutput(process.Output) process.Delivery {
	return process.Delivered
}
func (discardProcessOutput) EmitProcessExit(process.Exit) process.Delivery {
	return process.Delivered
}

// idleSessions is an owner that exists and holds nothing. Which names register
// depends on an owner being present, never on what it can do.
type idleSessions struct{}

func (idleSessions) Open(string, uint16, uint16) (terminal.Handle, error) {
	return terminal.Handle{}, nil
}
func (idleSessions) Write(terminal.Handle, string) error          { return nil }
func (idleSessions) Resize(terminal.Handle, uint16, uint16) error { return nil }
func (idleSessions) Close(terminal.Handle) error                  { return nil }
