package composition

import (
	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/i18n"
)

type Deps struct{ Home string }

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
}
