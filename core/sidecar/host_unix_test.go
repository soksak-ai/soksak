//go:build !windows

package sidecar

import (
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	controlwire "github.com/soksak/soksak-contract-control"
	"github.com/soksak/soksak-core/core/process"
)

// A real unit is started, announces itself, answers a request, and streams bytes.
//
// The unit here is a program built for this test rather than a fake in memory. What is being checked
// is the boundary a caller actually meets — a process that has to be found on disk, started, waited
// on for one line, connected to, and ended — and a fake would pass with the announcement unflushed,
// with nothing bound, and with the child unreaped.
func TestAUnitIsStartedByItsAnnouncementAndRelayedTo(t *testing.T) {
	home := shortHome(t)
	stageUnit(t, home, "probe", probeSource)

	host := NewHost(Deps{
		Home: home, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial:        dialUnix,
		ReadyWithin: 10 * time.Second,
	})
	t.Cleanup(func() { host.StopAll() })

	open, err := host.Start("probe")
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
	if open.Address != filepath.Join(home, "run", "probe.sock") {
		t.Fatalf("the unit announced %q, which is not where it says it bound", open.Address)
	}

	// Starting again answers with the same process rather than a second one behind one name.
	again, err := host.Start("probe")
	if err != nil {
		t.Fatalf("starting an already open unit: %v", err)
	}
	if again.PID != open.PID {
		t.Fatalf("a second start made a second process: %d then %d", open.PID, again.PID)
	}

	answer, err := host.Send("probe", controlwire.Request{ID: "1", Command: "probe.echo"})
	if err != nil {
		t.Fatalf("sending to the unit: %v", err)
	}
	if !answer.Ok || answer.ID != "1" {
		t.Fatalf("the unit refused or lost the correlation id: %+v", answer)
	}

	streamed, bytes, err := host.Stream("probe", controlwire.Request{ID: "2", Command: "probe.stream"})
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
	pid := open.PID
	if err := host.Stop("probe"); err != nil {
		t.Fatalf("stopping the unit: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !alive(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("unit process %d is still running after the host stopped it", pid)
}

// A unit that prints ordinary output announces nothing, and this build reports that rather than waiting.
//
// The first line is spent. Waiting for a later one would be waiting for a line that will never be
// about an address, and the caller would read a working unit as a slow one.
func TestAUnitWhoseFirstLineIsOutputAnnouncesNothing(t *testing.T) {
	home := shortHome(t)
	stageUnit(t, home, "chatty", chattySource)

	host := NewHost(Deps{
		Home: home, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 5 * time.Second,
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

// An announced protocol this build does not speak is refused at the greeting, not later.
func TestAnEnvelopeMismatchIsRefusedAtTheAnnouncement(t *testing.T) {
	home := shortHome(t)
	stageUnit(t, home, "future", futureSource)

	host := NewHost(Deps{
		Home: home, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 5 * time.Second,
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
	if err := os.WriteFile(filepath.Join(build, "go.mod"), []byte("module probe\n\ngo 1.25.0\n"), 0o600); err != nil {
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
	if found, err := process.SidecarPath(home, name); err != nil || found != target {
		t.Fatalf("the staged unit is not where the layout says: %q %v", found, err)
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

const probeSource = `package main

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
	home := flag.String("home", "", "")
	flag.Parse()
	run := filepath.Join(*home, "run")
	os.MkdirAll(run, 0o700)
	address := filepath.Join(run, "probe.sock")
	os.Remove(address)
	listener, err := net.Listen("unix", address)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	line, _ := json.Marshal(map[string]any{"protocol": 1, "socket": address})
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
				answer, _ := json.Marshal(map[string]any{"id": request.ID, "ok": true, "result": map[string]any{"code": "OK"}})
				conn.Write(append(answer, '\n'))
				if request.Command == "probe.stream" {
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
	flag.Parse()
	fmt.Println("starting up")
	os.Stdout.Sync()
	time.Sleep(30 * time.Second)
}
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
	flag.Parse()
	line, _ := json.Marshal(map[string]any{"protocol": 99, "socket": "<local-evidence>/never"})
	fmt.Println(string(line))
	os.Stdout.Sync()
	time.Sleep(30 * time.Second)
}
`
