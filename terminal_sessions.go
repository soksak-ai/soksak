package main

import (
	"github.com/soksak/soksak-core/core/terminal"
	plugin "github.com/soksak/soksak-plugin-terminal-xterm"
)

// terminalSessions is the launcher's join between the command group and the
// owner of the file descriptors.
//
// The two Handle types are identical in shape and separate on purpose: the
// commands declare what they need from an owner, and the plugin declares what
// it is. Neither imports the other, so this conversion is the whole of the
// coupling and it lives where both are already named.
type terminalSessions struct{ service *plugin.Service }

func (sessions terminalSessions) Open(key string, cols, rows uint16) (terminal.Handle, error) {
	handle, err := sessions.service.Open(key, cols, rows)
	return terminal.Handle{ID: handle.ID, Generation: handle.Generation}, err
}

func (sessions terminalSessions) Write(handle terminal.Handle, data string) error {
	return sessions.service.Write(pluginHandle(handle), data)
}

func (sessions terminalSessions) Resize(handle terminal.Handle, cols, rows uint16) error {
	return sessions.service.Resize(pluginHandle(handle), cols, rows)
}

func (sessions terminalSessions) Close(handle terminal.Handle) error {
	return sessions.service.Close(pluginHandle(handle))
}

func pluginHandle(handle terminal.Handle) plugin.Handle {
	return plugin.Handle{ID: handle.ID, Generation: handle.Generation}
}
