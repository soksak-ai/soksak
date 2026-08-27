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
	"sort"
	"strings"
	"sync"
	"time"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/i18n"
	"github.com/soksak-ai/soksak-core/core/process"
)

func secretNameFingerprint(namespace string, values map[string]string) string {
	if len(values) == 0 {
		return ""
	}
	names := make([]string, 0, len(values))
	for environment, key := range values {
		names = append(names, environment+"="+key)
	}
	sort.Strings(names)
	return namespace + "\x00" + strings.Join(names, "\x00")
}

// Deps is what the surrounding process supplies. Every field is something this package refuses to
// read for itself.
type Deps struct {
	// Home is the identity home. A unit's binary and its sockets both derive from it, and a second
	// home is a second set of both.
	Home string
	// Runtime is the absolute root for unit sockets and tokens.
	Runtime string
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
	ResolvePath func(name string) (string, error)
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
	Name string `json:"name"`
	// Address is what the unit announced, not what this process derived. A unit that binds
	// somewhere else is reachable because it said so.
	Address string `json:"address"`
	// Protocol is the envelope version the unit announced.
	Protocol int    `json:"protocol"`
	PID      int    `json:"pid"`
	Version  string `json:"version,omitempty"`
}

// Host starts units and holds them open.
type Host struct {
	deps Deps

	mu       sync.Mutex
	open     map[string]*unit
	starting map[string]*startAttempt
	// streams are the live stream connections, under the labels their callers chose. Held so one
	// can be ended without ending the unit it is on.
	streams map[string]io.Closer
	// links are the greeted connections Send reuses, one per unit. A link ends with its unit or when
	// the unit closes it, and the next send opens another.
	links   map[string]*link
	secrets process.SecretSource
	ended   map[string][]string
	// grants are the arguments a unit was last started with, kept under its name. A host that cannot
	// resolve a path of its own starts the unit again from what started it the first time.
	grants map[string]grant
	// answerWithin bounds how long a caller waits for one request. A unit that took the request and
	// answered nothing must not hold the caller, and every caller behind it.
	answerWithin time.Duration
}

const defaultAnswerWithin = 20 * time.Second

// grant is what starting one unit took: the program, the secret namespace and the values, and the
// fingerprint those values answer to.
type grant struct {
	path        string
	version     string
	namespace   string
	secretEnv   map[string]string
	fingerprint string
}

type startAttempt struct {
	done        chan struct{}
	open        Open
	err         error
	secretNames string
	path        string
	version     string
}

func (host *Host) SetSecrets(source process.SecretSource) {
	host.mu.Lock()
	host.secrets = source
	host.mu.Unlock()
}

type unit struct {
	open  Open
	child process.Child
	gone  <-chan struct{}
	// stderr is drained into a ring so a unit that fails later can be asked why, rather than
	// filling a pipe nobody reads until it blocks and the unit stops.
	stderr *ring
	// token is what this host greets the unit with. It is never handed to a caller: a caller that
	// held it could greet the unit directly, which is the one thing this relay exists to be.
	token string
	// adopted marks a unit a previous run of this application started. There is no child handle for
	// one, so nothing here waits on it and ending it is a signal to a pid rather than a reap.
	adopted     bool
	secretNames string
	path        string
}

type childExit struct {
	code int
	err  error
}

func NewHost(deps Deps) *Host {
	if deps.ReadyWithin == 0 {
		deps.ReadyWithin = DefaultReadyWithin
	}
	return &Host{deps: deps, open: make(map[string]*unit), starting: make(map[string]*startAttempt), ended: make(map[string][]string)}
}

// Started reports every unit this host holds open.
// Started reports the units this host holds open. Open means something answers there: a unit whose
// address refuses has gone, and reading the inventory forgets it, so a caller that refuses to act
// while something is running is held by units that are running and by nothing else.
func (host *Host) Started() []Open {
	host.mu.Lock()
	candidates := make([]struct {
		name string
		held *unit
	}, 0, len(host.open))
	for name, held := range host.open {
		candidates = append(candidates, struct {
			name string
			held *unit
		}{name, held})
	}
	host.mu.Unlock()

	out := make([]Open, 0, len(candidates))
	for _, candidate := range candidates {
		if !host.answers(candidate.held.open.Address) {
			host.drop(candidate.name, candidate.held)
			continue
		}
		out = append(out, candidate.held.open)
	}
	return out
}

