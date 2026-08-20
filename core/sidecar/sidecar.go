// Package sidecar starts declared units and relays to them, and reads nothing they say.
//
// A unit is a separate process a plugin declared. This package resolves where its binary was
// installed, starts it, waits for the line it prints when it is ready, and moves requests and
// bytes between it and whoever asked. What travels is opaque: the request goes out as it arrived and
// the answer comes back as it was given, because the meaning is a contract between the plugin and
// the unit and not this process's business.
//
// Nothing here reads the environment, the working directory or the platform. The home, the spawner
// and the environment all arrive as values, so the same rules answer the same way in a window, in a
// headless server, and in a test that starts nothing.
//
// # The mechanism could be anyone's; the surface that receives a unit could not
//
// Asked and answered 2026-08-20, written here so it is not reopened as "this could have been pulled
// out".
//
// Two things are easy to read as one. Starting a process, waiting for a line, relaying an envelope
// and reaping — that is generic, and whose repository it is in changes nothing about it. The other
// is the surface a declared unit attaches to: where the declaration is checked, where the names are
// registered, and where the units are ended when the application quits. That is a seam, and a seam
// has nowhere else to be — it is the join itself.
//
// Two facts hold the seam here and neither is about convenience. A plugin is JavaScript in a web
// view: it cannot start a process and cannot open a socket, which `api.ts` states at the relay — the
// core bridges it. And a host that started units cannot itself be one, because nothing would be left
// to start it.
//
// So a repository move would leave this linked into the same binary, in the same process, with the
// same two facts true. That is a folder change, and calling it an architecture change is what this
// paragraph exists to prevent.
//
// The surface is stuck for a third reason, and it is the plainest one: receiving a unit means
// putting names on *this* application's registry. A separate repository doing that would have to
// import the registry, so the thing being plugged into would become a dependency of the thing that
// plugs in — and nothing else could ever use the result, which was the whole reason to separate it.
// The registry is dispatch rather than a wire, so it does not become a contract either.
//
// What genuinely is somebody else's has already left: the envelope this relays
// (`soksak-contract-control`) and the release layout a unit's binary is resolved through. Both are
// contracts, which is where a rule with more than one implementation goes.
package sidecar

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"

	controlwire "github.com/soksak/soksak-contract-control"
	"github.com/soksak/soksak-core/core/i18n"
	"github.com/soksak/soksak-core/core/process"
)

// Deps is what the surrounding process supplies. Every field is something this package refuses to
// read for itself.
type Deps struct {
	// Home is the identity home. A unit's binary and its sockets both derive from it, and a second
	// home is a second set of both.
	Home string
	// Spawner starts units. Nil means this host starts none, and the commands that would start one
	// are declared unserved by name rather than answering as if they had.
	Spawner process.Spawner
	// Environment is what a unit inherits. It arrives complete: a nil one would make os/exec read
	// this process's own, which ties a unit to whatever launched the application.
	Environment []string
	// Dial opens a connection to an address a unit announced. It is injected because the address
	// namespace is the platform's — a filesystem path on one, a named pipe on another — and this
	// package holds no branch on which.
	Dial func(address string) (io.ReadWriteCloser, error)
	// ReadyWithin bounds the wait for a unit's first line. Zero takes the default below.
	ReadyWithin time.Duration
}

// DefaultReadyWithin is how long a unit has to print its first line.
//
// It is a bound on a blocking read, not a poll interval: the read returns the moment the line
// arrives. What the bound is for is the unit that prints nothing at all, which without it leaves the
// caller waiting on a process that will never speak.
const DefaultReadyWithin = 10 * time.Second

// Open is one running unit.
type Open struct {
	// Name is the <name> in soksak-sidecar-<name>.
	Name string
	// Address is what the unit announced, not what this process derived. A unit that binds
	// somewhere else is reachable because it said so.
	Address string
	// Protocol is the envelope version the unit announced.
	Protocol int
	PID      int
}

// Host starts units and holds them open.
type Host struct {
	deps Deps

	mu   sync.Mutex
	open map[string]*unit
}

type unit struct {
	open  Open
	child process.Child
	// stderr is drained into a ring so a unit that fails later can be asked why, rather than
	// filling a pipe nobody reads until it blocks and the unit stops.
	stderr *ring
}

func NewHost(deps Deps) *Host {
	if deps.ReadyWithin == 0 {
		deps.ReadyWithin = DefaultReadyWithin
	}
	return &Host{deps: deps, open: make(map[string]*unit)}
}

// Started reports every unit this host holds open.
func (host *Host) Started() []Open {
	host.mu.Lock()
	defer host.mu.Unlock()
	out := make([]Open, 0, len(host.open))
	for _, held := range host.open {
		out = append(out, held.open)
	}
	return out
}

