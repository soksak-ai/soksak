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

func announceControlReady(writer io.Writer, resolved identity.Resolved, pid int) error {
	return json.NewEncoder(writer).Encode(controlReadyEvent{
		Event: "soksak.control.ready", Protocol: 1,
		Socket: resolved.Socket, Identifier: resolved.Identifier, PID: pid,
	})
}
