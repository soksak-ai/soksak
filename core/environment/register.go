package environment

import (
	"github.com/soksak-ai/soksak-core/core/control"
	"os"
)

const ChangeEvent = "environment.changed"

type Deps struct {
	Home    string
	Changed func(string, any)
}

func Register(registry *control.Registry, deps Deps) {
	registry.MustRegister(control.Command{Name: "environment_get", Handler: func(control.Args) (any, error) {
		value, exists, err := Read(deps.Home)
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, os.ErrNotExist
		}
		return value, nil
	}})
	registry.MustRegister(control.Command{Name: "plugin_manifest_list", Handler: func(control.Args) (any, error) { return PluginManifests(deps.Home) }})
	registry.MustRegister(control.Command{Name: "plugin_enabled_set", Handler: func(args control.Args) (any, error) {
		refs, err := control.Arg[[]PluginRef](args, "plugins")
		if err != nil {
			return nil, err
		}
		enabled, err := control.Arg[bool](args, "enabled")
		if err != nil {
			return nil, err
		}
		expected, err := control.Arg[uint64](args, "expectedRevision")
		if err != nil {
			return nil, err
		}
		change, err := SetPluginsEnabled(deps.Home, refs, enabled, expected)
		return emit(deps, change, err)
	}})
}
func emit(deps Deps, change Change, err error) (any, error) {
	if err == nil && deps.Changed != nil {
		deps.Changed(ChangeEvent, change)
	}
	return change, err
}
