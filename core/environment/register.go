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
	for _, kind := range []string{"plugin", "sidecar", "kit", "contract", "spec"} {
		registerSource(registry, deps, kind)
	}
}
func registerSource(registry *control.Registry, deps Deps, kind string) {
	registry.MustRegister(control.Command{Name: kind + "_source_set", Handler: func(args control.Args) (any, error) {
		id, err := control.Arg[string](args, "id")
		if err != nil {
			return nil, err
		}
		version, err := control.Arg[string](args, "version")
		if err != nil {
			return nil, err
		}
		path, err := control.Arg[string](args, "path")
		if err != nil {
			return nil, err
		}
		source, err := control.Arg[string](args, "source")
		if err != nil {
			return nil, err
		}
		registryID, err := control.OptionalArg[string](args, "registry", "")
		if err != nil {
			return nil, err
		}
		target, err := control.OptionalArg[string](args, "target", "")
		if err != nil {
			return nil, err
		}
		expected, err := control.Arg[uint64](args, "expectedRevision")
		if err != nil {
			return nil, err
		}
		if info, statErr := os.Lstat(path); statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, os.ErrInvalid
		}
		change, err := SetSource(deps.Home, kind, id, Component{Version: version, Path: path, Source: source, Registry: registryID, Target: target}, expected)
		return emit(deps, change, err)
	}})
}
func emit(deps Deps, change Change, err error) (any, error) {
	if err == nil && deps.Changed != nil {
		deps.Changed(ChangeEvent, change)
	}
	return change, err
}
