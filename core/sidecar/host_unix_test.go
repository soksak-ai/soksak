//go:build !windows

package sidecar

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/process"
)

// A real unit is started, announces itself, answers a request, and streams bytes.
//
// The unit here is a program built for this test rather than a fake in memory. What is being checked
// is the boundary a caller actually meets — a process that has to be found on disk, started, waited
// on for one line, connected to, and ended — and a fake would pass with the announcement unflushed,
// with nothing bound, and with the child unreaped.
func TestAUnitIsStartedByItsAnnouncementAndRelayedTo(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)

	host := NewHost(Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial:        dialUnix,
		ReadyWithin: 10 * time.Second,
		ResolveUnit: testSidecarResolver(home),
		ResolveBindings: func() (map[string]string, error) {
			return map[string]string{"soksak-sidecar-pty": "soksakv7-sidecar-pty"}, nil
		},
	})
	t.Cleanup(func() { host.StopAll() })

	open, err := host.Start("fake-unit")
	if err != nil {
		t.Fatalf("starting the unit: %v", err)
	}
	if open.PID <= 0 {
		t.Fatalf("the unit was started and named no process: %+v", open)
	}
	if open.Protocol != controlwire.Protocol {
		t.Fatalf("the unit announced protocol %d, this build speaks %d", open.Protocol, controlwire.Protocol)
	}
	// The address is what the unit said, never what this process derived. A unit that binds
	// somewhere else stays reachable because it said so.
	if open.Address != filepath.Join(runtimeRoot, "fake-unit.sock") {
		t.Fatalf("the unit announced %q, which is not where it says it bound", open.Address)
	}

	// Starting again answers with the same process rather than a second one behind one name.
	again, err := host.Start("fake-unit")
	if err != nil {
		t.Fatalf("starting an already open unit: %v", err)
	}
	if again.PID != open.PID {
		t.Fatalf("a second start made a second process: %d then %d", open.PID, again.PID)
	}
	if err := host.Release("fake-unit"); err != nil {
		t.Fatalf("releasing a channel: %v", err)
	}
	started := host.Started()
	if len(started) != 1 || started[0].PID != open.PID {
		t.Fatalf("channel release removed the process from the host: %+v", started)
	}
	answer, err := host.Send("fake-unit", controlwire.Request{ID: "1", Command: "fake-unit.echo"})
	if err != nil {
		t.Fatalf("sending to the unit: %v", err)
	}
	if !answer.Ok || answer.ID != "1" {
		t.Fatalf("the unit refused or lost the correlation id: %+v", answer)
	}

	streamed, bytes, err := host.Stream("fake-unit", controlwire.Request{ID: "2", Command: "fake-unit.stream"})
	if err != nil {
		t.Fatalf("opening a stream: %v", err)
	}
	if !streamed.Ok {
		t.Fatalf("the unit refused the stream: %s", streamed.Error)
	}
	defer func() { _ = bytes.Close() }()
	got, err := io.ReadAll(bytes)
	if err != nil {
		t.Fatalf("reading the stream: %v", err)
	}
	if string(got) != "STREAMED-BYTES" {
		t.Fatalf("the stream carried %q", got)
	}

	// Stopping reaps. A unit still running after the host let go is the failure this whole boundary
	// exists to make visible.
	// Stop signals and the watcher reaps, so the reading that the unit is gone is the connection refusing —
	// the same reading the host itself takes, and the one a caller would take. Looking at a pid on a
	// timer would report a zombie as alive and a reaped one as gone at whatever moment the loop
	// happened to look.
	pid := open.PID
	if err := host.Stop("fake-unit"); err != nil {
		t.Fatalf("stopping the unit: %v", err)
	}
	if !processGone(pid) {
		t.Fatalf("unit process %d still exists after Stop returned", pid)
	}
}

