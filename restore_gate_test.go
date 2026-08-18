package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The digest before a restart equals the digest after.
//
// docs/tech/RESTORE.md V1: that equality is the whole verdict, and V2 adds that
// one cold restart is not the measurement. It had no gate — the number was read
// by hand and written into the document, so it was true on the day someone
// looked and unowned every day after.
//
// It could not have had one until 2026-08-16, because quitting was not a command
// this build served: `sok app.shutdown.commit` answered INTERNAL and the only
// way to end the process was to kill it. A gate that killed the process would
// skip the drain and the save, and would then be measuring a crash rather than a
// restart.
//
// This runs the real binaries against a home of its own, so it neither reads nor
// disturbs the store a person is using.

// restoreGateHome is short on purpose. A unix socket path has 104 bytes on this
// platform and the identity derives one from the home, so a home under the
// repository or under a test temp directory overruns it and the application
// refuses to start with a message about path length rather than about restore.
const restoreGateHome = "<local-evidence>/soksak-restore-gate"

const restoreGateIdentifier = "com.soksak.restoregate"

func TestTheDigestSurvivesARestart(t *testing.T) {
	app := filepath.Join("bin", "soksak")
	client := filepath.Join("bin", "sok")
	for _, binary := range []string{app, client} {
		if _, err := os.Stat(binary); err != nil {
			t.Skipf("%s is not built; run `wails3 task build` and `wails3 task build:sok` first", binary)
		}
	}
	if os.Getenv("DISPLAY") == "" && os.Getenv("HOME") == "" {
		t.Skip("no session to open a window in")
	}

	gate := newGate(t, restoreGateHome, restoreGateIdentifier)
	gate.start()
	window := gate.openWorkspace()

	before := gate.fingerprint(window)

	gate.quit()
	gate.start()
	// The restored window declares its commands again, and the restore itself is
	// what this gate is here to read — so it is waited for exactly as the first
	// one was.
	gate.awaitWindow(window)

	after := gate.fingerprint(window)

	if before.Digest == "" || before.IDs == "" {
		t.Fatalf("state.fingerprint answered no digest: %+v", before)
	}
	// Two numbers, because there are two questions (RESTORE V1). The shape is
	// what a person sees; the identifiers are what things are, and a terminal
	// session is keyed by the window label and the pane id — a pane back under a
	// new name has lost its shell while every rectangle is where it was.
	//
	// Read from the command rather than compared here. A gate that assembled its
	// own verdict would be a second rule about the same restart, and the two
	// would disagree the day one of them was edited.
	if before.Digest != after.Digest {
		t.Errorf("the shape moved across a restart: %s then %s", before.Digest, after.Digest)
	}
	if before.IDs != after.IDs {
		t.Errorf("the identifiers moved across a restart: %s then %s", before.IDs, after.IDs)
	}
}

// One harness, used by every gate that has to ask a running build something. A second copy would be
// a second answer to "how is the application started and quit", and the two would disagree the day
// one of them was edited.
type restoreGate struct {
	t          *testing.T
	app        string
	client     string
	home       string
	identifier string
	proc       *exec.Cmd
	// log is where the application's own output went. Read it when the process stops answering: the
	// socket has only "the door is closed", and this has what happened behind it.
	log string
}

// quietGate is the same harness under the name its own gate reads by.
type quietGate = restoreGate

func newQuietGate(t *testing.T) *quietGate {
	return newGate(t, quietGateHome, quietGateIdentifier)
}

// socket is the address the identity derives from the home and the identifier:
// `<home>/.soksak-<axis>/<identifier>.sock`. Derived here rather than asked for,
// because the application has to be answering before it can be asked anything.
// newGate prepares a home of its own, emptied first: a reading taken against a
// store some earlier run left behind is a reading about that run.
func newGate(t *testing.T, home string, identifier string) *restoreGate {
	t.Helper()
	app := filepath.Join("bin", "soksak")
	client := filepath.Join("bin", "sok")
	for _, binary := range []string{app, client} {
		if _, err := os.Stat(binary); err != nil {
			t.Skipf("%s is not built; run `wails3 task build` and `wails3 task build:sok` first", binary)
		}
	}
	gate := &restoreGate{t: t, app: app, client: client, home: home, identifier: identifier}
	if err := os.RemoveAll(home); err != nil {
		t.Fatalf("clearing the gate home: %v", err)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("creating the gate home: %v", err)
	}
	t.Cleanup(func() {
		gate.quit()
		_ = os.RemoveAll(home)
	})
	return gate
}

