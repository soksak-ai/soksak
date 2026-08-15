package daemon

import (
	"io"
	"sync"
	"time"

	"github.com/soksak/soksak-core/core/process"
)

// The stubs every test in this package drives its daemons through.
//
// Nothing here starts a real process. The rules under test are about what this
// build does with a child — when it reads readiness, what it keeps, what it
// ends and what it refuses — and a real `sleep 1` would replace those questions
// with a race against the machine.

// stubSpawner hands out children the test writes into by hand.
type stubSpawner struct {
	mu       sync.Mutex
	specs    []process.Spec
	children []*stubChild
	fail     error
	nextPID  int
	// appeared hands each new child to a test that has to drive it while the
	// call that started it is still blocked on it.
	appeared chan *stubChild
}

func (spawner *stubSpawner) Start(spec process.Spec) (process.Child, error) {
	spawner.mu.Lock()

	if spawner.fail != nil {
		spawner.mu.Unlock()
		return nil, spawner.fail
	}
	spawner.nextPID++
	child := newStubChild(1000 + spawner.nextPID)
	spawner.specs = append(spawner.specs, spec)
	spawner.children = append(spawner.children, child)
	appeared := spawner.appeared
	spawner.mu.Unlock()

	if appeared != nil {
		appeared <- child
	}
	return child, nil
}

func (spawner *stubSpawner) started() []process.Spec {
	spawner.mu.Lock()
	defer spawner.mu.Unlock()
	return append([]process.Spec(nil), spawner.specs...)
}

func (spawner *stubSpawner) child(index int) *stubChild {
	spawner.mu.Lock()
	defer spawner.mu.Unlock()
	return spawner.children[index]
}

// stubChild is a process the test speaks for.
type stubChild struct {
	pid    int
	stdout *io.PipeReader
	stderr *io.PipeReader
	toOut  *io.PipeWriter
	toErr  *io.PipeWriter

	ending sync.Once
	ended  chan struct{}

	mu        sync.Mutex
	code      int
	signals   int
	signalErr error
	stdin     nowhere
}

func newStubChild(pid int) *stubChild {
	outRead, outWrite := io.Pipe()
	errRead, errWrite := io.Pipe()
	return &stubChild{
		pid:    pid,
		stdout: outRead,
		stderr: errRead,
		toOut:  outWrite,
		toErr:  errWrite,
		ended:  make(chan struct{}),
	}
}

func (child *stubChild) PID() int              { return child.pid }
func (child *stubChild) Stdin() io.WriteCloser { return &child.stdin }
func (child *stubChild) Stdout() io.ReadCloser { return child.stdout }
func (child *stubChild) Stderr() io.ReadCloser { return child.stderr }

func (child *stubChild) Wait() (int, error) {
	<-child.ended
	child.mu.Lock()
	defer child.mu.Unlock()
	return child.code, nil
}

func (child *stubChild) Signal() error {
	child.mu.Lock()
	child.signals++
	err := child.signalErr
	child.mu.Unlock()
	if err != nil {
		return err
	}
	// A signalled process leaves no exit code of its own, which is the whole
	// reason the status row carries a null rather than a zero.
	child.exit(-1)
	return nil
}

func (child *stubChild) signalled() int {
	child.mu.Lock()
	defer child.mu.Unlock()
	return child.signals
}

// say writes lines to the child's stdout. The write only returns once the
// reader has taken the bytes, so a test that says something and then ends the
// child cannot lose the line.
func (child *stubChild) say(lines ...string) {
	for _, line := range lines {
		_, _ = io.WriteString(child.toOut, line+"\n")
	}
}

func (child *stubChild) complain(lines ...string) {
	for _, line := range lines {
		_, _ = io.WriteString(child.toErr, line+"\n")
	}
}

func (child *stubChild) exit(code int) {
	child.ending.Do(func() {
		child.mu.Lock()
		child.code = code
		child.mu.Unlock()
		_ = child.toOut.Close()
		_ = child.toErr.Close()
		close(child.ended)
	})
}

// nowhere is a stdin that records only whether it was closed.
type nowhere struct {
	mu     sync.Mutex
	closed bool
}

func (writer *nowhere) Write(p []byte) (int, error) { return len(p), nil }

func (writer *nowhere) Close() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.closed = true
	return nil
}

func (child *stubChild) stdinClosed() bool {
	child.stdin.mu.Lock()
	defer child.stdin.mu.Unlock()
	return child.stdin.closed
}

// stubClock is the epoch-millisecond clock the tests move by hand.
type stubClock struct {
	mu sync.Mutex
	at int64
}

func (clock *stubClock) now() int64 {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.at
}

func (clock *stubClock) advance(by int64) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.at += by
}

// stubTimer holds the deadlines a test fires itself.
type stubTimer struct {
	mu    sync.Mutex
	fires []func()
	asked []time.Duration
	// armed reports every deadline as it is asked for, so a test can wait for
	// the code under test to be waiting rather than race it.
	armed chan time.Duration
}

func (timer *stubTimer) after(wait time.Duration, fire func()) {
	timer.mu.Lock()
	timer.asked = append(timer.asked, wait)
	timer.fires = append(timer.fires, fire)
	armed := timer.armed
	timer.mu.Unlock()

	if armed != nil {
		select {
		case armed <- wait:
		default:
		}
	}
}

// fire runs the deadlines armed so far, and only those. A deadline armed while
// these run waits for the next call, which is what keeps a repeating job from
// firing itself forever inside one test.
func (timer *stubTimer) fire() {
	timer.mu.Lock()
	fires := append([]func(){}, timer.fires...)
	timer.fires = nil
	timer.mu.Unlock()
	for _, fire := range fires {
		fire()
	}
}

func (timer *stubTimer) deadlines() []time.Duration {
	timer.mu.Lock()
	defer timer.mu.Unlock()
	return append([]time.Duration(nil), timer.asked...)
}

// testDeps is a fully wired host: a spawner, a shell, a clock, an environment
// rule and a listener.
func testDeps(spawner *stubSpawner, clock *stubClock, timer *stubTimer) (Deps, chan Daemon) {
	announced := make(chan Daemon, 16)
	return Deps{
		Spawner:    spawner,
		LoginShell: "/bin/zsh",
		Environment: func(overrides map[string]string) []string {
			env := []string{"PATH=/usr/bin"}
			for name, value := range overrides {
				env = append(env, name+"="+value)
			}
			return env
		},
		Now:      clock.now,
		After:    timer.after,
		Announce: func(row Daemon) { announced <- row },
	}, announced
}
