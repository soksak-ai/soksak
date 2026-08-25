package environment

import (
	"github.com/soksak-ai/soksak-core/core/control"
	"os"
)

const ChangeEvent = "environment.changed"

type Deps struct {
	Home string
	// OS and Arch name the host in Go's spelling ("darwin"/"arm64"). sidecar_develop
	// derives the record's target from them. Either one empty refuses that command.
	OS      string
	Arch    string
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
	registry.MustRegister(control.Command{Name: "plugin_develop", Handler: func(args control.Args) (any, error) {
		id, path, expected, err := developArgs(args)
		if err != nil {
			return nil, err
		}
		change, err := SetPluginDevelopment(deps.Home, id, path, expected)
		return emit(deps, change, err)
	}})
	registry.MustRegister(control.Command{Name: "plugin_remove", Handler: func(args control.Args) (any, error) {
		id, expected, err := removeArgs(args)
		if err != nil {
			return nil, err
		}
		result, err := RemovePlugin(deps.Home, id, expected)
		if _, err := emit(deps, result.Change, err); err != nil {
			return nil, err
		}
		return result, nil
	}})
	registry.MustRegister(control.Command{Name: "sidecar_develop", Handler: func(args control.Args) (any, error) {
		id, path, expected, err := developArgs(args)
		if err != nil {
			return nil, err
		}
		target, err := HostArtifactTarget(deps.OS, deps.Arch)
		if err != nil {
			return nil, err
		}
		change, err := SetSidecarDevelopment(deps.Home, id, path, target, expected)
		return emit(deps, change, err)
	}})
	registry.MustRegister(control.Command{Name: "sidecar_remove", Handler: func(args control.Args) (any, error) {
		id, expected, err := removeArgs(args)
		if err != nil {
			return nil, err
		}
		result, err := RemoveSidecar(deps.Home, id, expected)
		if _, err := emit(deps, result.Change, err); err != nil {
			return nil, err
		}
		return result, nil
	}})
}
func developArgs(args control.Args) (string, string, uint64, error) {
	id, err := control.Arg[string](args, "id")
	if err != nil {
		return "", "", 0, err
	}
	path, err := control.Arg[string](args, "path")
	if err != nil {
		return "", "", 0, err
	}
	expected, err := control.Arg[uint64](args, "expectedRevision")
	if err != nil {
		return "", "", 0, err
	}
	return id, path, expected, nil
}
func removeArgs(args control.Args) (string, uint64, error) {
	id, err := control.Arg[string](args, "id")
	if err != nil {
		return "", 0, err
	}
	expected, err := control.Arg[uint64](args, "expectedRevision")
	if err != nil {
		return "", 0, err
	}
	return id, expected, nil
}

// emit publishes environment.changed for every published revision.
func emit(deps Deps, change Change, err error) (any, error) {
	if change.Revision != 0 && deps.Changed != nil {
		deps.Changed(ChangeEvent, change)
	}
	return change, err
}
