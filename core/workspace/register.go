package workspace

import (
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

// Deps is what the process supplies. Every one of these is injected because
// reading it here would make the same command answer differently depending on
// which process asked.
type Deps struct {
	// Home is the identity home (~/.soksak-wails). Workspace folders the app
	// creates live under it.
	Home string
	// UserHome is the OS user home (~). It is a different value from Home, and
	// only the root verdict needs it: judging against the identity home instead
	// would admit ~ as a workspace root and put workspace roots inside the
	// app-managed area.
	UserHome string
	// Manifest is where the restore ledger is stored.
	Manifest ManifestStore
	// Claims is this process's workspace-claim ledger. The launcher holds it, the
	// way the key-value store and the activity ledger already are: the host
	// needs the same ledger to free a window's roots when the window is
	// destroyed, and to answer who owns what.
	Claims *Ledger
	// Changed delivers a mutation to the other windows. The core determines when
	// a change happened; the host determines how it travels, because
	// broadcasting needs a window.
	Changed func(event string, payload any)
}

// Register adds this group's commands.
//
// Missing wiring panics naming the field, the same way MustRegister does: it is
// a programming fact, and finding it when a user opens a workspace is worse than
// finding it at startup.
func Register(registry *control.Registry, deps Deps) {
	// Both homes are required absolute here rather than per call. A relative
	// one is resolved against the working directory, so the same command lands
	// in a different tree in the app and in a headless process — an answer,
	// not an error. Boot is where a caller can still be told which value is
	// wrong; by the time a user opens a workspace, nothing names the field.
	if deps.Home == "" {
		panic("workspace: Deps.Home is empty; app-made workspace folders would land beside the working directory")
	}
	if !filepath.IsAbs(deps.Home) {
		panic("workspace: Deps.Home is relative (" + deps.Home + "); app-made workspace folders would land beside the working directory")
	}
	if deps.UserHome == "" {
		panic("workspace: Deps.UserHome is empty; the root verdict cannot tell a workspace root from the home")
	}
	if !filepath.IsAbs(deps.UserHome) {
		panic("workspace: Deps.UserHome is relative (" + deps.UserHome + "); it would never equal a canonical root, so the home would pass the verdict")
	}
	if deps.Manifest == nil {
		panic("workspace: Deps.Manifest is nil; window restore slots have nowhere to merge into")
	}
	if deps.Claims == nil {
		panic("workspace: Deps.Claims is nil; the single-open rule has no ledger to enforce with")
	}
	if deps.Changed == nil {
		// A dropped notification is not an error — it is a picker that never
		// updates, and nothing about that identifies which part is missing.
		panic("workspace: Deps.Changed is nil; claim mutations would reach no window")
	}

	manifest := NewManifestLedger(deps.Manifest)

	registry.MustRegister(control.Command{
		Name:  "validate_workspace_root",
		Owner: control.OwnerCore,
		Handler: func(callArgs control.Args) (any, error) {
			path, err := argument[string](callArgs, "path")
			if err != nil {
				return nil, err
			}
			return ValidateRoot(path, deps.UserHome)
		},
	})

	registry.MustRegister(control.Command{
		Name:  "ensure_workspace_dir",
		Owner: control.OwnerCore,
		Handler: func(callArgs control.Args) (any, error) {
			folder, err := argument[string](callArgs, "folder")
			if err != nil {
				return nil, err
			}
			return EnsureDir(folder, deps.Home)
		},
	})

	registry.MustRegister(control.Command{
		Name:  "workspace_claim",
		Owner: control.OwnerCore,
		Handler: func(callArgs control.Args) (any, error) {
			root, err := argument[string](callArgs, "root")
			if err != nil {
				return nil, err
			}
			// Stamped by the transport, never sent by the caller: a
			// caller-supplied label is forgeable, and a forged one releases
			// another window's claim.
			window, err := argument[string](callArgs, "window")
			if err != nil {
				return nil, err
			}
			reply, changed, err := deps.Claims.Claim(root, window)
			if err != nil {
				return nil, err
			}
			if changed {
				deps.Changed(ChangeEvent, nil)
			}
			return reply, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "workspace_release",
		Owner: control.OwnerCore,
		Handler: func(callArgs control.Args) (any, error) {
			root, err := argument[string](callArgs, "root")
			if err != nil {
				return nil, err
			}
			window, err := argument[string](callArgs, "window")
			if err != nil {
				return nil, err
			}
			released, err := deps.Claims.Release(root, window)
			if err != nil {
				return nil, err
			}
			if released {
				deps.Changed(ChangeEvent, nil)
			}
			return ReleaseReply{Released: released}, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "workspace_owners",
		Owner: control.OwnerCore,
		Handler: func(control.Args) (any, error) {
			// Under a key rather than as a bare list. The caller reads `.owners`
			// before opening a root, so that it can focus the window already
			// holding it instead of creating a second one — and a bare array
			// left that undefined, which took the whole boot down on
			// `t.map is not a function` (measured 2026-08-15).
			//
			// A list, never null: "nobody holds anything" and "this build cannot
			// tell you" must not arrive as the same answer.
			return OwnersReply{Owners: deps.Claims.Owners()}, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "window_manifest_upsert",
		Owner: control.OwnerCore,
		Handler: func(callArgs control.Args) (any, error) {
			entry, err := argument[map[string]any](callArgs, "entry")
			if err != nil {
				return nil, err
			}
			// A save that does not claim focus simply omits it. Absence here is
			// "not focused", not a missing argument.
			focused := false
			if raw, present := callArgs["focused"]; present {
				if err := json.Unmarshal(raw, &focused); err != nil {
					return nil, fmt.Errorf("argument %q: %w", "focused", err)
				}
			}
			return manifest.Upsert(entry, focused)
		},
	})
}

// argument decodes one named parameter. The registry is typed per command
// rather than at that boundary, so each handler names what it needs.
func argument[T any](callArgs control.Args, name string) (T, error) {
	var value T
	raw, present := callArgs[name]
	if !present {
		return value, i18n.Errorf("workspace.argument.missing", map[string]string{"name": name})
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, fmt.Errorf("argument %q: %w", name, err)
	}
	return value, nil
}