// installPlugins puts the sibling plugins in the gate's home, the same two files `task
// install:plugins` copies. A gate that ran against an empty home would be asking a build with
// nothing in it how it is, and every question about a plugin would answer "no such program".
func (gate *restoreGate) installPlugins() []string {
	gate.t.Helper()
	// The same roots `task install:plugins` copies from. A gate that installs a different set than
	// the installation measures a build nobody runs — the section plugin is kept in the development
	// tree and the two built here are siblings.
	var sources []string
	for _, pattern := range []string{
		filepath.Join("..", "soksak-plugins", "*"),
		filepath.Join(os.Getenv("HOME"), ".soksak-dev", "plugins", "soksak-plugin-file-tree"),
	} {
		found, err := filepath.Glob(pattern)
		if err != nil {
			gate.t.Fatalf("looking for the plugins to install: %v", err)
		}
		sources = append(sources, found...)
	}
	var installed []string
	for _, source := range sources {
		name := filepath.Base(source)
		manifest := filepath.Join(source, "plugin.json")
		bundle := filepath.Join(source, "main.js")
		if _, err := os.Stat(manifest); err != nil {
			continue
		}
		target := filepath.Join(gate.installationHome(), "plugins", name)
		if err := os.MkdirAll(target, 0o755); err != nil {
			gate.t.Fatalf("making the plugin directory: %v", err)
		}
		for _, file := range []string{manifest, bundle} {
			body, err := os.ReadFile(file)
			if err != nil {
				gate.t.Fatalf("reading %s: %v", file, err)
			}
			if err := os.WriteFile(filepath.Join(target, filepath.Base(file)), body, 0o644); err != nil {
				gate.t.Fatalf("writing %s: %v", file, err)
			}
		}
		marker := filepath.Join(target, ".soksak.json")
		if err := os.WriteFile(marker, []byte(`{"version":"0.0.1","source":"local"}`), 0o644); err != nil {
			gate.t.Fatalf("writing the install marker: %v", err)
		}
		installed = append(installed, name)
	}
	if len(installed) == 0 {
		gate.t.Skip("no sibling plugin is built; run `wails3 task install:plugins` first")
	}
	return installed
}

// consentAndEnable is the human act a plugin needs before it runs, performed through the same
// commands a person's click goes through. A gate that skipped it would measure a build with every
// plugin off, which is not the build anybody runs.
func (gate *restoreGate) consentAndEnable(window string, plugins []string) {
	gate.t.Helper()
	for _, id := range plugins {
		gate.run("plugin.consent.grant", "window="+window, "id="+id)
		if out, err := gate.try("plugin.enable", "window="+window, "id="+id); err != nil {
			gate.t.Fatalf("enabling %s: %v\n%s\nWhat the refusal says is the reason; an exit status is not one.", id, err, out)
		}
	}
}

// installationHome is where this identity keeps what it owns — the same derivation the application
// makes from its identifier, written once so the gate and the application cannot disagree about it.
func (gate *restoreGate) installationHome() string {
	axis := strings.TrimPrefix(gate.identifier, "com.soksak.")
	return filepath.Join(gate.home, ".soksak-"+axis)
}

func (gate *restoreGate) socket() string {
	return filepath.Join(gate.installationHome(), gate.identifier+".sock")
}

// start runs the application against the gate's home and waits until its control
// plane answers. Waiting on the answer rather than on a duration is what makes
// this repeatable on a loaded machine.
// startupPollInterval is the gap between one poll and the next. Two places have nothing to wait on
// and use it: a process that has not answered yet, and the loop for a fact the window announces
// nothing about. Each of those states its own reason where it is.
const startupPollInterval = 250 * time.Millisecond

func (gate *restoreGate) start() {
	gate.t.Helper()
	cmd := exec.Command("./" + gate.app)
	cmd.Env = append(os.Environ(),
		"HOME="+gate.home,
		"SOKSAK_IDENTIFIER="+gate.identifier,
	)
	// The application's own output, kept. Thrown away, a process that dies leaves the gate holding
	// "connection refused" and nothing about why — measured 2026-08-18, the app died mid-run three
	// times in six and the panic that killed it went nowhere. A refusal names what is missing, and
	// so must a death.
	log, err := os.Create(filepath.Join(gate.home, "application.log"))
	if err != nil {
		gate.t.Fatalf("making the application's log: %v", err)
	}
	gate.log = log.Name()
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		gate.t.Fatalf("starting the application: %v", err)
	}
	gate.proc = cmd
	gate.t.Cleanup(func() { _ = log.Close() })

	// Polled, because there is nothing yet to wait on: a process that has not opened its socket
	// publishes nothing, and the first thing this run can be told is an answer to a command. Every
	// wait after this one is on an event the window announces.
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		if out, err := gate.try("window.list", "window=main"); err == nil && strings.Contains(out, "main") {
			return
		}
		time.Sleep(startupPollInterval)
	}
	gate.t.Fatal("the application did not answer within 45s")
}

