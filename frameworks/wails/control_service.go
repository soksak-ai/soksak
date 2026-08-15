package wails

import (
	"encoding/json"
	"fmt"

	"github.com/soksak/soksak-core/core/control"
)

// ControlService is the frontend's door to the command registry.
//
// It is a transport, not a second registry: every name resolves through the
// same table a socket or an agent would reach, so no caller can take a path
// that answers differently.
type ControlService struct{ registry *control.Registry }

func NewControlService(registry *control.Registry) *ControlService {
	return &ControlService{registry: registry}
}

func (service *ControlService) ServiceName() string { return "soksak-control" }

// Reply is one command's answer, encoded.
//
// A string rather than a value because a bare `any` does not survive this
// transport intact. Measured 2026-08-15: data_kv_get for a key that does not
// exist answered null over the socket and {} here, and the frontend took the {}
// for the stored value — three boots died on `slots.filter`, `projects.length`
// and `t.map`, all of them that one difference.
//
// One registry, several transports is only true if the transports agree about
// what a command said. This is where that is made true rather than hoped for.
type Reply struct {
	Result string `json:"result"`
}

// Invoke runs one command.
//
// Arguments arrive as ordinary values and are re-encoded here, once. The
// registry is typed per command rather than at this boundary, so each handler
// decodes what it needs; encoding on the frontend side instead would double-
// encode every string (measured 2026-08-15: "core" arrived as "\"core\"").
func (service *ControlService) Invoke(name string, args map[string]any) (Reply, error) {
	encoded := make(control.Args, len(args))
	for key, value := range args {
		raw, err := json.Marshal(value)
		if err != nil {
			return Reply{}, fmt.Errorf("argument %q could not be encoded: %w", key, err)
		}
		encoded[key] = raw
	}
	result, err := service.registry.Invoke(name, encoded)
	if err != nil {
		return Reply{}, err
	}
	answer, err := json.Marshal(result)
	if err != nil {
		return Reply{}, fmt.Errorf("command %s answered something that cannot be encoded: %w", name, err)
	}
	return Reply{Result: string(answer)}, nil
}

// Commands answers with what this build serves and what it refuses, so a
// caller can tell "not written yet" from "impossible here" without guessing.
func (service *ControlService) Commands() control.Table {
	return service.registry.Describe()
}
