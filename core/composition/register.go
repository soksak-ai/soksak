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
	registry.MustRegister(control.Command{Name: "composition_development_set", Handler: func(args control.Args) (any, error) {
		kind, err := control.Arg[string](args, "kind")
		if err != nil {
			return nil, err
		}
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
		enabled, err := control.OptionalArg[bool](args, "enabled", true)
		if err != nil {
			return nil, err
		}
		expected, err := control.Arg[uint64](args, "expectedGeneration")
		if err != nil {
			return nil, err
		}
		change, err := SetDevelopment(deps.Home, contract.UnitRef{Kind: contract.UnitKind(kind), ID: id, Version: version}, path, enabled, expected)
		if err == nil && deps.Changed != nil {
			deps.Changed(contract.ChangeEvent, change)
		}
		return change, err
	}})
}
