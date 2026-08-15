package daemon

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/soksak/soksak-core/core/process"
)

// maxOnceBytes bounds what one run's captured output may cost this process.
//
// A run-once command is a build or a release step, and its output is held whole
// so the caller can parse it — release.build finds its summary line in there.
// Held whole with no bound, a command that loops printing takes the workspace
// down with it. Nothing above the bound is dropped quietly: the answer includes
// a line stating that the output was cut and by how many lines.
const maxOnceBytes = 8 << 20

// Once is what one run-to-completion answered.
type Once struct {
	// Code is null when the child left no code of its own — it was signalled,
	// or its status could not be read. Reporting 0 there would say it succeeded.
	Code *int `json:"code"`
	// Lines is stdout and stderr in arrival order, verbatim. Callers parse
	// them by prefix, so nothing is added to a line here.
	Lines []string `json:"lines"`
}

// collector holds one run's output under a bound.
type collector struct {
	mu      sync.Mutex
	lines   []string
	bytes   int
	dropped int
}

func (out *collector) keep(line string) {
	out.mu.Lock()
	defer out.mu.Unlock()

	if out.bytes+len(line) > maxOnceBytes {
		out.dropped++
		return
	}
	out.bytes += len(line)
	out.lines = append(out.lines, line)
}

func (out *collector) collected() []string {
	out.mu.Lock()
	defer out.mu.Unlock()

	// Never nil: a command that printed nothing and a build that could not
	// capture must not arrive as the same JSON null.
	lines := make([]string, 0, len(out.lines)+1)
	lines = append(lines, out.lines...)
	if out.dropped > 0 {
		lines = append(lines, fmt.Sprintf(
			"[soksak] %d further line(s) were not kept: the command printed more than %d bytes", out.dropped, maxOnceBytes))
	}
	return lines
}

// tail is the last few lines, for a failure that cannot carry all of them.
func (out *collector) tail(count int) string {
	lines := out.collected()
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return strings.Join(lines, "\n")
}

// RunOnce runs one command to completion under a deadline and answers its exit
// code with everything it printed.
//
// The deadline is a timer, and the exit is the child being reaped: both arrive
// as an event this waits on. Nothing here tests repeatedly whether the child is
// still there.
func (supervisor *Supervisor) RunOnce(root, cmd string, env map[string]string, timeout time.Duration) (Once, error) {
	program, args, err := daemonArgv(supervisor.deps.LoginShell, cmd)
	if err != nil {
		return Once{}, err
	}

	child, err := supervisor.deps.Spawner.Start(process.Spec{
		Path: program,
		Args: args,
		Dir:  root,
		Env:  supervisor.deps.Environment(env),
		// The same reason a daemon gets its own group: a timeout has to reach
		// what the shell line started, not only the shell.
		Group: true,
	})
	if err != nil {
		return Once{}, fmt.Errorf("running %q under %s: %w", cmd, root, err)
	}
	// The same reason a daemon's stdin is closed, with a sharper edge: a build
	// step that prompts would otherwise sit there until the deadline and be
	// reported as slow rather than as waiting for an answer.
	_ = child.Stdin().Close()

	out := &collector{}
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); pump(child.Stdout(), nil, out.keep) }()
	go func() { defer readers.Done(); pump(child.Stderr(), nil, out.keep) }()

	type ending struct {
		code int
		err  error
	}
	ended := make(chan ending, 1)
	go func() {
		code, err := child.Wait()
		ended <- ending{code: code, err: err}
	}()

	// The timer is left to fire on its own after a fast command. It closes a
	// channel nothing is reading by then, which costs one pending timer for the
	// rest of the timeout and keeps the seam a plain function a test can drive.
	deadline := make(chan struct{})
	supervisor.deps.After(timeout, func() { close(deadline) })

	select {
	case done := <-ended:
		// The pipes reach EOF once the child is gone. Waiting for the readers
		// is what makes the last line of a command's output part of the answer
		// rather than a race with it.
		readers.Wait()
		if done.err != nil {
			return Once{}, fmt.Errorf("running %q under %s: the child could not be reaped: %w", cmd, root, done.err)
		}
		answer := Once{Lines: out.collected()}
		if done.code >= 0 {
			code := done.code
			answer.Code = &code
		}
		return answer, nil

	case <-deadline:
		// Ending it is the point: a timeout that left the command running
		// would hand the caller a failure and keep the machine busy with the
		// work it failed at.
		_ = child.Signal()
		<-ended
		readers.Wait()
		return Once{}, fmt.Errorf("%q under %s did not finish within %s and was stopped; its last output was:\n%s",
			cmd, root, timeout, out.tail(10))
	}
}
