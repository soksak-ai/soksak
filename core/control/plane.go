package control

// The control plane's own commands: where it can be reached, the datagrams a
// webview cannot send, the notice it puts on screen, and the receipt it signs
// before the process ends.
//
// They live in this package rather than beside a feature because there is no
// feature under them. "Which socket am I listening on" has no owner but the
// plane itself, and a second package holding that answer would be a second
// answer — the same drift the single registry exists to prevent.

// Deps is what the surrounding process supplies. Every field is something this
// group refuses to read for itself: a core that called os.Executable would
// answer where this binary sits rather than which installation asked, and the
// two differ the moment a second copy is running.
type Deps struct {
	// Socket is the path this process's control plane listens on, as the
	// launcher claimed it. Empty refuses ipc_socket_path by name. Deriving it
	// here would be a second spelling of "where does this installation live",
	// and a caller handed the wrong one reads only "connection failed".
	Socket string

	// CLIDir is the directory holding the client binary that talks to this
	// installation. Empty refuses ipc_cli_dir by name rather than answering
	// wherever this process happens to be running from.
	CLIDir string
	// CLIName is that binary's file name exactly as it exists on disk,
	// including any platform extension. The core appends none: a name the core
	// invents is a name nobody installed. Empty refuses ipc_cli_dir by name.
	CLIName string

	// Notify puts one notification on screen. Nil refuses notify_show by name:
	// this process holds no notification backend, and a command that answered
	// a handle without showing anything is indistinguishable from one that
	// worked.
	Notify Notifier

	// ReleaseGeneration lets go of everything this process started — children,
	// pseudo-terminals, native surfaces — and answers what it released. Nil
	// refuses app_shutdown_prepare by name: a receipt of zeroes from a process
	// that never looked reads exactly like a clean shutdown.
	ReleaseGeneration func() (Generation, error)
}

// The names this group answers to.
const (
	commandSocketPath      = "ipc_socket_path"
	commandCLIDir          = "ipc_cli_dir"
	commandDatagramSend    = "net_udp_send"
	commandDatagramRequest = "net_udp_request"
	commandNotifyShow      = "notify_show"
	commandShutdownPrepare = "app_shutdown_prepare"
)

// CommandNames is what this group covers, served or refused. A caller
// assembling the table needs the whole set, not the half that happened to be
// wired.
func CommandNames() []string {
	return []string{
		commandSocketPath, commandCLIDir,
		commandDatagramSend, commandDatagramRequest,
		commandNotifyShow, commandShutdownPrepare,
	}
}

// Register adds the control plane's own commands.
//
// Every one is OwnerCore: none needs a window, which is what lets `sok` reach
// all six against a process that has drawn nothing.
func Register(registry *Registry, deps Deps) {
	registerAddress(registry, deps)
	registerDatagram(registry)
	registerNotice(registry, deps)
	registerShutdown(registry, deps)
}

// refuse records a command this build cannot answer.
//
// It panics like MustRegister does, and for the same reason: which commands a
// build declares is a programming fact settled before the first caller, not a
// runtime condition someone could handle.
func refuse(registry *Registry, name, because string) {
	if err := registry.DeclareUnserved(name, because); err != nil {
		panic(err)
	}
}
