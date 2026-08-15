// Package files is the group that reads and writes the user's disk.
//
// Two homes exist and this package sees only one of them. The file tree's root
// and `~` expansion mean the OS user's home; the installation's home
// (`~/.soksak-wails`) is where the app keeps what it owns. main.go already
// holds both, so passing the wrong one is one field away — and the symptom is
// not an error but a tree that starts inside the app's own folder. Deps.UserHome
// is that value and never identity.Resolved.Home.
//
// Nothing here reads the environment. The home, the login shell, the platform,
// the runner, the watcher, the change sink, and the clock all arrive as values,
// so the same command answers the same way in a window, in a headless server,
// and in a test.
package files

import (
	"time"

	"github.com/soksak/soksak-core/core/control"
)

// Deps is what the process supplies. Every field is something this package
// refuses to read for itself.
type Deps struct {
	// UserHome is the OS user's home. Never identity.Resolved.Home.
	UserHome string
	// LoginShell is the shell shell_which asks on unix. Empty refuses that
	// command by name rather than guessing $SHELL, which would tie the answer
	// to whatever launched this process. Windows needs none: where.exe takes
	// the name as an argv element, so there is no shell line to build.
	LoginShell string
	// Windows is the platform, as an argument. Branching on runtime.GOOS would
	// answer what this binary is rather than what the caller asked.
	Windows bool
	// Run starts processes. Nil refuses shell_which by name.
	Run Runner
	// Watch is the OS filesystem watcher. Nil refuses watch_dir by name.
	Watch Backend
	// EmitChange fans a changed directory out to whoever owns windows. Nil
	// refuses watch_dir by name, because a subscription with nowhere to deliver
	// is one that never fires.
	EmitChange func(dir string)
	// Delay is the burst-fold window. Zero takes defaultFoldWindow, so the
	// wiring does not have to know the number.
	Delay time.Duration
	// After schedules the fold. Injected so a test pins the rule instead of
	// timing it. Nil takes time.AfterFunc.
	After func(time.Duration, func())
}

// Register adds this group's eight commands.
//
// Every one is OwnerCore: none needs a window, which is what lets a headless
// process answer them identically.
func Register(registry *control.Registry, deps Deps) {
	watch := newWatchers(deps.Watch, deps.EmitChange, deps.Delay, deps.After)

	registry.MustRegister(control.Command{
		Name: "read_text_file",
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			offset, err := control.OptionalArg[int64](args, "offset", 0)
			if err != nil {
				return nil, err
			}
			return readText(path, &offset, deps.UserHome)
		},
	})

	registry.MustRegister(control.Command{
		Name: "write_text_file",
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			content, err := control.Arg[string](args, "content")
			if err != nil {
				return nil, err
			}
			return nil, writeText(path, content, deps.UserHome)
		},
	})

	registry.MustRegister(control.Command{
		Name: "read_file_base64",
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			return readBase64(path, deps.UserHome)
		},
	})

	registry.MustRegister(control.Command{
		Name: "write_file_base64",
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			payload, err := control.Arg[string](args, "base64")
			if err != nil {
				return nil, err
			}
			return writeBase64(path, payload, deps.UserHome)
		},
	})

	registry.MustRegister(control.Command{
		Name: "list_children",
		Handler: func(args control.Args) (any, error) {
			// The explorer sends `path: null` explicitly, so absence and null
			// are one answer here: list the home.
			path, err := control.OptionalArg[string](args, "path", "")
			if err != nil {
				return nil, err
			}
			meta, err := control.OptionalArg[bool](args, "meta", false)
			if err != nil {
				return nil, err
			}
			return listChildren(path, meta, deps.UserHome)
		},
	})

	registry.MustRegister(control.Command{
		Name: "shell_which",
		Handler: func(args control.Args) (any, error) {
			bin, err := control.Arg[string](args, "bin")
			if err != nil {
				return nil, err
			}
			return shellWhich(bin, deps.LoginShell, deps.Windows, deps.Run)
		},
	})

	registry.MustRegister(control.Command{
		Name: "watch_dir",
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			return watch.Watch(path, deps.UserHome)
		},
	})

	registry.MustRegister(control.Command{
		Name: "unwatch_dir",
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			return watch.Unwatch(path, deps.UserHome)
		},
	})
}

// The boundary decoders are control.Arg and control.OptionalArg, not a copy
// of them kept here.
//
// The copy this file used to carry decoded a required argument with
// json.Unmarshal into the value, and Go's json package treats null as a no-op
// for most destinations: no error, and the value keeps its zero. So
// write_text_file with "content": null truncated the named file to nothing and
// answered success — the caller's file, erased, reported as a save. The shared
// helper refuses present-but-null by name, which is the same defect
// core/control/args.go records against window_place.