// Start ensures a unit is running and answers what it announced.
//
// A unit already open is answered with, not started again. Two processes behind one name is a
// process nothing can reach and nothing ends.
func (host *Host) Start(name string) (Open, error) {
	host.mu.Lock()
	if held, running := host.open[name]; running {
		host.mu.Unlock()
		return held.open, nil
	}
	host.mu.Unlock()

	if host.deps.Spawner == nil {
		return Open{}, i18n.Errorf("sidecar.noSpawner", map[string]string{"name": name})
	}
	path, err := process.SidecarPath(host.deps.Home, name)
	if err != nil {
		return Open{}, err
	}

	child, err := host.deps.Spawner.Start(process.Spec{
		Path: path,
		// The home is passed rather than read. A unit that derived its own would answer for a
		// different installation than the one that started it.
		Args:  []string{"-home", host.deps.Home},
		Env:   host.deps.Environment,
		Group: true,
	})
	if err != nil {
		return Open{}, err
	}

	held := &unit{child: child, stderr: newRing(64)}
	go drain(child.Stderr(), held.stderr)

	announced, err := host.await(name, child)
	if err != nil {
		_ = child.Signal()
		go func() { _, _ = child.Wait() }()
		return Open{}, err
	}

	held.open = Open{Name: name, Address: announced.address, Protocol: announced.protocol, PID: child.PID()}
	host.mu.Lock()
	// Another caller may have started the same unit while this one waited. The first one holds it;
	// this one ends what it started rather than leaving a second process nobody has a handle to.
	if existing, raced := host.open[name]; raced {
		host.mu.Unlock()
		_ = child.Signal()
		go func() { _, _ = child.Wait() }()
		return existing.open, nil
	}
	host.open[name] = held
	host.mu.Unlock()
	go host.reapWhenGone(name, held)
	return held.open, nil
}

type announcement struct {
	address  string
	protocol int
}

// await reads the unit's first stdout line and judges it.
//
// The first line is the whole evidence. A unit that printed something else has spent its
// announcement, and no later line changes that: waiting for one would be waiting for a line that
// will never be about a socket.
func (host *Host) await(name string, child process.Child) (announcement, error) {
	type read struct {
		line string
		err  error
	}
	lines := make(chan read, 1)
	go func() {
		line, err := bufio.NewReader(child.Stdout()).ReadString('\n')
		lines <- read{line: line, err: err}
	}()

	timer := time.NewTimer(host.deps.ReadyWithin)
	defer timer.Stop()
	select {
	case got := <-lines:
		if got.err != nil && got.line == "" {
			return announcement{}, i18n.Errorf("sidecar.noAnnouncement", map[string]string{
				"name": name, "reason": got.err.Error(),
			})
		}
		return judge(name, got.line)
	case <-timer.C:
		return announcement{}, i18n.Errorf("sidecar.silent", map[string]string{
			"name": name, "seconds": fmt.Sprintf("%.0f", host.deps.ReadyWithin.Seconds()),
		})
	}
}

// judge reads what a unit's first line stated about itself. It performs no I/O.
func judge(name, line string) (announcement, error) {
	var said controlwire.Announcement
	if err := json.Unmarshal([]byte(line), &said); err != nil || (said.Protocol == nil && said.Socket == nil) {
		// A line that is not an announcement is output. A program may print anything, and calling
		// that a malformed announcement would report every logging unit as broken.
		return announcement{}, i18n.Errorf("sidecar.mute", map[string]string{"name": name, "line": trim(line)})
	}
	if said.Protocol == nil {
		return announcement{}, i18n.Errorf("sidecar.announcedNoProtocol", map[string]string{"name": name})
	}
	if said.Socket == nil {
		return announcement{}, i18n.Errorf("sidecar.announcedNoAddress", map[string]string{"name": name})
	}
	if *said.Protocol != controlwire.Protocol {
		return announcement{}, i18n.Errorf("sidecar.protocolMismatch", map[string]string{
			"name":   name,
			"theirs": fmt.Sprintf("%d", *said.Protocol),
			"ours":   fmt.Sprintf("%d", controlwire.Protocol),
		})
	}
	if trim(*said.Socket) == "" {
		return announcement{}, i18n.Errorf("sidecar.announcedEmptyAddress", map[string]string{"name": name})
	}
	return announcement{address: *said.Socket, protocol: *said.Protocol}, nil
}

// Stop ends one unit. Only what this host started is ended: a process it adopted is one whose
// arguments it never chose and whose work it cannot know.
func (host *Host) Stop(name string) error {
	host.mu.Lock()
	held := host.open[name]
	delete(host.open, name)
	host.mu.Unlock()
	if held == nil {
		return i18n.Errorf("sidecar.notOpen", map[string]string{"name": name})
	}
	if err := held.child.Signal(); err != nil {
		return err
	}
	_, _ = held.child.Wait()
	return nil
}

// StopAll ends every unit this host started and answers how many.
func (host *Host) StopAll() int {
	host.mu.Lock()
	held := make([]*unit, 0, len(host.open))
	for name, one := range host.open {
		held = append(held, one)
		delete(host.open, name)
	}
	host.mu.Unlock()
	for _, one := range held {
		_ = one.child.Signal()
		_, _ = one.child.Wait()
	}
	return len(held)
}

// reapWhenGone forgets a unit that ended on its own, so the next Start begins a new one rather than
// answering with an address nobody is listening at.
func (host *Host) reapWhenGone(name string, held *unit) {
	_, _ = held.child.Wait()
	host.mu.Lock()
	if host.open[name] == held {
		delete(host.open, name)
	}
	host.mu.Unlock()
}

// Complaint answers what a unit last printed to stderr.
//
// A unit that failed after it was started states why there and nowhere else, and without this the
// caller has an address that no longer answers and no reason.
func (host *Host) Complaint(name string) []string {
	host.mu.Lock()
	held := host.open[name]
	host.mu.Unlock()
	if held == nil {
		return nil
	}
	return held.stderr.snapshot()
}

func drain(reader io.ReadCloser, into *ring) {
	defer func() { _ = reader.Close() }()
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		into.add(scanner.Text())
	}
}

func trim(value string) string {
	for len(value) > 0 && (value[len(value)-1] == '\n' || value[len(value)-1] == '\r' || value[len(value)-1] == ' ') {
		value = value[:len(value)-1]
	}
	for len(value) > 0 && (value[0] == ' ' || value[0] == '\t') {
		value = value[1:]
	}
	return value
}
