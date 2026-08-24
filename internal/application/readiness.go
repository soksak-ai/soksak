package application

import (
	"encoding/json"
	"io"

	"github.com/soksak-ai/soksak-core/core/identity"
)

type controlReadyEvent struct {
	Event      string `json:"event"`
	Protocol   int    `json:"protocol"`
	Socket     string `json:"socket"`
	Identifier string `json:"identifier"`
	PID        int    `json:"pid"`
}

func announceReady(writer io.Writer, event string, resolved identity.Resolved, pid int) error {
	return json.NewEncoder(writer).Encode(controlReadyEvent{
		Event: event, Protocol: 1,
		Socket: resolved.Socket, Identifier: resolved.Identifier, PID: pid,
	})
}

func announceControlReady(writer io.Writer, resolved identity.Resolved, pid int) error {
	return announceReady(writer, "soksak.control.ready", resolved, pid)
}

func announceHostReady(writer io.Writer, resolved identity.Resolved, pid int) error {
	return announceReady(writer, "soksak.host.ready", resolved, pid)
}
