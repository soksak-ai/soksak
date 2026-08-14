package control

import (
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/soksak/soksak-core/core/activity"
	"github.com/soksak/soksak-core/core/app"
	"github.com/soksak/soksak-core/core/identity"
	"github.com/soksak/soksak-core/core/scan"
	"github.com/soksak/soksak-core/core/store"
)

// Boot is the state a process holds rather than receives per call.
//
// Callers send arguments; identity, home, and the database path are what this
// process is. Taking them per call would let one caller point the process at
// another installation.
type Boot struct {
	Identity     identity.Resolved
	BuildProfile string
	KV           *store.KV
	// Ledger stamps activity entries. Admission happens here even with no
	// window, because a record with a hole where the headless work happened is
	// worse than no record.
	Ledger *activity.Ledger
	// Now supplies timestamps. Passed in so the ledger stays testable and the
	// core keeps reading nothing ambient.
	Now func() int64
}

func arg[T any](args Args, name string) (T, error) {
	var value T
	raw, present := args[name]
	if !present {
		return value, fmt.Errorf("missing argument %q", name)
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, fmt.Errorf("argument %q: %w", name, err)
	}
	return value, nil
}

// RegisterCore registers the host-independent commands the frontend asks for
// during boot. Each is answerable with no window, which is what makes headless
// possible at all.
func RegisterCore(registry *Registry, boot Boot) {
	registry.MustRegister(Command{
		Name:    "app_environment",
		Handler: func(Args) (any, error) { return app.Describe(boot.Identity, boot.BuildProfile), nil },
	})

	registry.MustRegister(Command{
		Name:    "app_is_release",
		Handler: func(Args) (any, error) { return boot.Identity.Release, nil },
	})

	registry.MustRegister(Command{
		Name: "data_kv_get",
		Handler: func(args Args) (any, error) {
			ns, err := arg[string](args, "ns")
			if err != nil {
				return nil, err
			}
			key, err := arg[string](args, "key")
			if err != nil {
				return nil, err
			}
			value, found, err := boot.KV.Get(ns, key)
			if err != nil {
				return nil, err
			}
			if !found {
				// Absence is null, not an error: the first read of every
				// setting would otherwise fail.
				return nil, nil
			}
			// Values are stored as JSON text, so they return as they were
			// written rather than through a second encoding.
			var decoded any
			if err := json.Unmarshal([]byte(value), &decoded); err != nil {
				return value, nil
			}
			return decoded, nil
		},
	})

	registry.MustRegister(Command{
		Name: "data_kv_set",
		Handler: func(args Args) (any, error) {
			ns, err := arg[string](args, "ns")
			if err != nil {
				return nil, err
			}
			key, err := arg[string](args, "key")
			if err != nil {
				return nil, err
			}
			raw, present := args["value"]
			if !present {
				return nil, fmt.Errorf("missing argument %q", "value")
			}
			return nil, boot.KV.Set(ns, key, string(raw))
		},
	})

	registry.MustRegister(Command{
		Name: "activity_publish",
		Handler: func(args Args) (any, error) {
			kind, err := arg[string](args, "kind")
			if err != nil {
				return nil, err
			}
			source, err := arg[string](args, "source")
			if err != nil {
				return nil, err
			}
			// The stamped entry is returned so the caller can fan it out. The
			// halves that need a window are not this command's to perform.
			return boot.Ledger.Admit(uint64(boot.Now()), kind, source, args["payload"]), nil
		},
	})

	registry.MustRegister(Command{
		Name: "unit_dev_list",
		Handler: func(Args) (any, error) {
			// Development units are declared under the home. A fresh home has
			// none, which is an empty list rather than a failure.
			return scan.Directory(filepath.Join(boot.Identity.Home, "units"), ".json")
		},
	})

	registry.MustRegister(Command{
		Name: "themes_scan",
		Handler: func(Args) (any, error) {
			return scan.Directory(filepath.Join(boot.Identity.Home, "themes"), ".json")
		},
	})

	registry.MustRegister(Command{
		Name: "plugin_scan",
		Handler: func(Args) (any, error) {
			return scan.Directory(filepath.Join(boot.Identity.Home, "plugins"), ".json")
		},
	})
}