// Start ensures a unit is running and answers what it announced.
//
// A unit already open is answered with, not started again. Two processes behind one name is a
// process nothing can reach and nothing ends.
//
// A unit this host did not start is found before one is started. That is the whole point of a unit
// being a process: it outlives the application, so an application coming back finds it still there
// with everything it held. Starting a second one instead would leave the first holding children
// nobody can reach — and the first is the one with the work in it.
func (host *Host) Start(name string) (Open, error) {
	return host.StartWithSecrets(name, "", nil)
}

func (host *Host) StartWithSecrets(name, namespace string, secretEnv map[string]string) (Open, error) {
	if host.deps.ResolvePath == nil {
		return Open{}, i18n.Errorf("sidecar.noResolver", map[string]string{"name": name})
	}
	path, err := host.deps.ResolvePath(name)
	if err != nil {
		return Open{}, err
	}
	return host.StartResolvedWithSecrets(name, "", path, namespace, secretEnv)
}

func (host *Host) StartResolvedWithSecrets(name, version, path, namespace string, secretEnv map[string]string) (Open, error) {
	return host.startResolvedWithSecrets(name, version, path, namespace, secretEnv, secretNameFingerprint(namespace, secretEnv))
}

type GeneratedSecret struct {
	Key   string `json:"key"`
	Bytes int    `json:"bytes"`
}

func (host *Host) StartWithGeneratedSecrets(
	name string, generated map[string]GeneratedSecret,
) (Open, error) {
	if host.deps.ResolvePath == nil {
		return Open{}, i18n.Errorf("sidecar.noResolver", map[string]string{"name": name})
	}
	path, err := host.deps.ResolvePath(name)
	if err != nil {
		return Open{}, err
	}
	return host.StartResolvedWithGeneratedSecrets(name, "", path, generated)
}

func (host *Host) StartResolvedWithGeneratedSecrets(name, version, path string, generated map[string]GeneratedSecret) (Open, error) {
	namespace := name
	keys := make(map[string]string, len(generated))
	generator, ok := host.secrets.(process.SecretGenerator)
	if len(generated) > 0 && !ok {
		return Open{}, i18n.Errorf("sidecar.noSecretGenerator", map[string]string{"name": name})
	}
	for environment, declaration := range generated {
		if declaration.Key == "" || declaration.Bytes < 16 || declaration.Bytes > 64 {
			return Open{}, i18n.Errorf("sidecar.invalidGeneratedSecret", map[string]string{"name": name})
		}
		if err := generator.GenerateSecret(namespace, declaration.Key, declaration.Bytes); err != nil {
			return Open{}, err
		}
		keys[environment] = declaration.Key
	}
	names := make(map[string]string, len(generated))
	for environment, declaration := range generated {
		names[environment] = fmt.Sprintf("%s:%d", declaration.Key, declaration.Bytes)
	}
	return host.startResolvedWithSecrets(name, version, path, namespace, keys, secretNameFingerprint(namespace, names))
}

