package process

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// readBuffer is 64 KB, matching a pipe's capacity so one read empties it.
//
// At 8 KB a 4 MB frame arrived as roughly 512 messages and the consumer's
// callback storm dominated; 64 KB cut both the read count and the message
// count eightfold. Delivery here is deliberately not batched, unlike the
// terminal's: this consumer is a sidecar that expects frame boundaries, and
// batching would move them.
const readBuffer = 64 * 1024

// drainBuffer is small on purpose: nothing is delivered from it, and it only
// exists to keep the child's pipe from filling.
const drainBuffer = 8 * 1024

// Request is one spawn, with every value the caller supplied.
type Request struct {
	Cmd  string
	Args []string
	// Cwd empty means the spawner's own default rather than an invented one.
	Cwd       string
	Env       map[string]string
	EnvRemove []string
	Group     bool
	Namespace string
	SecretEnv map[string]string
	// Window empty means unowned. It is never a matchable key: reclamation
	// refuses an empty label, so no reclaim can ever name these children.
	Window string
}

// Info is one child, as the ownership ledger sees it.
type Info struct {
	// ID is the handle a caller holds — a small counter, not an OS pid.
	ID uint32 `json:"id"`
	// PID is the OS process id, the only thing that can answer whether that
	// process is alive. Confusing it with the handle makes the question
	// unaskable.
	PID int `json:"pid"`
	// Window is null for an unowned child. An empty string here would compare
	// equal to a label and make one reclaim reap every windowless child.
	Window *string `json:"window"`
	Cmd    string  `json:"cmd"`
	CWD    string  `json:"cwd,omitempty"`
	Group  bool    `json:"group"`
	// Alive is false once the direct child has been reaped. An entry that is
	// dead and still listed is exactly what an orphan looks like.
	Alive bool `json:"alive"`
}

type session struct {
	id     uint32
	pid    int
	window string
	cwd    string
	owned  bool
	cmd    string
	group  bool
	child  Child

	alive atomic.Bool
	// done closes once the one waiter has reaped the direct child and recorded
	// its code. The kill path observes it instead of waiting a second time.
	done chan struct{}
	code int
	// waitErr survives so a kill can say the child was signalled but not
	// reaped, rather than reporting a reaping that did not happen.
	waitErr error

	stdinMu sync.Mutex
	stdin   io.WriteCloser
}

// Manager owns every child this process started.
type Manager struct {
	deps Deps

	mu       sync.Mutex
	sessions map[uint32]*session
	nextID   uint32
}

func NewManager(deps Deps) *Manager {
	if deps.Spawner != nil && deps.Sink == nil {
		// A host that starts children with nowhere to send their output would
		// spawn children whose bytes go nowhere while the caller believes it
		// subscribed. That is a wiring fact, decided before anything runs.
		panic("process: a host with a spawner needs a sink; children would otherwise stream into nothing")
	}
	return &Manager{deps: deps, sessions: map[uint32]*session{}}
}

// Spawn starts a child and registers it before any reader runs.
//
// Registration comes first because a very short child can reach stdout EOF
// while the spawning goroutine is still working: the reader would then remove
// an entry that had not been added, and the entry would appear afterwards with
// nothing left to remove it.
func (manager *Manager) Spawn(request Request) (uint32, error) {
	if manager.deps.Spawner == nil {
		return 0, i18n.Errorf("process.spawn.noSpawner", nil)
	}
	if request.Group {
		if err := groupRefusal(groupHonoured, groupNotHonouredBecause); err != nil {
			return 0, err
		}
	}
	// Secrets resolve before anything starts. If one is locked or missing, no
	// child comes up at all.
	secrets, err := resolveSecretEnv(manager.deps.Secrets, request.Namespace, request.SecretEnv)
	if err != nil {
		return 0, err
	}
	path := request.Cmd
	child, err := manager.deps.Spawner.Start(Spec{
		Path: path,
		Args: request.Args,
		Dir:  request.Cwd,
		Env: childEnvironment(environmentRequest{
			Inherited: manager.deps.Environment,
			Home:      manager.deps.Home,
			Set:       request.Env,
			Remove:    request.EnvRemove,
			Secrets:   secrets,
		}),
		Group: request.Group,
	})
	if err != nil {
		return 0, fmt.Errorf("process_spawn %s: %w", path, err)
	}

	entry := &session{
		id:     0,
		pid:    child.PID(),
		window: request.Window,
		cwd:    request.Cwd,
		owned:  request.Window != "",
		cmd:    strings.TrimSpace(path + " " + strings.Join(request.Args, " ")),
		group:  request.Group,
		child:  child,
		done:   make(chan struct{}),
		stdin:  child.Stdin(),
	}
	entry.alive.Store(true)

	manager.mu.Lock()
	manager.nextID++
	entry.id = manager.nextID
	manager.sessions[entry.id] = entry
	manager.mu.Unlock()

	go manager.await(entry)
	go manager.stream(entry, streamStderr, child.Stderr(), false)
	go manager.stream(entry, streamStdout, child.Stdout(), true)

	return entry.id, nil
}

