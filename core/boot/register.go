// Package boot is the backend's composition root: the one place that names every
// feature package and joins them to the registry.
//
// It exists so control stays a registry and nothing else. A registry that
// imports the features it holds cannot be imported by them, and every feature
// needs it — that cycle is what this package breaks. The frontend's src/boot
// plays the same part on the other side.
package boot

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/soksak/soksak-core/core/activity"
	"github.com/soksak/soksak-core/core/app"
	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/identity"
	corenet "github.com/soksak/soksak-core/core/net"
	"github.com/soksak/soksak-core/core/scan"
	"github.com/soksak/soksak-core/core/service"
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

// RegisterCore registers the host-independent commands the frontend asks for
// during boot. Each is answerable with no window, which is what makes headless
// possible at all.
func RegisterCore(registry *control.Registry, boot Boot) {
	registry.MustRegister(control.Command{
		Name:    "app_environment",
		Handler: func(control.Args) (any, error) { return app.Describe(boot.Identity, boot.BuildProfile), nil },
	})

	registry.MustRegister(control.Command{
		Name:    "app_is_release",
		Handler: func(control.Args) (any, error) { return boot.Identity.Release, nil },
	})

	registry.MustRegister(control.Command{
		Name: "data_kv_get",
		Handler: func(args control.Args) (any, error) {
			ns, err := control.Arg[string](args, "ns")
			if err != nil {
				return nil, err
			}
			key, err := control.Arg[string](args, "key")
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

	registry.MustRegister(control.Command{
		Name: "data_kv_set",
		Handler: func(args control.Args) (any, error) {
			ns, err := control.Arg[string](args, "ns")
			if err != nil {
				return nil, err
			}
			key, err := control.Arg[string](args, "key")
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

	registry.MustRegister(control.Command{
		Name: "activity_publish",
		Handler: func(args control.Args) (any, error) {
			kind, err := control.Arg[string](args, "kind")
			if err != nil {
				return nil, err
			}
			source, err := control.Arg[string](args, "source")
			if err != nil {
				return nil, err
			}
			// The stamped entry is returned so the caller can fan it out. The
			// halves that need a window are not this command's to perform.
			return boot.Ledger.Admit(uint64(boot.Now()), kind, source, args["payload"]), nil
		},
	})

	registry.MustRegister(control.Command{
		Name: "unit_dev_list",
		Handler: func(control.Args) (any, error) {
			// Development units are declared under the home. A fresh home has
			// none, which is an empty list rather than a failure.
			return scan.Directory(filepath.Join(boot.Identity.Home, "units"), ".json")
		},
	})

	registry.MustRegister(control.Command{
		Name: "service_ledger_sync",
		Handler: func(args control.Args) (any, error) {
			ledger, present := args["ledger"]
			if !present {
				return nil, fmt.Errorf("missing argument %q", "ledger")
			}
			// Identical content is left alone, so the file's mtime only moves
			// when the bindings actually changed.
			_, err := service.WriteLedger(filepath.Join(boot.Identity.Home, "services", "ledger.json"), ledger)
			return nil, err
		},
	})

	registry.MustRegister(control.Command{
		Name: "net_http_request",
		Handler: func(args control.Args) (any, error) {
			var request corenet.Request
			encoded, err := json.Marshal(map[string]json.RawMessage(args))
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(encoded, &request); err != nil {
				return nil, fmt.Errorf("net_http_request: %w", err)
			}
			return corenet.Do(context.Background(), request)
		},
	})

	registry.MustRegister(control.Command{
		Name: "themes_scan",
		Handler: func(control.Args) (any, error) {
			return scan.Directory(filepath.Join(boot.Identity.Home, "themes"), ".json")
		},
	})

	registry.MustRegister(control.Command{
		Name: "plugin_scan",
		Handler: func(control.Args) (any, error) {
			return scan.Directory(filepath.Join(boot.Identity.Home, "plugins"), ".json")
		},
	})
}