func (host *Host) startResolvedWithSecrets(
	name, version, path, namespace string, secretEnv map[string]string, fingerprint string,
) (Open, error) {
	host.mu.Lock()
	delete(host.ended, name)
	if host.grants == nil {
		host.grants = make(map[string]grant)
	}
	host.grants[name] = grant{path: path, version: version, namespace: namespace, secretEnv: secretEnv, fingerprint: fingerprint}
	if held, running := host.open[name]; running {
		if held.secretNames != fingerprint {
			host.mu.Unlock()
			return Open{}, i18n.Errorf("sidecar.secretSetMismatch", map[string]string{"name": name})
		}
		if held.open.Version != version || held.path != path {
			delete(host.open, name)
			host.closeLinkLocked(name)
			host.mu.Unlock()
			host.forget(name)
			if err := host.end(held); err != nil {
				return Open{}, err
			}
			host.mu.Lock()
		} else {
			host.mu.Unlock()
			// Open means something answers there. A unit this host adopted has no one here watching it
			// end, so its going is only visible at its address — and answering with an address nobody is
			// listening at hands the same failure to every caller after the first.
			if host.answers(held.open.Address) {
				return held.open, nil
			}
			host.drop(name, held)
			host.mu.Lock()
		}
	}
	if pending, starting := host.starting[name]; starting {
		if pending.secretNames != fingerprint {
			host.mu.Unlock()
			return Open{}, i18n.Errorf("sidecar.secretSetMismatch", map[string]string{"name": name})
		}
		sameRuntime := pending.version == version && pending.path == path
		done := pending.done
		host.mu.Unlock()
		<-done
		if sameRuntime {
			return pending.open, pending.err
		}
		return host.startResolvedWithSecrets(name, version, path, namespace, secretEnv, fingerprint)
	}
	pending := &startAttempt{done: make(chan struct{}), secretNames: fingerprint, path: path, version: version}
	host.starting[name] = pending
	host.mu.Unlock()

	opened, err := host.startResolved(name, version, path, namespace, secretEnv, fingerprint)
	host.mu.Lock()
	pending.open, pending.err = opened, err
	delete(host.starting, name)
	close(pending.done)
	host.mu.Unlock()
	return opened, err
}

func (host *Host) startResolved(
	name, version, path, namespace string, secretEnv map[string]string, fingerprint string,
) (Open, error) {
	if adopted, found, err := host.adopt(name, fingerprint, version, path); err != nil {
		return Open{}, err
	} else if found {
		return adopted, nil
	}

	if host.deps.Spawner == nil {
		return Open{}, i18n.Errorf("sidecar.noSpawner", map[string]string{"name": name})
	}
	host.mu.Lock()
	source := host.secrets
	host.mu.Unlock()
	secrets, err := process.ResolveSecretEnvironment(source, namespace, secretEnv)
	if err != nil {
		return Open{}, err
	}
	child, err := host.deps.Spawner.Start(process.Spec{
		Path: path,
		// The home is passed rather than read. A unit that derived its own would answer for a
		// different installation than the one that started it.
		Args:  []string{"-home", host.deps.Home, "-runtime", host.deps.Runtime},
		Env:   process.ChildEnvironmentWithSecrets(host.deps.Environment, host.deps.Home, secrets),
		Group: true,
	})
	if err != nil {
		return Open{}, err
	}

	held := &unit{child: child, stderr: newRing(64), secretNames: fingerprint, path: path}
	stderrDone := make(chan struct{})
	go func() {
		drain(child.Stderr(), held.stderr)
		close(stderrDone)
	}()

	// One watcher per child, started before anything can fail. It is the only caller of Wait for
	// this child's life, which is what the spawner's contract requires and what keeps two callers
	// off one wait status.
	ended := make(chan childExit, 1)
	gone := make(chan struct{})
	held.gone = gone
	go func() {
		code, waitErr := child.Wait()
		ended <- childExit{code: code, err: waitErr}
	}()

	announced, err := host.await(name, child, held.stderr, stderrDone, ended)
	if err != nil {
		_ = child.Signal()
		return Open{}, err
	}

	held.open = Open{Name: name, Address: announced.address, Protocol: announced.protocol, PID: child.PID(), Version: version}
	// The token stays here rather than on Open. Open is what a caller reads, and a caller that could
	// read the token could greet the unit itself — which is the one thing this relay exists to be.
	held.token = announced.token
	host.remember(name, held.open, announced.token, fingerprint, version, path)
	host.mu.Lock()
	// Another caller may have started the same unit while this one waited. The first one holds it;
	// this one ends what it started rather than leaving a second process nobody has a handle to.
	if existing, raced := host.open[name]; raced {
		host.mu.Unlock()
		_ = child.Signal()
		return existing.open, nil
	}
	host.open[name] = held
	host.mu.Unlock()
	go host.forgetWhenGone(name, held, ended, gone)
	return held.open, nil
}