// await is the only goroutine that ever waits on a child.
//
// It reaps the direct child as soon as that child dies, so the ledger stops
// claiming it is alive even while a grandchild still holds the output pipe.
// The exit event is not sent here: its place is the end of the stream.
func (manager *Manager) await(entry *session) {
	code, err := entry.child.Wait()
	entry.code, entry.waitErr = code, err
	entry.alive.Store(false)
	close(entry.done)
}

// stream pumps one output pipe to the sink and, on the last one, closes the
// stream with the exit event.
func (manager *Manager) stream(entry *session, name string, source io.ReadCloser, last bool) {
	if manager.pump(entry.id, name, source) == pumpClosed {
		// The consumer left but the child may still be alive. Draining keeps
		// its pipe from filling — a child blocked in write cannot even be
		// killed cleanly — and it holds no lock the kill path needs.
		drain(source)
	}
	_ = source.Close()
	if !last {
		return
	}

	// Stdout EOF means the last writer let go, so nothing further is coming.
	<-entry.done
	manager.forget(entry)
	// Leaving the ledger and the exit receipt are one event: an alive:false
	// entry still listed after the consumer saw the exit means the ownership
	// ledger disagrees with the facts. The exit ends the stream, so a departed
	// consumer here leaves nothing left to stop producing.
	manager.deps.Sink.EmitProcessExit(Exit{ID: entry.id, Code: entry.code})
}

type pumpEnd int

const (
	pumpEOF pumpEnd = iota
	pumpClosed
)

func (manager *Manager) pump(id uint32, name string, source io.Reader) pumpEnd {
	buffer := make([]byte, readBuffer)
	for {
		count, err := source.Read(buffer)
		if count > 0 {
			delivery := manager.deps.Sink.EmitProcessOutput(Output{
				ID:         id,
				Stream:     name,
				DataBase64: base64.StdEncoding.EncodeToString(buffer[:count]),
			})
			if delivery == Gone {
				return pumpClosed
			}
		}
		if err != nil {
			// A read error is a broken pipe, which is EOF by another name.
			return pumpEOF
		}
	}
}

func drain(source io.Reader) {
	buffer := make([]byte, drainBuffer)
	for {
		if _, err := source.Read(buffer); err != nil {
			return
		}
	}
}

// forget removes an entry only if the ledger still holds this same session; a
// kill may already have taken it out and started another in its place.
func (manager *Manager) forget(entry *session) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.sessions[entry.id] == entry {
		delete(manager.sessions, entry.id)
	}
}

// settled closes when the direct child behind that handle has been reaped and
// its code recorded. It is the event boundary this package observes instead of
// polling for a state change.
func (manager *Manager) settled(id uint32) <-chan struct{} {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if entry, held := manager.sessions[id]; held {
		return entry.done
	}
	// A handle that names nothing has already settled, in the only sense the
	// caller can act on.
	closed := make(chan struct{})
	close(closed)
	return closed
}

// Write puts bytes on that child's stdin.
func (manager *Manager) Write(id uint32, data []byte) error {
	entry, held := manager.lookup(id)
	if !held {
		return i18n.Errorf("process.handle.noSuchProcess", map[string]string{"id": fmt.Sprint(id)})
	}
	entry.stdinMu.Lock()
	defer entry.stdinMu.Unlock()
	if entry.stdin == nil {
		return i18n.Errorf("process.write.stdinClosed", map[string]string{"id": fmt.Sprint(id)})
	}
	// The pipe is unbuffered, so the write is the flush.
	if _, err := entry.stdin.Write(data); err != nil {
		return fmt.Errorf("process %d: writing stdin: %w", id, err)
	}
	return nil
}

// CloseStdin closes stdin and leaves the child running.
//
// A child that reads stdin to the end blocks forever without this. Closing
// twice is a no-op; a handle that names nothing is not, because the caller
// believes it just released a child that will now wait for an EOF nobody sent.
func (manager *Manager) CloseStdin(id uint32) error {
	entry, held := manager.lookup(id)
	if !held {
		return i18n.Errorf("process.handle.noSuchProcess", map[string]string{"id": fmt.Sprint(id)})
	}
	entry.closeStdin()
	return nil
}

func (entry *session) closeStdin() {
	entry.stdinMu.Lock()
	defer entry.stdinMu.Unlock()
	if entry.stdin == nil {
		return
	}
	_ = entry.stdin.Close()
	entry.stdin = nil
}

