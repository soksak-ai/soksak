package process

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
)

// Spec is one child to start. Everything in it is already resolved: the path
// has been through the sidecar rules, the environment through the environment
// rules, and the secrets are already plaintext.
type Spec struct {
	Path string
	Args []string
	// Dir empty means the spawner's own default. An invented directory would
	// answer a question the caller did not ask.
	Dir string
	// Env is complete. It is never nil by the time it arrives at os/exec, because
	// a nil Env there means "read this process's environment".
	Env []string
	// Group requests a new process group so a kill covers the whole tree.
	Group bool
}

// Child is a started process, seen only through what this package needs.
type Child interface {
	PID() int
	Stdin() io.WriteCloser
	Stdout() io.ReadCloser
	Stderr() io.ReadCloser
	// Wait blocks until the direct child is reaped and answers its exit code.
	// Exactly one goroutine ever calls it.
	Wait() (int, error)
	// Signal ends the child — the whole group first when it was started as
	// one. It never waits; reaping is Wait's alone.
	Signal() error
}

// Spawner starts children. It is injected so the same manager answers in a
// window, in a headless server, and in a test that starts nothing at all.
type Spawner interface {
	Start(Spec) (Child, error)
}

// groupRefusal answers whether this host may honour a grouped spawn.
//
// It takes the platform fact as an argument so the rule itself is testable
// everywhere; the wiring is a build-tag constant, never a runtime.GOOS branch.
func groupRefusal(honoured bool, because string) error {
	if honoured {
		return nil
	}
	return fmt.Errorf("group was asked for and this host cannot honour it: %s — "+
		"spawning ungrouped instead would leave grandchildren holding the child's stdout after a kill", because)
}

// OSSpawner starts real processes.
type OSSpawner struct{}

func (OSSpawner) Start(spec Spec) (Child, error) {
	command := exec.Command(spec.Path, spec.Args...)
	command.Dir = spec.Dir
	command.Env = spec.Env
	if command.Env == nil {
		// os/exec reads this process's environment for a nil Env, which is the
		// one thing this package must never do.
		command.Env = []string{}
	}
	if spec.Group {
		applyGroup(command)
	}

	// The pipes are made here rather than with StdinPipe/StdoutPipe, because
	// exec.Cmd.Wait closes the ones it made — and here Wait runs in its own
	// goroutine while a reader is still draining the same pipe.
	var opened []*os.File
	closeOpened := func() {
		for _, file := range opened {
			_ = file.Close()
		}
	}
	pipe := func() (*os.File, *os.File, error) {
		read, write, err := os.Pipe()
		if err != nil {
			return nil, nil, err
		}
		opened = append(opened, read, write)
		return read, write, nil
	}

	stdinRead, stdinWrite, err := pipe()
	if err != nil {
		closeOpened()
		return nil, fmt.Errorf("stdin pipe for %s: %w", spec.Path, err)
	}
	stdoutRead, stdoutWrite, err := pipe()
	if err != nil {
		closeOpened()
		return nil, fmt.Errorf("stdout pipe for %s: %w", spec.Path, err)
	}
	stderrRead, stderrWrite, err := pipe()
	if err != nil {
		closeOpened()
		return nil, fmt.Errorf("stderr pipe for %s: %w", spec.Path, err)
	}
	command.Stdin, command.Stdout, command.Stderr = stdinRead, stdoutWrite, stderrWrite

	if err := command.Start(); err != nil {
		closeOpened()
		return nil, err
	}
	// The parent lets go of the child's own ends. Keeping them would mean EOF
	// never arrives, because this process would still be a writer.
	_ = stdinRead.Close()
	_ = stdoutWrite.Close()
	_ = stderrWrite.Close()

	return &osChild{
		command: command,
		group:   spec.Group,
		stdin:   stdinWrite,
		stdout:  stdoutRead,
		stderr:  stderrRead,
	}, nil
}

type osChild struct {
	command *exec.Cmd
	group   bool
	stdin   *os.File
	stdout  *os.File
	stderr  *os.File
}

func (child *osChild) PID() int              { return child.command.Process.Pid }
func (child *osChild) Stdin() io.WriteCloser { return child.stdin }
func (child *osChild) Stdout() io.ReadCloser { return child.stdout }
func (child *osChild) Stderr() io.ReadCloser { return child.stderr }

func (child *osChild) Wait() (int, error) {
	err := child.command.Wait()

	var exited *exec.ExitError
	if errors.As(err, &exited) {
		// A non-zero status is the child's answer, not a failure to wait.
		return exited.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return child.command.ProcessState.ExitCode(), nil
}

func (child *osChild) Signal() error {
	// The group goes first. Killing only the direct child leaves grandchildren
	// — an agent's own shell children — holding the stdout pipe, so EOF and the
	// exit event are hostage to their lifetime (measured: a stop's cancelled
	// close waited on a sleeping grandchild).
	//
	// The group is named even when the direct child has already been reaped,
	// which is exactly the case where a grandchild is the only writer left. A
	// process group id cannot be handed to a new group while the group still
	// has members, so this names this tree or nothing.
	if child.group {
		signalGroup(child.command.Process.Pid)
	}
	if err := child.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}
