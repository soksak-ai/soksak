package terminal

// CommandNames is every command this group owns, served or not.
//
// A process with no session owner registers none of them, and the difference
// between "this build has no terminals" and "this build forgot a command" is
// only visible if the names are still declared. So the composition root needs
// them without constructing the group.
//
// TestTheNameListMatchesWhatRegisterTouches holds this equal to what Register
// actually does with an owner present.
func CommandNames() []string {
	return []string{
		"ack_terminal",
		"close_terminal",
		"pty_daemon_restart",
		"pty_daemon_status",
		"pty_daemon_upgrade",
		"pty_pane_alive",
		"pty_pane_pid",
		"pty_read_sealed_screen",
		"pty_sidecar_request",
		"resize_terminal",
		"spawn_terminal",
		"write_terminal",
	}
}
