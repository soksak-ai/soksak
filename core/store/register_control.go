package store

import "github.com/soksak/soksak-core/core/control"

// Register wires the storage group into the registry.
//
// It lives here, beside the rules it registers. There was a claim that it could
// not: that `core/control` imports this package and the import would therefore
// cycle. `core/control` imports nothing of this repository — `go list -deps
// ./core/control` names only itself. What holds a `*store.KV` is `core/boot`,
// the composition root, which imports both by design and is imported by
// neither. Checked on 2026-08-15, and the check is one command.
func Register(registry *control.Registry, deps Deps) {
	for _, command := range Commands(deps) {
		registry.MustRegister(control.Command{
			Name:  command.Name,
			Owner: control.Owner(command.Owner),
			// The handler is carried across rather than rewritten: this
			// translates a type and decides nothing.
			Handler: func(args control.Args) (any, error) { return command.Handler(args) },
		})
	}
}