type announcement struct {
	address  string
	protocol int
	// token is what the greeting on that address has to carry. Empty means the unit announced none,
	// which is a unit stating its socket takes an unauthenticated greeting.
	token string
}

// await reads the unit's first stdout line and judges it.
//
// The first line is the whole evidence. A unit that printed something else has spent its
// announcement, and no later line changes that: waiting for one would be waiting for a line that
// will never be about a socket.
func (host *Host) await(
	name string, child process.Child, stderr *ring, stderrDone <-chan struct{}, ended <-chan childExit,
) (announcement, error) {
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
			exit := <-ended
			<-stderrDone
			detail := childExitReason(exit)
			if tail := stderr.snapshot(); len(tail) > 0 {
				detail += "; stderr: " + tail[len(tail)-1]
			}
			return announcement{}, i18n.Errorf("sidecar.noAnnouncement", map[string]string{
				"name": name, "reason": detail,
			})
		}
		return judge(name, got.line)
	case <-timer.C:
		return announcement{}, i18n.Errorf("sidecar.silent", map[string]string{
			"name": name, "seconds": fmt.Sprintf("%.0f", host.deps.ReadyWithin.Seconds()),
		})
	}
}

func childExitReason(exit childExit) string {
	if exit.err != nil {
		return exit.err.Error()
	}
	return fmt.Sprintf("exit code %d", exit.code)
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
	token := ""
	if said.Token != nil {
		token = *said.Token
	}
	return announcement{address: *said.Socket, protocol: *said.Protocol, token: token}, nil
}

// Release lets go of a unit without ending it.
//
// This is what a caller that has finished with a unit does, and it is not Stop. A unit is a process
// so that it outlives the application: a plugin that is disabled, a view that unmounts, a channel
// that is released — none of those are reasons to end shells somebody is working in, and a release
// that ended one would undo the reason the unit is a process at all.
//
// The record stays, so the next Start finds the unit rather than beginning a second one.
func (host *Host) Release(name string) error {
	host.mu.Lock()
	held := host.open[name]
	host.mu.Unlock()
	if held == nil {
		return i18n.Errorf("sidecar.notOpen", map[string]string{"name": name})
	}
	return nil
}

// Stop ends one unit and forgets it.
//
// Ending, not releasing. This is for a unit whose work is over, not for an application that has
// finished with one — two different questions, and Release is the other.
func (host *Host) Stop(name string) error {
	host.mu.Lock()
	held := host.open[name]
	delete(host.open, name)
	host.closeLinkLocked(name)
	host.mu.Unlock()
	if held == nil {
		found, err := host.adoptOwned(name)
		if err != nil {
			return err
		}
		if !found {
			host.forget(name)
			return nil
		}
		host.mu.Lock()
		held = host.open[name]
		delete(host.open, name)
		host.closeLinkLocked(name)
		host.mu.Unlock()
		if held == nil {
			return nil
		}
	}
	host.forget(name)
	return host.end(held)
}

// StopAll ends every unit this host holds and answers how many.
func (host *Host) StopAll() int {
	host.mu.Lock()
	held := make([]*unit, 0, len(host.open))
	for name, one := range host.open {
		held = append(held, one)
		host.forget(name)
		delete(host.open, name)
		host.closeLinkLocked(name)
	}
	host.mu.Unlock()
	for _, one := range held {
		_ = host.end(one)
	}
	return len(held)
}

// end signals a unit and leaves the reaping to whoever owns it.
//
// Wait is called by exactly one goroutine for the life of a child — the contract in `core/process`
// states it, and two callers of it race on the same wait status. The one goroutine is the watcher
// started beside the child; this only signals, and the watcher notices.
//
// A unit this host adopted has no child handle at all. It was started by a previous run, so there is
// nothing here to wait on and ending it is a signal to the pid the record named.
func (host *Host) end(held *unit) error {
	if held.child != nil {
		if err := held.child.Signal(); err != nil {
			return err
		}
		timer := time.NewTimer(host.deps.ReadyWithin)
		defer timer.Stop()
		select {
		case <-held.gone:
			return nil
		case <-timer.C:
			return i18n.Errorf("sidecar.ownedStopTimeout", map[string]string{
				"name": held.open.Name, "seconds": host.deps.ReadyWithin.String(),
			})
		}
	}
	if held.open.PID > 0 {
		return signalPID(held.open.PID)
	}
	return nil
}

