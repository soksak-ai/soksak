package daemon

import (
	"fmt"
	"sort"
	"sync"

	"github.com/soksak/soksak-core/core/process"
)

// Daemon is one daemon, as the status table reports it.
//
// The field names are the caller's, and they are kept exactly: the frontend
// reads exit_code, uptime_ms and restarts off this row.
type Daemon struct {
	Root string `json:"root"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
	// Running is what this build knows from having waited on the child, never
	// from looking a pid up: the pid it started is the shell's, and the shell
	// exiting is exactly the event that is being waited on.
	Running bool `json:"running"`
	// ExitCode is null while it runs, and null afterwards when the child left
	// no code of its own — a signalled process has none, and reporting 0 for
	// one would say it finished successfully.
	ExitCode *int `json:"exit_code"`
	// UptimeMS is how long it has been running, or how long it ran.
	UptimeMS int64 `json:"uptime_ms"`
	// Restarts is 0 in this build and says so rather than being left out:
	// nothing here restarts a daemon that exited. A caller that wants one
	// starts it again, which is a decision it makes with the exit code in hand.
	Restarts int `json:"restarts"`
	// Cmd is the line this daemon was started with. It is what a later run
	// matches a recorded pid against before ending it.
	Cmd string `json:"cmd"`
	// Readiness is what the daemon said about its own control socket.
	Readiness Readiness `json:"readiness"`
}

// key is what a daemon is named by. A name is unique inside one project and
// nowhere else — two projects each declare a "dev".
type key struct {
	root string
	name string
}

// running is one daemon this process started.
type running struct {
	root      string
	name      string
	cmd       string
	pid       int
	startedAt int64
	child     process.Child
	log       *ring

	// done closes once the one waiter has reaped the child and its output has
	// been read to the end. A stop observes it instead of waiting a second
	// time, and instead of looking again.
	done chan struct{}
	// readers is the two pumps. The waiter joins them before it reports the
	// exit, so a listener that reads the log when a daemon ends sees the line
	// that says why it ended. The join is safe for the reason core/process
	// gives for killing the group first: with the tree gone, nothing is left
	// holding the pipe open.
	readers sync.WaitGroup

	mu        sync.Mutex
	alive     bool
	code      *int
	endedAt   int64
	readiness Readiness
}

func (one *running) snapshot(now int64) Daemon {
	one.mu.Lock()
	defer one.mu.Unlock()

	until := now
	if !one.alive {
		until = one.endedAt
	}
	return Daemon{
		Root:      one.root,
		Name:      one.name,
		PID:       one.pid,
		Running:   one.alive,
		ExitCode:  one.code,
		UptimeMS:  until - one.startedAt,
		Restarts:  0,
		Cmd:       one.cmd,
		Readiness: one.readiness,
	}
}

// Supervisor owns every daemon this process started.
//
// It is answered from the commands and returned from Register, because nothing
// in the six commands ends the daemons when the application quits. A group that
// can be registered and never told to stop leaves a dev server holding a port
// after the window is gone, and shutdown must not depend on a frontend
// remembering to call a seventh command.
type Supervisor struct {
	deps Deps

	mu      sync.Mutex
	daemons map[key]*running
}

func newSupervisor(deps Deps) *Supervisor {
	return &Supervisor{deps: deps, daemons: map[key]*running{}}
}

// Start runs one daemon and answers its pid.
//
// The whole call holds the table's lock, spawn included. Two starts of one name
// racing would otherwise both find nothing running and both start a server, and
// the second would fail on the port while the first is unreachable through this
// table.
func (supervisor *Supervisor) Start(root, name, cmd string) (int, error) {
	program, args, err := daemonArgv(supervisor.deps.LoginShell, cmd)
	if err != nil {
		return 0, err
	}

	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()

	at := key{root: root, name: name}
	if existing, held := supervisor.daemons[at]; held {
		existing.mu.Lock()
		alive := existing.alive
		pid := existing.pid
		existing.mu.Unlock()
		if alive {
			// Starting a second copy is never what the caller meant: the two
			// would fight over the same port, and this table could only reach
			// the newer one — the first would keep running with nothing left to
			// stop it by.
			return 0, fmt.Errorf("daemon %q is already running under %s as pid %d — stop it before starting it again", name, root, pid)
		}
	}

	child, err := supervisor.deps.Spawner.Start(process.Spec{
		Path: program,
		Args: args,
		Dir:  root,
		Env:  supervisor.deps.Environment(nil),
		// A daemon is a shell line that starts something else. Without its own
		// process group a stop reaches the shell and leaves the server it
		// started holding the port, and the caller is told it stopped.
		Group: true,
	})
	if err != nil {
		return 0, fmt.Errorf("starting daemon %q under %s: %w", name, root, err)
	}
	// Nobody is typing at a daemon. Closing its stdin now means a command that
	// asks a question reads EOF and gives up, instead of waiting forever for an
	// answer nobody is there to give — and it is the only thing that stops this
	// process holding one pipe per daemon for as long as it runs.
	_ = child.Stdin().Close()

	one := &running{
		root:      root,
		name:      name,
		cmd:       cmd,
		pid:       child.PID(),
		startedAt: supervisor.deps.Now(),
		child:     child,
		log:       newRing(),
		done:      make(chan struct{}),
		alive:     true,
		readiness: Readiness{State: Silent},
	}
	// The entry is in the table before any reader runs: a daemon that exits
	// immediately reaches its exit handler while this function is still
	// working, and that handler would otherwise finish a row nothing had added.
	supervisor.daemons[at] = one

	one.readers.Add(2)
	go func() { defer one.readers.Done(); pump(child.Stdout(), supervisor.announced(one), one.log.keep) }()
	go func() { defer one.readers.Done(); pump(child.Stderr(), nil, one.log.keep) }()
	go supervisor.wait(one)

	return one.pid, nil
}

// announced hands the daemon's first stdout line to the readiness rule.
func (supervisor *Supervisor) announced(one *running) func(string) {
	return func(line string) {
		read := readAnnouncement(line)

		one.mu.Lock()
		one.readiness = read
		one.mu.Unlock()

		if supervisor.deps.Announce != nil && read.State != Mute {
			// Only an answer about the control socket travels. A daemon that
			// prints ordinary output has said nothing anybody is waiting for,
			// and an event for every daemon that never announces would teach
			// the listener to ignore the ones that do.
			supervisor.deps.Announce(one.snapshot(supervisor.deps.Now()))
		}
	}
}

// wait reaps the child and records how it ended.
func (supervisor *Supervisor) wait(one *running) {
	code, err := one.child.Wait()
	// The pipes reach EOF once the child's group is gone. Joining the readers
	// here is what makes the last line a daemon printed part of the log by the
	// time anyone is told it ended.
	one.readers.Wait()

	one.mu.Lock()
	one.alive = false
	one.endedAt = supervisor.deps.Now()
	if err == nil && code >= 0 {
		ended := code
		one.code = &ended
	}
	// A code of -1 or a failed wait leaves ExitCode null. "It was killed" and
	// "it exited 0" are different facts, and a 0 written here would report the
	// second for the first.
	one.mu.Unlock()

	close(one.done)
	if supervisor.deps.Announce != nil {
		supervisor.deps.Announce(one.snapshot(supervisor.deps.Now()))
	}
}

// Stop ends the daemons named by root, and by name when one is given.
//
// It answers with the names it actually ended. A daemon that had already exited
// is not one this call stopped, and saying it was would report work nobody did.
func (supervisor *Supervisor) Stop(root, name string) ([]string, error) {
	supervisor.mu.Lock()
	var targets []*running
	for at, one := range supervisor.daemons {
		if at.root != root || (name != "" && at.name != name) {
			continue
		}
		one.mu.Lock()
		alive := one.alive
		one.mu.Unlock()
		if alive {
			targets = append(targets, one)
		}
	}
	supervisor.mu.Unlock()

	sort.Slice(targets, func(i, j int) bool { return targets[i].name < targets[j].name })

	stopped := make([]string, 0, len(targets))
	for _, one := range targets {
		if err := one.child.Signal(); err != nil {
			return nil, fmt.Errorf("stopped %v; daemon %q under %s could not be stopped and is still running: %w",
				stopped, one.name, one.root, err)
		}
		// The waiter is the one reaper, and this observes what it recorded. A
		// stop that returned before the child was reaped would let the next
		// start find the port still held.
		<-one.done
		stopped = append(stopped, one.name)
	}
	return stopped, nil
}

// StopAll ends every daemon this process started, and is what the host calls
// when it quits.
func (supervisor *Supervisor) StopAll() int {
	supervisor.mu.Lock()
	targets := make([]*running, 0, len(supervisor.daemons))
	for _, one := range supervisor.daemons {
		one.mu.Lock()
		alive := one.alive
		one.mu.Unlock()
		if alive {
			targets = append(targets, one)
		}
	}
	supervisor.mu.Unlock()

	ended := 0
	for _, one := range targets {
		if err := one.child.Signal(); err != nil {
			// Nothing here can act on it — the process is quitting. The count
			// is what it managed, so a caller that reports it does not claim
			// this one.
			continue
		}
		<-one.done
		ended++
	}
	return ended
}

// Status answers the daemons declared under one project root.
//
// Exited daemons stay in the answer until their name is started again, because
// the exit code is the whole reason a caller asks after a daemon that stopped.
func (supervisor *Supervisor) Status(root string) []Daemon {
	supervisor.mu.Lock()
	held := make([]*running, 0, len(supervisor.daemons))
	for at, one := range supervisor.daemons {
		if at.root == root {
			held = append(held, one)
		}
	}
	supervisor.mu.Unlock()

	now := supervisor.deps.Now()
	// Never nil: an empty list and a build that cannot answer must not arrive
	// as the same JSON null.
	rows := make([]Daemon, 0, len(held))
	for _, one := range held {
		rows = append(rows, one.snapshot(now))
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	return rows
}

// Logs answers one daemon's recent output.
//
// A name this process never started fails by name. Answering with an empty list
// would say the daemon printed nothing, and the caller would go looking at the
// daemon instead of at the name it asked for.
func (supervisor *Supervisor) Logs(root, name string, count int) ([]string, error) {
	supervisor.mu.Lock()
	one, held := supervisor.daemons[key{root: root, name: name}]
	supervisor.mu.Unlock()

	if !held {
		return nil, fmt.Errorf("no daemon %q was started under %s in this build", name, root)
	}
	return one.log.recent(count), nil
}