func TestStartedObserverReceivesEverySelectedProcessGeneration(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	resolved, err := testSidecarResolver(home)("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	path := resolved.Path
	host := NewHost(Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second,
	})
	t.Cleanup(func() { host.StopAll() })
	observer, exposed := any(host).(interface {
		ObserveStarted(func(Open)) func()
	})
	if !exposed {
		t.Fatal("sidecar Host does not expose selected process generations")
	}
	var mu sync.Mutex
	var selected []Open
	cancel := observer.ObserveStarted(func(open Open) {
		mu.Lock()
		selected = append(selected, open)
		mu.Unlock()
	})
	defer cancel()

	first, err := host.StartResolvedWithSecrets("fake-unit", "0.0.1", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := host.StartResolvedWithSecrets("fake-unit", "0.0.2", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if first.PID == second.PID || len(selected) != 2 {
		t.Fatalf("selected generations=%+v, first=%d second=%d", selected, first.PID, second.PID)
	}
	if selected[0].PID != first.PID || selected[1].PID != second.PID {
		t.Fatalf("observer order=%+v, first=%d second=%d", selected, first.PID, second.PID)
	}
}

func TestConcurrentStartsShareOneProcess(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	host := NewHost(Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	})
	t.Cleanup(func() { host.StopAll() })
	type result struct {
		open Open
		err  error
	}
	start := make(chan struct{})
	results := make(chan result, 7)
	for range 7 {
		go func() {
			<-start
			open, err := host.Start("fake-unit")
			results <- result{open: open, err: err}
		}()
	}
	close(start)
	pid := 0
	for range 7 {
		got := <-results
		if got.err != nil {
			t.Fatalf("concurrent start failed: %v", got.err)
		}
		if pid == 0 {
			pid = got.open.PID
		} else if got.open.PID != pid {
			t.Fatalf("concurrent starts returned different processes: %d and %d", pid, got.open.PID)
		}
	}
}

func TestStatusSeparatesRunningStderrFromEndedFailureByGeneration(t *testing.T) {
	host := NewHost(Deps{})
	running := &unit{open: Open{Name: "running", PID: 11, Version: "0.0.2"}, stderr: newRing(4)}
	running.stderr.add("broken client pipe")
	host.open["running"] = running
	ended := &unit{open: Open{Name: "ended", PID: 22, Version: "0.0.1"}, stderr: newRing(4)}
	ended.stderr.add("provider crashed")
	host.recordEndedComplaint("ended", ended)

	registry := control.NewRegistry()
	Register(registry, Registration{
		Host:    host,
		Resolve: func(Consumer, DependencyReference) (Resolved, error) { return Resolved{}, nil },
	})
	answer, err := registry.Invoke("sidecar_status", control.Args{})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	type record struct {
		Name    string   `json:"name"`
		PID     int      `json:"pid"`
		Version string   `json:"version"`
		Stderr  []string `json:"stderr"`
	}
	var status struct {
		Stderr map[string][]string `json:"stderr"`
		Open   []record            `json:"open"`
		Ended  []record            `json:"ended"`
	}
	if err := json.Unmarshal(encoded, &status); err != nil {
		t.Fatal(err)
	}
	if status.Stderr != nil {
		t.Fatalf("ambiguous stderr remained: %+v", status.Stderr)
	}
	if len(status.Open) != 1 || status.Open[0].Name != "running" || status.Open[0].PID != 11 || status.Open[0].Version != "0.0.2" || len(status.Open[0].Stderr) != 1 || status.Open[0].Stderr[0] != "broken client pipe" {
		t.Fatalf("open=%+v", status.Open)
	}
	if len(status.Ended) != 1 || status.Ended[0].Name != "ended" || status.Ended[0].PID != 22 || status.Ended[0].Version != "0.0.1" || len(status.Ended[0].Stderr) != 1 || status.Ended[0].Stderr[0] != "provider crashed" {
		t.Fatalf("ended=%+v", status.Ended)
	}
}

// A unit that prints ordinary output announces nothing, and this build reports that rather than waiting.
//
// The first line is spent. Waiting for a later one would be waiting for a line that will never be
// about an address, and the caller would read a working unit as a slow one.
func TestAUnitWhoseFirstLineIsOutputAnnouncesNothing(t *testing.T) {
	home := shortHome(t)
	stageUnit(t, home, "chatty", chattySource)

	host := NewHost(Deps{
		Home: home, Runtime: shortHome(t), Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 5 * time.Second, ResolveUnit: testSidecarResolver(home),
	})
	t.Cleanup(func() { host.StopAll() })

	_, err := host.Start("chatty")
	if err == nil {
		t.Fatal("a unit that announced nothing was reported ready")
	}
	if !strings.Contains(err.Error(), "announced nothing") {
		t.Fatalf("the refusal does not state what was wrong: %v", err)
	}
	// The line it did print is quoted, because a reader looking at this refusal needs to see what
	// the unit said instead of an announcement — without it, the only way to find out is to run the
	// unit by hand.
	if !strings.Contains(err.Error(), `"starting up"`) {
		t.Fatalf("the refusal does not quote what the unit printed instead: %v", err)
	}
	// And it states that no later line will do, so nobody waits for one.
	if !strings.Contains(err.Error(), "first line is the only announcement") {
		t.Fatalf("the refusal does not state that the first line is spent: %v", err)
	}
}

func TestAChildExitBeforeAnnouncementReportsItsExitCode(t *testing.T) {
	home := shortHome(t)
	stageUnit(t, home, "exits", exitSource)
	host := NewHost(Deps{
		Home: home, Runtime: shortHome(t), Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 5 * time.Second, ResolveUnit: testSidecarResolver(home),
	})
	_, err := host.Start("exits")
	if err == nil || !strings.Contains(err.Error(), "exit code 37") {
		t.Fatalf("sidecar exit lost its status: %v", err)
	}
}

// An announced protocol this build does not speak is refused at the greeting, not later.
func TestAnEnvelopeMismatchIsRefusedAtTheAnnouncement(t *testing.T) {
	home := shortHome(t)
	stageUnit(t, home, "future", futureSource)

	host := NewHost(Deps{
		Home: home, Runtime: shortHome(t), Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 5 * time.Second, ResolveUnit: testSidecarResolver(home),
	})
	t.Cleanup(func() { host.StopAll() })

	_, err := host.Start("future")
	if err == nil {
		t.Fatal("a unit speaking another envelope was accepted")
	}
	if !strings.Contains(err.Error(), "envelope protocol") {
		t.Fatalf("the refusal does not name the mismatch: %v", err)
	}
}

// shortHome is a home whose name leaves room for a socket path.
//
// A unix socket address is a fixed-size field, and the default temporary directory on this platform
// is long enough on its own to overrun it.
func shortHome(t *testing.T) string {
	t.Helper()
	home, err := os.MkdirTemp("<local-evidence>", "sc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	return home
}

// stageUnit builds a program and puts it where an installed unit's entry point is.
func stageUnit(t *testing.T, home, name, source string) {
	t.Helper()
	build := t.TempDir()
	if err := os.WriteFile(filepath.Join(build, "main.go"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	moduleBody, err := os.ReadFile(filepath.Join("..", "..", "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	goDirective := regexp.MustCompile(`(?m)^go ([0-9]+\.[0-9]+\.[0-9]+)$`).FindSubmatch(moduleBody)
	if len(goDirective) != 2 {
		t.Fatal("root go.mod must contain one exact Go version")
	}
	if err := os.WriteFile(filepath.Join(build, "go.mod"), []byte("module fake-unit\n\ngo "+string(goDirective[1])+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The layout is written out here rather than taken from SidecarPath, because SidecarPath checks
	// every component as it walks and answers with what is missing — which is what it is for, and
	// which means it cannot name a path that does not exist yet.
	unit := "soksak-sidecar-" + name
	target := filepath.Join(home, "sidecars", unit, "dist", unit)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("go", "build", "-o", target, ".")
	command.Dir = build
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("building the unit: %v\n%s", err, out)
	}
	// And then it is asked, so a staged unit this host could not find fails here rather than as a
	// refusal three calls later.
}

func testSidecarResolver(home string) func(string) (Resolved, error) {
	return func(name string) (Resolved, error) {
		path := filepath.Join(home, "sidecars", "soksak-sidecar-"+name, "dist", "soksak-sidecar-"+name)
		info, err := os.Lstat(path)
		if err != nil {
			return Resolved{}, err
		}
		if !info.Mode().IsRegular() {
			return Resolved{}, fmt.Errorf("test sidecar is not a regular file: %s", path)
		}
		return Resolved{Name: name, Version: "0.0.1", Path: path}, nil
	}
}

func dialUnix(address string) (io.ReadWriteCloser, error) {
	return net.Dial("unix", address)
}

func alive(pid int) bool {
	found, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return found.Signal(nil) == nil
}

// The programs below are units, not fakes. Each is compiled and run.

const fakeUnitSource = `package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
)

func main() {
	flag.String("home", "", "")
	runtimeRoot := flag.String("runtime", "", "")
	flag.Parse()
	run := *runtimeRoot
	os.MkdirAll(run, 0o700)
	address := filepath.Join(run, "fake-unit.sock")
	os.Remove(address)
	listener, err := net.Listen("unix", address)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	processLabel := os.Getenv("SOKSAK_PROCESS_LABEL")
	if os.Getenv("SOKSAK_SIDECAR_NAME") != "soksak-sidecar-fake-unit" {
		fmt.Fprintln(os.Stderr, "own sidecar name was not declared")
		os.Exit(1)
	}
	var bindings map[string]string
	if json.Unmarshal([]byte(os.Getenv("SOKSAK_SIDECAR_BINDINGS")), &bindings) != nil {
		fmt.Fprintln(os.Stderr, "sidecar dependency bindings were not declared")
		os.Exit(1)
	}
	line, _ := json.Marshal(map[string]any{"protocol": 2, "socket": address, "processLabel": processLabel})
	fmt.Println(string(line))
	os.Stdout.Sync()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			reader := bufio.NewReader(conn)
			// A connection answers every request on it, not one. The greeting is a request like any
			// other, so a unit that answered once would close under the caller's first command.
			for {
				raw, err := reader.ReadBytes('\n')
				if err != nil {
					return
				}
				var request struct {
					ID      string ` + "`json:\"id\"`" + `
					Command string ` + "`json:\"command\"`" + `
				}
				json.Unmarshal(raw, &request)
				result := map[string]any{"code": "OK"}
				if request.Command == "system.hello" {
					result = map[string]any{"protocol": 2, "processLabel": processLabel}
				}
				answer, _ := json.Marshal(map[string]any{"id": request.ID, "ok": true, "result": result})
				conn.Write(append(answer, '\n'))
				if request.Command == "fake-unit.stream" {
					conn.Write([]byte("STREAMED-BYTES"))
					return
				}
			}
		}()
	}
}
`

const chattySource = `package main

import (
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	flag.String("home", "", "")
	flag.String("runtime", "", "")
	flag.Parse()
	fmt.Println("starting up")
	os.Stdout.Sync()
	time.Sleep(30 * time.Second)
}
`

const exitSource = `package main

import "os"

func main() { os.Exit(37) }
`

const futureSource = `package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	flag.String("home", "", "")
	flag.String("runtime", "", "")
	flag.Parse()
	line, _ := json.Marshal(map[string]any{"protocol": 99, "socket": "<local-evidence>/never", "processLabel": os.Getenv("SOKSAK_PROCESS_LABEL")})
	fmt.Println(string(line))
	os.Stdout.Sync()
	time.Sleep(30 * time.Second)
}
`

// waitUntilUnreachable answers when nothing is listening at an address any more.
//
// A connect either succeeds or fails, so this is an event rather than a look: it is the same reading
// the host takes to decide whether a recorded unit is still there, which is what makes it the right
// one to assert on.
func waitUntilUnreachable(address string, within time.Duration) error {
	deadline := time.Now().Add(within)
	for {
		conn, err := dialUnix(address)
		if err != nil {
			return nil
		}
		_ = conn.Close()
		if time.Now().After(deadline) {
			return fmt.Errorf("something still answers at %s after %s", address, within)
		}
	}
}
