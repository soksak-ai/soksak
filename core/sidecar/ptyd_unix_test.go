//go:build !windows

package sidecar

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	controlwire "github.com/soksak/soksak-contract-control"
	"github.com/soksak/soksak-core/core/process"
)

// The real PTY daemon, driven the way a plugin drives it: opaquely.
//
// Everything between here and the shell is the product path: the unit is found where an install
// puts it, started, greeted with the token it announced, sent a request nobody here reads into, and
// streamed from. What is asserted is that a shell echoes what was typed into it, which is the one
// thing a person would check.
//
// The daemon is another repository's, so it is built from source and staged. That is deliberate: a
// stub speaking the same envelope would pass while the two drifted apart, and drift between a host
// and a unit is exactly what one envelope exists to prevent.
func TestARealShellEchoesThroughTheRelay(t *testing.T) {
	daemon := filepath.Join("..", "..", "..", "soksak-sidecars", "soksak-sidecar-pty")
	if _, err := os.Stat(daemon); err != nil {
		t.Skipf("the pty unit is not beside this checkout: %v", err)
	}
	home := shortHome(t)
	stagePTY(t, home, daemon)

	collected := &bytes{}
	host := NewHost(Deps{
		Home: home, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 15 * time.Second,
	})
	t.Cleanup(func() { host.StopAll() })

	// Opening is where the declaration is checked, and nothing travels to a unit that was not
	// opened. What is declared here is what the unit's own release states it implements, read off
	// disk — the two halves of declared-equals-actual, neither taken on the other's word.
	stated, err := ProvidedFromRelease(home)("pty")
	if err != nil {
		t.Fatalf("reading what the unit states it implements: %v", err)
	}
	if _, err := (Registration{Host: host, Provided: ProvidedFromRelease(home)}).
		openDeclared("pty", Requirement{ID: stated.ID, Range: stated.Version}); err != nil {
		t.Fatalf("opening the unit: %v", err)
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	opened, err := host.Send("pty", request("open", "pty.open", map[string]any{
		"request": map[string]any{
			"paneId": "pane-1", "cols": 80, "rows": 24, "shell": shell,
			"env": [][2]string{{"PATH", os.Getenv("PATH")}},
		},
	}))
	if err != nil {
		t.Fatalf("opening a session: %v", err)
	}
	if !opened.Ok {
		t.Fatalf("opening a session was refused: %s", opened.Error)
	}
	var session struct {
		Session  uint64 `json:"session"`
		ShellPID int    `json:"shellPid"`
	}
	if err := answerData(opened, &session); err != nil {
		t.Fatal(err)
	}
	if session.ShellPID <= 0 {
		t.Fatalf("the answer names no shell: %+v", session)
	}

	from := uint64(0)
	attached, stream, err := host.Stream("pty", request("attach", "pty.attach", map[string]any{
		"request": map[string]any{"session": session.Session, "fromSeq": from},
	}))
	if err != nil {
		t.Fatalf("attaching: %v", err)
	}
	if !attached.Ok {
		t.Fatalf("attaching was refused: %s", attached.Error)
	}
	go pump(stream, collected, "pty#1", DefaultReadSize)

	marker := "SOKSAK-RELAY-OK"
	written, err := host.Send("pty", request("write", "pty.write", map[string]any{
		"request": map[string]any{
			"session": session.Session,
			"dataB64": base64.StdEncoding.EncodeToString([]byte("echo " + marker + "\n")),
		},
	}))
	if err != nil {
		t.Fatalf("writing to the session: %v", err)
	}
	if !written.Ok {
		t.Fatalf("writing was refused: %s", written.Error)
	}

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(collected.text(), marker) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the shell never echoed %q through the relay. What arrived:\n%s", marker, collected.text())
}

// bytes is a sink that keeps what arrived, so the assertion is on delivered output rather than on a
// call having been made.
type bytes struct {
	mu   sync.Mutex
	seen strings.Builder
}

func (b *bytes) EmitSidecarBytes(chunk Bytes) Delivery {
	raw, err := base64.StdEncoding.DecodeString(chunk.DataBase64)
	if err != nil {
		return Gone
	}
	b.mu.Lock()
	b.seen.Write(raw)
	b.mu.Unlock()
	return Delivered
}

func (b *bytes) EmitSidecarEnd(End) Delivery { return Delivered }

func (b *bytes) text() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.seen.String()
}

func stagePTY(t *testing.T, home, source string) {
	t.Helper()
	unit := "soksak-sidecar-pty"
	target := filepath.Join(home, "sidecars", unit, "dist", unit)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-o", target, ".")
	build.Dir = source
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building the pty unit: %v\n%s", err, out)
	}
	// The release manifest is staged with the binary, because it is what states the contract the
	// unit implements. A staged binary with no release beside it is a unit nothing can be checked
	// against, and this is where an install would have put it.
	release := filepath.Join(home, "sidecars", unit, "release")
	if err := os.MkdirAll(release, 0o700); err != nil {
		t.Fatal(err)
	}
	declared, err := os.ReadFile(filepath.Join(source, "release", "unit.json"))
	if err != nil {
		t.Fatalf("reading the unit's release manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(release, "unit.json"), declared, 0o600); err != nil {
		t.Fatal(err)
	}
}

func request(id, command string, args map[string]any) controlwire.Request {
	encoded := make(map[string]json.RawMessage, len(args))
	for name, value := range args {
		raw, err := json.Marshal(value)
		if err != nil {
			panic(err)
		}
		encoded[name] = raw
	}
	return controlwire.Request{ID: id, Command: command, Args: encoded}
}

func answerData(response controlwire.Response, target any) error {
	raw, err := json.Marshal(response.Result)
	if err != nil {
		return err
	}
	var answer struct {
		Code string          `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return err
	}
	return json.Unmarshal(answer.Data, target)
}
