package wails

import (
	"encoding/json"

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

// Invoke runs one command. Arguments arrive as a JSON object because the
// registry is typed per command rather than at this boundary.
func (service *ControlService) Invoke(name string, args map[string]json.RawMessage) (any, error) {
	return service.registry.Invoke(name, control.Args(args))
}

// Commands answers with what this build serves and what it refuses, so a
// caller can tell "not written yet" from "impossible here" without guessing.
func (service *ControlService) Commands() control.Table {
	return service.registry.Describe()
}
