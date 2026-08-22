package settings

import (
	"github.com/soksak-ai/soksak-core/core/control"
	"os"
)

const ChangeEvent = "settings.changed"

type Deps struct {
	Home    string
	Changed func(string, any)
}

func Register(registry *control.Registry, deps Deps) {
	registry.MustRegister(control.Command{Name: "settings_get", Handler: func(control.Args) (any, error) {
		value, exists, err := Read(deps.Home)
		if err != nil {
			return nil, err
		}
		if !exists {
			value = Empty()
		}
		return value, nil
	}})
	registry.MustRegister(control.Command{Name: "installed_get", Handler: func(control.Args) (any, error) {
		value, exists, err := ReadInstalled(deps.Home)
		if err != nil {
			return nil, err
		}
		if !exists {
			value = EmptyInstalled()
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
		registerDevelopment(registry, deps, kind)
	}
	registry.MustRegister(control.Command{Name: "plugin_provider_set", Handler: func(args control.Args) (any, error) {
		plugin, err := control.Arg[string](args, "plugin")
		if err != nil {
			return nil, err
		}
		requirement, err := control.Arg[string](args, "requirement")
		if err != nil {
			return nil, err
		}
		sidecar, err := control.Arg[string](args, "sidecar")
		if err != nil {
			return nil, err
		}
		expected, err := control.Arg[uint64](args, "expectedRevision")
		if err != nil {
			return nil, err
		}
		change, err := SetProvider(deps.Home, plugin, requirement, sidecar, expected)
		return emit(deps, change, err)
	}})
}
func registerDevelopment(registry *control.Registry, deps Deps, kind string) {
	registry.MustRegister(control.Command{Name: kind + "_development_set", Handler: func(args control.Args) (any, error) {
		id, err := control.Arg[string](args, "id")
		if err != nil {
			return nil, err
		}
		enabled, err := control.Arg[bool](args, "development")
		if err != nil {
			return nil, err
		}
		path, err := control.Arg[string](args, "path")
		if err != nil {
			return nil, err
		}
		expected, err := control.Arg[uint64](args, "expectedRevision")
		if err != nil {
			return nil, err
		}
		if enabled {
			if info, statErr := os.Lstat(path); statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return nil, os.ErrInvalid
			}
		}
		change, err := SetDevelopment(deps.Home, kind, id, path, enabled, expected)
		return emit(deps, change, err)
	}})
}
func emit(deps Deps, change Change, err error) (any, error) {
	if err == nil && deps.Changed != nil {
		deps.Changed(ChangeEvent, change)
	}
	return change, err
}
