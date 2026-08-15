package ai

import (
	"github.com/soksak/soksak-core/core/control"
)

// Deps is what the process supplies.
//
// Both fields are injected because reading either here would make the same
// command answer differently depending on which process asked — and the wrong
// answer arrives as "this project has no agent sessions" rather than as a
// failure.
type Deps struct {
	// UserHome is the OS user's home (~), under which both agents keep their
	// transcripts. It is not identity.Resolved.Home: that is the application's
	// own folder, and the agents have never heard of it.
	//
	// Empty refuses ai_session_dir and ai_session_find by name at
	// registration. That is knowable when the process is assembled, so the
	// table says this build cannot answer them instead of every call finding
	// out separately.
	UserHome string
	// Lineage reads the recorded session transitions — in the running process,
	// the key-value store.
	//
	// Nil refuses ai_session_lineage by name. An empty list from a process that
	// holds no history reads as "this directory has no forks", and that is a
	// different fact from "this build cannot tell you".
	Lineage LineageStore
}

// Register adds this group's commands.
//
// Every one of them is host-independent: they answer from files and a store,
// with no window anywhere, which is what makes them reachable from `sok`.
//
// What this group does not do is run an agent. This build ships no model
// client; a turn is a spawned child process, and nothing here may answer as
// though a turn had happened.
func Register(registry *control.Registry, deps Deps) {
	// One ledger per process. Two would each hold their own idea of "the last
	// look" at a session directory and answer the same question differently.
	tracker := NewTracker()

	registry.MustRegister(control.Command{
		Name:  "ai_session_detect",
		Owner: control.OwnerCore,
		Handler: func(args control.Args) (any, error) {
			commandLine, err := control.Arg[string](args, "commandLine")
			if err != nil {
				return nil, err
			}
			kind, launched := Detect(commandLine)
			if !launched {
				// Null, not the empty string. The caller asks which agent this
				// command line starts and tags a terminal block with the
				// answer; an empty string is an answer shaped like a kind.
				return nil, nil
			}
			return string(kind), nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "ai_session_inspect",
		Owner: control.OwnerCore,
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			return Inspect(path)
		},
	})

	registry.MustRegister(control.Command{
		Name:  "ai_session_active",
		Owner: control.OwnerCore,
		Handler: func(args control.Args) (any, error) {
			directory, err := control.Arg[string](args, "dir")
			if err != nil {
				return nil, err
			}
			active, written, err := tracker.Active(directory)
			if err != nil {
				return nil, err
			}
			if !written {
				// Nothing was written since the last look. The caller records a
				// transition whenever this differs from what it already holds,
				// so an invented answer here becomes an invented fork.
				return nil, nil
			}
			return active, nil
		},
	})

	if deps.UserHome == "" {
		for _, name := range []string{"ai_session_dir", "ai_session_find"} {
			if err := registry.DeclareUnserved(name, noUserHome); err != nil {
				panic(err)
			}
		}
	} else {
		registry.MustRegister(control.Command{
			Name:  "ai_session_dir",
			Owner: control.OwnerCore,
			Handler: func(args control.Args) (any, error) {
				cwd, err := control.Arg[string](args, "cwd")
				if err != nil {
					return nil, err
				}
				return Directory(deps.UserHome, cwd)
			},
		})

		registry.MustRegister(control.Command{
			Name:  "ai_session_find",
			Owner: control.OwnerCore,
			Handler: func(args control.Args) (any, error) {
				cwd, err := control.Arg[string](args, "cwd")
				if err != nil {
					return nil, err
				}
				return Newest(deps.UserHome, cwd)
			},
		})
	}

	if deps.Lineage == nil {
		if err := registry.DeclareUnserved(
			"ai_session_lineage",
			"this process holds no store to read session transitions from — set ai.Deps.Lineage; answering an empty list instead would say this working directory has no history",
		); err != nil {
			panic(err)
		}
		return
	}
	registry.MustRegister(control.Command{
		Name:  "ai_session_lineage",
		Owner: control.OwnerCore,
		Handler: func(args control.Args) (any, error) {
			cwd, err := control.Arg[string](args, "cwd")
			if err != nil {
				return nil, err
			}
			// Absent and null are the same request here: every tab in this
			// working directory. The frontend sends null explicitly.
			viewID, err := control.OptionalArg(args, "viewId", "")
			if err != nil {
				return nil, err
			}
			return Lineage(deps.Lineage, cwd, viewID)
		},
	})
}