// restart starts a unit again from the arguments it was last started with. A host with no resolver
// of its own has no other way back to a unit whose process went, and the caller was granted the
// name rather than one process.
func (host *Host) restart(name string) (Open, error) {
	host.mu.Lock()
	remembered, known := host.grants[name]
	host.mu.Unlock()
	if !known {
		return host.Start(name)
	}
	return host.startResolvedWithSecrets(
		name, remembered.version, remembered.path, remembered.namespace, remembered.secretEnv, remembered.fingerprint,
	)
}

// answers reports whether a greeting could reach that address at all. Nothing is sent: a connection
// that opens is a unit that is there, and a connection refused is one that is not.
func (host *Host) answers(address string) bool {
	if host.deps.Dial == nil || address == "" {
		return true
	}
	conn, err := host.deps.Dial(address)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// drop forgets a unit whose address no longer answers, so the next Start begins a new one. Called
// with host.mu unlocked; it takes and releases the lock itself.
func (host *Host) drop(name string, held *unit) {
	host.mu.Lock()
	if host.open[name] == held {
		delete(host.open, name)
	}
	host.closeLinkLocked(name)
	host.mu.Unlock()
	host.forget(name)
}

// forgetWhenGone drops a unit that ended on its own, so the next Start begins a new one rather than
// answering with an address nobody is listening at.
//
// It waits on the watcher's channel rather than calling Wait itself. Two callers of Wait race on one
// wait status, and the spawner's contract states there is exactly one.
func (host *Host) forgetWhenGone(name string, held *unit, ended <-chan childExit, gone chan<- struct{}) {
	<-ended
	host.mu.Lock()
	if host.open[name] == held {
		host.recordEndedComplaintLocked(name, held)
		delete(host.open, name)
		host.closeLinkLocked(name)
	}
	host.mu.Unlock()
	host.forget(name)
	close(gone)
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

func (host *Host) Complaints() map[string][]string {
	host.mu.Lock()
	defer host.mu.Unlock()
	result := make(map[string][]string, len(host.open)+len(host.ended))
	for name, tail := range host.ended {
		result[name] = append([]string(nil), tail...)
	}
	for name, held := range host.open {
		if tail := held.stderr.snapshot(); len(tail) > 0 {
			result[name] = tail
		}
	}
	return result
}

func (host *Host) recordEndedComplaint(name string, held *unit) {
	host.mu.Lock()
	defer host.mu.Unlock()
	host.recordEndedComplaintLocked(name, held)
}

func (host *Host) recordEndedComplaintLocked(name string, held *unit) {
	if tail := held.stderr.snapshot(); len(tail) > 0 {
		host.ended[name] = tail
	}
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

// ServiceShutdown lets go of every unit and ends none of them.
//
// It called StopAll until 2026-08-20, which ended every unit as the application quit — and that is
// the one moment a unit exists to survive. A shell that dies when the application does is a shell
// that could have been in the application, and the whole shape above it, the record, the adoption
// and the release that is not an end, buys nothing.
//
// What is left behind is a running process and a record naming it, which is exactly what the next
// run reads: it connects, greets, and finds the shells still there.
//
// So nothing here ends a unit, and nothing else does either. A unit is ended by `sidecar_stop`,
// which is a statement that its work is over. An application quitting is not that statement.
func (host *Host) ServiceShutdown() error {
	host.mu.Lock()
	for name := range host.open {
		delete(host.open, name)
	}
	for name := range host.links {
		host.closeLinkLocked(name)
	}
	streams := host.streams
	host.streams = nil
	host.mu.Unlock()

	// The connections do go. They are this process's file descriptors and nothing outside it can
	// use them; the unit sees a reader leave, which is a thing it already handles.
	for _, held := range streams {
		_ = held.Close()
	}
	return nil
}
