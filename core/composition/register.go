package composition

import (
	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

type Deps struct {
	Home    string
	Changed func(event string, payload any)
}

func Register(registry *control.Registry, deps Deps) {
	load := func() (Result, error) {
		if deps.Home == "" {
			return Result{}, i18n.Errorf("composition.home.required", nil)
		}
		return Load(deps.Home)
	}
	registry.MustRegister(control.Command{Name: "composition_settings", Handler: func(control.Args) (any, error) {
		result, err := load()
		if err != nil {
			return nil, err
		}
		return result.Settings, nil
	}})
	registry.MustRegister(control.Command{Name: "composition_graph", Handler: func(control.Args) (any, error) {
		result, err := load()
		if err != nil {
			return nil, err
		}
		return result.Graph, nil
	}})
	registry.MustRegister(control.Command{Name: "composition_status", Handler: func(control.Args) (any, error) {
		result, err := load()
		if err != nil {
			return nil, err
		}
		return summarize(result), nil
	}})
	registry.MustRegister(control.Command{Name: "plugin_manifest_list", Handler: func(control.Args) (any, error) {
		if deps.Home == "" {
			return nil, i18n.Errorf("composition.home.required", nil)
		}
		return PluginManifests(deps.Home)
	}})
	registry.MustRegister(control.Command{Name: "plugin_enabled_set", Handler: func(args control.Args) (any, error) {
		plugins, err := control.Arg[[]contract.PluginRef](args, "plugins")
		if err != nil {
			return nil, err
		}
		enabled, err := control.Arg[bool](args, "enabled")
		if err != nil {
			return nil, err
		}
		expected, err := control.Arg[uint64](args, "expectedGeneration")
		if err != nil {
			return nil, err
		}
		change, err := SetPluginsEnabled(deps.Home, plugins, enabled, expected)
		if err == nil && deps.Changed != nil {
			deps.Changed(contract.ChangeEvent, change)
		}
		return change, err
	}})
	registerDevelopmentCommands(registry, deps)
}
func registerDevelopmentCommands(registry *control.Registry, deps Deps) {
	emit := func(change contract.Change, err error) (any, error) {
		if err == nil && deps.Changed != nil {
			deps.Changed(contract.ChangeEvent, change)
		}
		return change, err
	}
	registry.MustRegister(control.Command{Name: "plugin_development_set", Handler: func(args control.Args) (any, error) {
		id, version, development, path, manifest, source, expected, err := developmentArgs(args)
		if err != nil {
			return nil, err
		}
		change, err := SetPluginDevelopment(deps.Home, contract.Plugin{PluginRef: contract.PluginRef{ID: id, Version: version}, Development: development, InstallPath: path, Manifest: manifest, Source: source}, expected)
		return emit(change, err)
	}})
	registry.MustRegister(control.Command{Name: "sidecar_development_set", Handler: func(args control.Args) (any, error) {
		id, version, development, path, manifest, source, expected, err := developmentArgs(args)
		if err != nil {
			return nil, err
		}
		change, err := SetSidecarDevelopment(deps.Home, contract.Sidecar{SidecarRef: contract.SidecarRef{ID: id, Version: version}, Development: development, InstallPath: path, Manifest: manifest, Source: source}, expected)
		return emit(change, err)
	}})
	registry.MustRegister(control.Command{Name: "kit_development_set", Handler: func(args control.Args) (any, error) {
		id, version, development, path, manifest, source, expected, err := developmentArgs(args)
		if err != nil {
			return nil, err
		}
		change, err := SetKitDevelopment(deps.Home, contract.Kit{KitRef: contract.KitRef{ID: id, Version: version}, Development: development, InstallPath: path, Manifest: manifest, Source: source}, expected)
		return emit(change, err)
	}})
}

func developmentArgs(args control.Args) (string, string, bool, string, string, contract.Source, uint64, error) {
	id, err := control.Arg[string](args, "id")
	if err != nil {
		return "", "", false, "", "", contract.Source{}, 0, err
	}
	version, err := control.Arg[string](args, "version")
	if err != nil {
		return "", "", false, "", "", contract.Source{}, 0, err
	}
	development, err := control.Arg[bool](args, "development")
	if err != nil {
		return "", "", false, "", "", contract.Source{}, 0, err
	}
	path, err := control.Arg[string](args, "path")
	if err != nil {
		return "", "", false, "", "", contract.Source{}, 0, err
	}
	manifest, err := control.Arg[string](args, "manifest")
	if err != nil {
		return "", "", false, "", "", contract.Source{}, 0, err
	}
	source, err := control.Arg[contract.Source](args, "source")
	if err != nil {
		return "", "", false, "", "", contract.Source{}, 0, err
	}
	expected, err := control.Arg[uint64](args, "expectedGeneration")
	return id, version, development, path, manifest, source, expected, err
}
