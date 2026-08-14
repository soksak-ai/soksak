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

// Invoke runs one command.
//
// Arguments arrive as ordinary values and are re-encoded here, once. The
// registry is typed per command rather than at this boundary, so each handler
// decodes what it needs; encoding on the frontend side instead would double-
// encode every string (measured 2026-08-15: "core" arrived as "\"core\"").
func (service *ControlService) Invoke(name string, args map[string]any) (any, error) {
	encoded := make(control.Args, len(args))
	for key, value := range args {
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("argument %q could not be encoded: %w", key, err)
		}
		encoded[key] = raw
	}
	return service.registry.Invoke(name, encoded)
}

// Commands answers with what this build serves and what it refuses, so a
// caller can tell "not written yet" from "impossible here" without guessing.
func (service *ControlService) Commands() control.Table {
	return service.registry.Describe()
}
