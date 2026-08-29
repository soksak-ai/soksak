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

func announceWindowReady(writer io.Writer, resolved identity.Resolved, pid int, window string) error {
	return json.NewEncoder(writer).Encode(struct {
		controlReadyEvent
		Window string `json:"window"`
	}{
		controlReadyEvent: controlReadyEvent{
			Event: "soksak.window.ready", Protocol: 1,
			Socket: resolved.Socket, Identifier: resolved.Identifier, PID: pid,
		},
		Window: window,
	})
}

func announceRendererReady(writer io.Writer, resolved identity.Resolved, pid int, window string) error {
	return json.NewEncoder(writer).Encode(struct {
		controlReadyEvent
		Window string `json:"window"`
	}{
		controlReadyEvent: controlReadyEvent{
			Event: "soksak.renderer.ready", Protocol: 1,
			Socket: resolved.Socket, Identifier: resolved.Identifier, PID: pid,
		},
		Window: window,
	})
}