// quit ends the process through the command, never by killing it. A kill skips
// the drain and the save, and the run after it would be measuring a crash.
func (gate *restoreGate) quit() {
	if gate.proc == nil {
		return
	}
	_, _ = gate.try("app.shutdown.commit", "window=main")
	done := make(chan struct{})
	go func() { _ = gate.proc.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		_ = gate.proc.Process.Kill()
		<-done
		gate.t.Fatal("app.shutdown.commit did not end the process within 20s")
	}
	gate.proc = nil
}

// awaitWindow waits until one window answers its own commands and its layout has
// settled.
//
// Both waits end on an event inside the window; reaching the first takes a poll,
// because a window that has not declared its commands has no command to
// subscribe to and nothing outside the process publishes its arrival.
func (gate *restoreGate) awaitWindow(label string) {
	gate.t.Helper()
	gate.until(45*time.Second, func() bool {
		_, err := gate.try("app.boot.wait", "window="+label)
		return err == nil
	}, "window "+label+" never declared its commands")
	gate.run("ui.layout.wait-settled", "window="+label)
}

// until waits for a condition, or fails by the name of what never happened.
func (gate *restoreGate) until(limit time.Duration, ready func() bool, what string) {
	gate.t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(startupPollInterval)
	}
	gate.t.Fatalf("%s within %s", what, limit)
}

// lastWords is what the application said before it stopped, or nothing when it is still answering.
// A dead backend and a refused command look the same from the socket; this is the difference.
func (gate *restoreGate) lastWords() string {
	if gate.log == "" {
		return ""
	}
	body, err := os.ReadFile(gate.log)
	if err != nil || len(body) == 0 {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(body), "\n"), "\n")
	// A crash states its reason on the first line and spends the rest on where it was. Kept from
	// the tail, the reason is what falls off — measured 2026-08-18, forty lines of register values
	// and the sentence that named the fault was gone.
	for index, line := range lines {
		if strings.HasPrefix(line, "panic:") || strings.HasPrefix(line, "fatal error:") ||
			strings.HasPrefix(line, "signal ") || strings.Contains(line, "SIGSEGV") ||
			strings.Contains(line, "SIGABRT") {
			lines = lines[index:]
			break
		}
	}
	if len(lines) > 60 {
		lines = lines[:60]
	}
	return "\nthe application's last words:\n" + strings.Join(lines, "\n") + "\n"
}

