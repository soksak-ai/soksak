package boot

import "github.com/soksak/soksak-core/core/control"

// The commands the frontend calls that this build does not answer yet.
//
// They are declared rather than left out. A caller that receives "unknown
// command" cannot tell a feature that is not built from a name it typed wrong,
// so it investigates settled ground or writes its own imitation of the command.
// A declared refusal states the reason, and `state.commands` reports it beside
// what is served.
//
// Each entry names what is missing, not which release will bring it: a date is
// a promise this file cannot keep, and the reason is what a reader needs to
// decide whether to wait or to work around it.
//
// Removing an entry is progress and needs no ceremony. Adding one is a
// decision — the frontend now calls something this backend does not answer, and
// that must be chosen rather than discovered by a user.
var unbuilt = map[string]string{
	// Child processes.
	"cleanup_stale": "this build reaps its children on exit and keeps no stale-process ledger to clean",

	// Storage beyond the key-value pairs and documents the boot path needs.
	"data_canary":                  "this store keeps no canary row",
	"data_kv_history":              "this store keeps no revision history for a key",
	"data_kv_undo":                 "this store keeps no revision history to undo",
	"data_encrypt_enable":          "this store holds no encrypted namespace",
	"data_encrypt_status":          "this store holds no encrypted namespace to report on",
	"data_encrypt_convert":         "this store holds no encrypted namespace to convert into",
	"data_encrypt_rotate":          "this store holds no encrypted namespace whose key could rotate",
	"data_encrypt_recover":         "this store holds no encrypted namespace to recover",
	"data_encrypt_change_recovery": "this store holds no encrypted namespace whose recovery could change",

	// Secrets. The vault reads and injects; it does not take a value from a
	// caller in this build.
	"secret_set": "this build's vault has no writer, so a secret cannot be set through it",

	// Sidecars and services. A sidecar is a plugin in its own process, and this
	// build starts none.
	"sidecar_open":     "this build starts no sidecar processes",
	"sidecar_send":     "this build starts no sidecar processes to send to",
	"sidecar_close":    "this build starts no sidecar processes to close",
	"service_dispatch": "this build hosts no service sidecars to dispatch to",
	"service_status":   "this build hosts no service sidecars to report on",
	"service_bus_push": "this build carries no service event bus",

	// Daemons a workspace declares.
	"daemon_start":    "this build was given no spawner that can own a long-running child",
	"daemon_reap":     "this build was given no reaper that can ask what a live pid is running",
	"daemon_run_once": "this build was given no spawner that can run a declared command once",

	// Installation and units.
	"plugin_scaffold":        "this build scaffolds no plugin sources",
	"unit_install_begin":     "this build installs no units",
	"unit_install_stage":     "this build installs no units",
	"unit_install_commit":    "this build installs no units",
	"unit_install_rollback":  "this build installs no units",
	"unit_install_read_utf8": "this build installs no units, so there is no staged file to read",
	"unit_source_remove":     "this build keeps no development unit registry",
	"verify_and_link":        "this build verifies and links no downloaded artefacts",
	"download_verify":        "this build downloads no artefacts to verify",
	"update_check":           "this build has no updater",
	"update_apply":           "this build has no updater",

	// The control plane's own facts that need a running listener to answer.
	"ipc_hello_info": "the control plane answers system.hello on its own transport, not as a command",

	// Application lifecycle.
	"app_relaunch": "this build cannot relaunch itself; the launcher owns the process",

	// Desktop integrations the host has not been given.
	"clipboard_read":        "this host was given no clipboard bridge",
	"clipboard_write":       "this host was given no clipboard bridge",
	"clipboard_watch_start": "this host was given no clipboard bridge to watch",
	"clipboard_watch_stop":  "this host was given no clipboard bridge to watch",
	"notify_show":           "this host was given no notification bridge",
	"notify_activate":       "this host was given no notification bridge, so no notification can be activated",

	// Network reach beyond the control plane.
	"net_udp_send":    "this build opens no UDP socket",
	"net_udp_request": "this build opens no UDP socket",
	"ws_connect":      "this build has no websocket client",
	"ws_send":         "this build has no websocket client",
	"ws_close":        "this build has no websocket client",

	// Remote confirmation and agent bookkeeping.
	"remote_confirm_resolve": "this build takes no remote destructive confirmations",
	"skill_refresh_spawn":    "this build refreshes no agent skill index",
}

// declareUnbuilt records every name above, with its reason.
//
// A group that grows a real handler for one of these must delete its entry: the
// registry refuses to hold a name as both served and unserved, and the coverage
// gate reports the contradiction by name.
func declareUnbuilt(registry *control.Registry) {
	for name, because := range unbuilt {
		if err := registry.DeclareUnserved(name, because); err != nil {
			panic(err)
		}
	}
}