// Kill reaps one child. A handle that names nothing comes back not reaped —
// idempotent, because the plugin API kills on unload, but never claiming a
// reaping that did not happen.
func (manager *Manager) Kill(id uint32) (bool, error) {
	manager.mu.Lock()
	entry, held := manager.sessions[id]
	if held {
		delete(manager.sessions, id)
	}
	manager.mu.Unlock()
	if !held {
		return false, nil
	}
	if err := manager.reap(entry); err != nil {
		return false, err
	}
	return true, nil
}

// reap signals and then observes the one waiter.
//
// A kill signal is not a reaping: only the wait keeps the direct child out of
// the kernel's process table, and only then is the ending a fact.
//
// The signal goes first, before stdin is touched. A write that filled the
// child's stdin pipe is parked in the kernel holding stdinMu, and a kill that
// closed stdin first would queue behind it — while the only thing that can
// release it is the kill it is blocking. Measured 2026-08-15: a 4 MB write to
// a child that never reads stdin hung Kill and ReapAll for ever. Signalling
// first kills the child, the write fails with EPIPE, and the lock is free by
// the time stdin is closed. The same order was measured elsewhere: kill and
// waited, and let the stdin handle go afterwards.
func (manager *Manager) reap(entry *session) error {
	signalErr := entry.child.Signal()
	<-entry.done
	// Only now: the direct child is reaped, so nothing this package started is
	// still reading. An ungrouped grandchild that inherited stdin can still
	// hold the read end open — which is what Group exists to prevent.
	entry.closeStdin()
	if entry.waitErr != nil {
		return fmt.Errorf("process %d (pid %d) was signalled but not reaped: %w", entry.id, entry.pid, entry.waitErr)
	}
	if signalErr != nil {
		return fmt.Errorf("process %d (pid %d): %w", entry.id, entry.pid, signalErr)
	}
	return nil
}

// List answers with every child this process still owns, sorted by handle.
//
// The core holds these processes on a plugin's behalf. Without this surface a
// child that reclamation failed to reap is invisible from outside, and nobody
// is told a detached child exists.
func (manager *Manager) List() []Info {
	manager.mu.Lock()
	entries := make([]*session, 0, len(manager.sessions))
	for _, entry := range manager.sessions {
		entries = append(entries, entry)
	}
	manager.mu.Unlock()

	listed := make([]Info, 0, len(entries))
	for _, entry := range entries {
		info := Info{
			ID:    entry.id,
			PID:   entry.pid,
			Cmd:   entry.cmd,
			CWD:   entry.cwd,
			Group: entry.group,
			Alive: entry.alive.Load(),
		}
		if entry.owned {
			label := entry.window
			info.Window = &label
		}
		listed = append(listed, info)
	}
	// Sorted by handle so two readings compare; map order would make a diff of
	// the same ledger look like a change.
	sort.Slice(listed, func(first, second int) bool { return listed[first].ID < listed[second].ID })
	return listed
}

// ReclaimByWindow reaps every child stamped with that label.
//
// The label is an argument rather than a framework-injected window. The
// process_reclaim_window expects the host to supply it, so a
// windowless process could not serve the command at all (measured 2026-07-30:
// 39 refusals on the second framework). Here core must answer headlessly, so
// the caller names the window.
//
// The trigger differs from reaping a destroyed window: the window is alive and
// only its plugin runtime restarted. The new runtime has spawned nothing yet,
// so everything left under this label is the previous one's.
func (manager *Manager) ReclaimByWindow(label string) (int, error) {
	if label == "" {
		return 0, i18n.Errorf("process.reclaimByWindow.needsLabel", nil)
	}

	manager.mu.Lock()
	claimed := make([]*session, 0, len(manager.sessions))
	for id, entry := range manager.sessions {
		if entry.owned && entry.window == label {
			claimed = append(claimed, entry)
			delete(manager.sessions, id)
		}
	}
	manager.mu.Unlock()

	// The count is what this window held; it is answered whether or not every
	// reaping succeeds, and a failure comes back beside it rather than instead.
	return len(claimed), manager.reapAll(claimed)
}

// ReapAll ends every child this manager owns.
//
// Nothing in the command surface does this, and a package that can be
// registered but never told to stop leaves every child alive past the app.
// A service that must outlive the app is spawned and tracked by its own
// supervisor, never through this API.
func (manager *Manager) ReapAll() (int, error) {
	manager.mu.Lock()
	claimed := make([]*session, 0, len(manager.sessions))
	for id, entry := range manager.sessions {
		claimed = append(claimed, entry)
		delete(manager.sessions, id)
	}
	manager.mu.Unlock()

	return len(claimed), manager.reapAll(claimed)
}

func (manager *Manager) reapAll(claimed []*session) error {
	sort.Slice(claimed, func(first, second int) bool { return claimed[first].id < claimed[second].id })
	var failures []error
	for _, entry := range claimed {
		if err := manager.reap(entry); err != nil {
			// One child that would not be reaped does not excuse the rest.
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (manager *Manager) lookup(id uint32) (*session, bool) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	entry, held := manager.sessions[id]
	return entry, held
}