// activate clicks a tab and returns once the window that click opened has closed.
//
// The stimulus is stamped with its own cause, and layout.transaction.wait waits for that one
// transaction after the journal sequence the click was issued at. Both halves are needed: the id
// picks the transaction, and the sequence bounds it to a later one — without that a caller can be
// answered by the transaction the previous click left in the journal.
//
// What was here read the arrangement every 250ms and called the window settled when two readings
// agreed, with a floor to wait out the motions that had not started yet. That is true of a window
// that has finished, of one whose motion the readings straddled, and of one that has not begun; it
// passed most runs and failed three of six under load. A gate that passes because two samples
// landed together is not a gate.
func (gate *restoreGate) activate(window string, tab string, cause string) {
	gate.t.Helper()
	at := gate.journalSequence(window)
	out := gate.run("tab.activate", "window="+window, "tab="+tab, "causeTraceId="+cause)
	var answer struct {
		Data struct {
			Moved        bool   `json:"moved"`
			CauseTraceID string `json:"causeTraceId"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("reading what tab.activate did: %v\n%s", err, out)
	}
	// Only a click that moved the screen has a transaction to wait for. Clicking the pane already
	// active changes nothing and opens none — waiting for one there waits out a timeout and calls
	// it a defect.
	if answer.Data.Moved {
		if answer.Data.CauseTraceID != cause {
			gate.t.Fatalf("tab.activate moved the screen and answered cause %q, not %q\n%s",
				answer.Data.CauseTraceID, cause, out)
		}
		waited, err := gate.try("layout.transaction.wait", "window="+window,
			"causeTraceId="+cause, "afterSequence="+strconv.Itoa(at), "timeoutMs=8000")
		if err != nil {
			gate.t.Fatalf("the transaction %s opened never closed: %v\n%s%s\n"+
				"Every reading after this describes a frame of the way there.",
				cause, err, waited, gate.lastWords())
		}
	} else if answer.Data.CauseTraceID != "" {
		gate.t.Fatalf("tab.activate moved nothing and still answered a cause %q — there is no "+
			"transaction to find it on\n%s", answer.Data.CauseTraceID, out)
	}
	// The transaction is closed; the frame it produced is what the next reading is of.
	gate.run("ui.layout.wait-settled", "window="+window)
}

// journalSequence is the newest entry in the layout journal right now, so a wait can name a
// transaction later than every one already in it.
func (gate *restoreGate) journalSequence(window string) int {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Entries []struct {
				Sequence int `json:"sequence"`
			} `json:"entries"`
		} `json:"data"`
	}
	out := gate.run("layout.transactions", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("reading the layout journal of %s: %v\n%s", window, err, out)
	}
	highest := 0
	for _, entry := range answer.Data.Entries {
		if entry.Sequence > highest {
			highest = entry.Sequence
		}
	}
	return highest
}

func (gate *restoreGate) try(command string, args ...string) (string, error) {
	full := append([]string{"--socket", gate.socket(), command}, args...)
	out, err := exec.Command("./"+gate.client, full...).CombinedOutput()
	return string(out), err
}

func (gate *restoreGate) run(command string, args ...string) string {
	gate.t.Helper()
	out, err := gate.try(command, args...)
	if err != nil {
		gate.t.Fatalf("%s: %v\n%s%s", command, err, out, gate.lastWords())
	}
	return out
}

// openWorkspace gives the restore something to carry: a window with a layout of
// its own. An empty orchestrator restores nothing and the digest would be equal
// for the wrong reason.
// programs are what the registry answers, so the gate opens what this build actually offers rather
// than a list written here that would go stale the day a plugin is added.
func (gate *restoreGate) programs(window string) []string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Programs []struct {
				ID string `json:"id"`
			} `json:"programs"`
		} `json:"data"`
	}
	out := gate.run("program.list", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("program.list: %v\n%s", err, out)
	}
	ids := make([]string, 0, len(answer.Data.Programs))
	for _, p := range answer.Data.Programs {
		ids = append(ids, p.ID)
	}
	return ids
}

// open puts a program in a tab and waits for the answer to name one. The gate does the ordinary
// things a person does before asking the application how it is: a build that only ever opened an
// empty window would be asked nothing about what a plugin does.
func (gate *restoreGate) open(window string, program string) string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			TabID string `json:"tabId"`
		} `json:"data"`
	}
	out := gate.run("tab.open", "window="+window, "program="+program)
	if err := json.Unmarshal([]byte(out), &answer); err != nil || answer.Data.TabID == "" {
		gate.t.Fatalf("tab.open %s named no tab: %v\n%s", program, err, out)
	}
	return answer.Data.TabID
}

func (gate *restoreGate) openWorkspace() string {
	gate.t.Helper()
	root, err := filepath.Abs(".")
	if err != nil {
		gate.t.Fatalf("resolving a workspace root: %v", err)
	}
	// Opened without focus. window.open takes it by default, which is right for a person clicking
	// and wrong for a run: it takes the machine from whoever is at it, and it makes every gate that
	// opens a window contend with every other for the front. Coming to the front is a deliberate
	// act here — layout_scenarios requests it behind SOKSAK_GATE_FRONT and nothing else does.
	out := gate.run("window.open", "window=main", "root="+root, "focus=false")
	var answer struct {
		Data struct {
			Label string `json:"label"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil || answer.Data.Label == "" {
		gate.t.Fatalf("window.open named no window: %v\n%s", err, out)
	}
	// A window answers its own commands only once its page has declared them, and
	// the snapshot it must have written before the quit is written from the
	// layout. Both waits below end on an event inside the window; reaching the
	// first one takes a poll, because a window that has not declared its
	// commands has no command to subscribe to and nothing outside the process
	// publishes its arrival.
	gate.awaitWindow(answer.Data.Label)
	return answer.Data.Label
}

// fingerprintOf is what `state.fingerprint` answers: the shape and the identifiers.
type fingerprint struct {
	Digest string `json:"digest"`
	IDs    string `json:"ids"`
}

func (gate *restoreGate) fingerprint(window string) fingerprint {
	gate.t.Helper()
	var answer struct {
		Data fingerprint `json:"data"`
	}
	out := gate.run("state.fingerprint", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("state.fingerprint: %v\n%s", err, out)
	}
	return answer.Data
}
