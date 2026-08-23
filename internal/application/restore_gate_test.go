package application

import (
	"debug/buildinfo"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
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

// The prefix names this gate's short runtime endpoint family. Persistent state is kept under the
// repository's declared .task/gates root; only the Unix socket uses <local-evidence> because sockaddr_un holds
// 104 bytes on macOS. State and endpoint are resolved together by identity, never guessed apart.
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
	runtime    string
	identifier string
	proc       *exec.Cmd
	// held is this process's end of the application's channel. It is written to never — what the
	// application reads is its close, which happens when this process ends by any route.
	held io.WriteCloser
	// log is where the application's own output went. Read it when the process stops answering: the
	// socket has only "the door is closed", and this has what happened behind it.
	log string
	// opened is every workspace window this gate asked for, in order. A whole-application command
	// goes to one of these rather than to `main`: the launch renderer retires itself once a
	// workspace window has declared its commands, so on any run that opens one, `main` is gone
	// before the gate is finished (measured 2026-08-20 — four gates ran to the end and never told
	// the application to stop).
	opened []string
}

var gateRunSequence atomic.Uint64

func reclaimRunDirectories(parent string) error {
	entries, err := os.ReadDir(parent)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		ownerText, _, found := strings.Cut(entry.Name(), "-")
		owner, parseErr := strconv.Atoi(ownerText)
		if !found || parseErr != nil || owner < 1 || pidAlive(owner) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(parent, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func reclaimGateState(root string) error {
	axes, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, axis := range axes {
		if !axis.IsDir() || axis.Type()&os.ModeSymlink != 0 {
			continue
		}
		if err := reclaimRunDirectories(filepath.Join(root, axis.Name())); err != nil {
			return err
		}
	}
	return nil
}

func TestGateHomesAreOwnedByOneRunAndNeverEraseAnotherRun(t *testing.T) {
	first := newGate(t, "<local-evidence>/soksak-idempotent-gate", "com.soksak.idempotentgate")
	marker := filepath.Join(first.home, "owned-by-first")
	if err := os.WriteFile(marker, []byte("first"), 0o644); err != nil {
		t.Fatalf("writing first run marker: %v", err)
	}
	second := newGate(t, "<local-evidence>/soksak-idempotent-gate", "com.soksak.idempotentgate")
	if first.home == second.home {
		t.Fatalf("two runs were handed the same home: %s", first.home)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("starting the second run erased the first run's owned state: %v", err)
	}
}

func TestGateStartupReclaimsOnlyRunsWhoseOwnerIsDead(t *testing.T) {
	root := t.TempDir()
	dead := filepath.Join(root, "99999999-1")
	live := filepath.Join(root, strconv.Itoa(os.Getpid())+"-1")
	for _, path := range []string{dead, live} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatalf("making fixture %s: %v", path, err)
		}
	}
	if err := reclaimRunDirectories(root); err != nil {
		t.Fatalf("reclaiming dead gate runs: %v", err)
	}
	if _, err := os.Stat(dead); !os.IsNotExist(err) {
		t.Fatalf("dead run was not reclaimed: %v", err)
	}
	if _, err := os.Stat(live); err != nil {
		t.Fatalf("live run was touched: %v", err)
	}
}

func TestGateRejectsForeignBinaryBeforeStart(t *testing.T) {
	target := "linux"
	if runtime.GOOS == "linux" {
		target = "windows"
	}
	path := filepath.Join(t.TempDir(), "sok")
	command := exec.Command("go", "build", "-o", path, "./cmd/sok")
	command.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+target, "GOARCH=amd64")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("building foreign client: %v\n%s", err, output)
	}
	if err := requireHostBinary(path); err == nil || !strings.Contains(err.Error(), "built for "+target+"/amd64") {
		t.Fatalf("foreign client error = %v", err)
	}
}

// socket is the address the identity derives from the home and the identifier:
// `<home>/.soksak-<axis>/<identifier>.sock`. Derived here rather than asked for,
// because the application has to be answering before it can be asked anything.
//
// homePrefix names the gate and supplies the platform's short runtime root. Persistent state is
// discovered from the repository and placed under .task/gates. PID plus invocation sequence makes
// both paths deterministic and collision-free without random temp directories.
func newGate(t *testing.T, homePrefix string, identifier string) *restoreGate {
	t.Helper()
	app := filepath.Join("bin", "soksak")
	client := filepath.Join("bin", "sok")
	for _, binary := range []string{app, client} {
		if _, err := os.Stat(binary); err != nil {
			t.Skipf("%s is not built; run `wails3 task build` and `wails3 task build:sok` first", binary)
		}
		if err := requireHostBinary(binary); err != nil {
			t.Fatalf("%s is not executable on this host: %v", binary, err)
		}
	}
	root, err := filepath.Abs(filepath.Join(".task", "gates"))
	if err != nil {
		t.Fatalf("resolving the declared gate state root: %v", err)
	}
	if err := reclaimGateState(root); err != nil {
		t.Fatalf("reclaiming dead gate state under %s: %v", root, err)
	}
	sequence := gateRunSequence.Add(1)
	run := strconv.Itoa(os.Getpid()) + "-" + strconv.FormatUint(sequence, 10)
	axis := strings.TrimPrefix(identifier, "com.soksak.")
	home := filepath.Join(root, axis, run)
	runtimeRoot := filepath.Join(filepath.Dir(homePrefix), "soksak-gate-runtime", run)
	if err := reclaimRunDirectories(filepath.Dir(runtimeRoot)); err != nil {
		t.Fatalf("reclaiming dead gate runtime endpoints: %v", err)
	}
	for _, directory := range []string{home, runtimeRoot} {
		if !filepath.IsAbs(directory) {
			t.Fatalf("gate path is not absolute: %s", directory)
		}
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatalf("creating run-owned gate path %s: %v", directory, err)
		}
	}
	gate := &restoreGate{t: t, app: app, client: client, home: home, runtime: runtimeRoot, identifier: identifier}
	if err := os.MkdirAll(gate.installationHome(), 0o700); err != nil {
		t.Fatalf("creating installation home: %v", err)
	}
	settings := []byte(`{"revision":1,"plugins":{},"sidecars":{},"kits":{},"contracts":{},"specs":{}}`)
	if err := os.WriteFile(filepath.Join(gate.installationHome(), "environment.json"), settings, 0o600); err != nil {
		t.Fatalf("writing installation settings: %v", err)
	}
	t.Cleanup(func() {
		gate.quit()
		_ = os.RemoveAll(home)
		_ = os.RemoveAll(runtimeRoot)
	})
	return gate
}

func requireHostBinary(path string) error {
	info, err := buildinfo.ReadFile(path)
	if err != nil {
		return err
	}
	values := map[string]string{}
	for _, setting := range info.Settings {
		if setting.Key == "GOOS" || setting.Key == "GOARCH" {
			values[setting.Key] = setting.Value
		}
	}
	if values["GOOS"] == "" || values["GOARCH"] == "" {
		return fmt.Errorf("Go build target is absent")
	}
	if values["GOOS"] != runtime.GOOS || !hostArchCompatible(values["GOARCH"]) {
		return fmt.Errorf("built for %s/%s; host is %s/%s", values["GOOS"], values["GOARCH"], runtime.GOOS, runtime.GOARCH)
	}
	return nil
}

func hostArchCompatible(arch string) bool {
	if arch == runtime.GOARCH {
		return true
	}
	if runtime.GOOS != "darwin" || arch != "arm64" {
		return false
	}
	output, err := exec.Command("sysctl", "-n", "hw.optional.arm64").Output()
	return err == nil && strings.TrimSpace(string(output)) == "1"
}

// installationHome is where this identity keeps what it owns — the same derivation the application
// makes from its identifier, written once so the gate and the application cannot disagree about it.
func (gate *restoreGate) installationHome() string {
	axis := strings.TrimPrefix(gate.identifier, "com.soksak.")
	return filepath.Join(gate.home, ".soksak-"+axis)
}

func (gate *restoreGate) socket() string {
	return filepath.Join(gate.runtime, gate.identifier+".sock")
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
		"SOKSAK_HOME="+gate.installationHome(),
		"SOKSAK_IDENTIFIER="+gate.identifier,
		"SOKSAK_RUNTIME="+gate.runtime,
		// Nobody is watching this one. Nine of these start over a verify run, and each took the
		// front and a dock icon until 2026-08-20 — a person at the machine had nine windows arrive
		// over what they were doing. It still draws and is still captured; it does not activate.
		"SOKSAK_UNATTENDED=1",
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
	// The channel the application reads to know this process is still here. Nothing is written on
	// it; the far end closing is the message, and that happens on its own when this process dies by
	// any route — including the ones that skip quit(): an interrupt, a timeout, a panic.
	//
	// Measured 2026-08-20, before this: three applications from earlier runs were still up, the
	// oldest an hour and seventeen minutes, each holding a window and a home nothing could reach.
	held, err := cmd.StdinPipe()
	if err != nil {
		gate.t.Fatalf("opening the application's channel: %v", err)
	}
	gate.held = held
	if err := cmd.Start(); err != nil {
		gate.t.Fatalf("starting the application: %v", err)
	}
	gate.proc = cmd
	gate.t.Cleanup(func() { _ = log.Close() })

	// Polled, because there is nothing yet to wait on: a process that has not opened its socket
	// publishes nothing, and the first thing this run can be told is an answer to a command. Every
	// wait after this one is on an event the window announces.
	deadline := time.Now().Add(45 * time.Second)
	lastOutput := ""
	var lastError error
	for time.Now().Before(deadline) {
		out, err := gate.try("window_list", "window=main")
		lastOutput, lastError = out, err
		if err == nil && strings.Contains(out, "win-") {
			return
		}
		time.Sleep(startupPollInterval)
	}
	gate.t.Fatalf("the application did not answer within 45s: %v\n%s%s", lastError, lastOutput, gate.lastWords())
}

// quit ends the process through the command, never by killing it. A kill skips
// the drain and the save, and the run after it would be measuring a crash.
func (gate *restoreGate) quit() {
	if gate.proc == nil {
		return
	}
	// The channel goes with the process it named. Left open, this gate's own end outlives the run
	// inside the test binary and the next gate's application sees a spawner that is still there.
	if gate.held != nil {
		_ = gate.held.Close()
		gate.held = nil
	}
	// What the command answered, kept. A refused shutdown — an unknown command, a window that had
	// already gone — and an accepted one that did nothing are the same twenty seconds from here,
	// and the answer is the only thing between them.
	answer, answerErr := gate.try("app.shutdown.commit", "window="+gate.answeringWindow())
	done := make(chan struct{})
	go func() { _ = gate.proc.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		_ = gate.proc.Process.Kill()
		<-done
		// Everything the gate already held. Measured 2026-08-20: four gates failed here at once,
		// each after its own body had passed, and the report said only that twenty seconds had gone
		// by — while the answer, the application's output and the shutdown's own counters were all
		// in hand. A refusal names what is missing, and so must a death.
		refusal := ""
		if answerErr != nil {
			refusal = fmt.Sprintf("\n  the command was refused: %v", answerErr)
		}
		gate.t.Fatalf("app.shutdown.commit did not end the process within 20s.%s"+
			"\n  it answered: %s\n  the application's last words:\n%s",
			refusal, strings.TrimSpace(answer), gate.lastWords())
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

// answeringWindow is the window a whole-application command is asked of.
//
// The last workspace this gate opened, or `main` when it has opened none. The fallback is the other
// half of the retirement rule: `main` closes only once a workspace renderer is ready, so before
// there is one it is the only window there is.
func (gate *restoreGate) answeringWindow() string {
	if len(gate.opened) == 0 {
		out, err := gate.try("window_list", "window=main")
		if err == nil {
			var response struct {
				Data []string `json:"data"`
			}
			if json.Unmarshal([]byte(out), &response) == nil && len(response.Data) > 0 {
				return response.Data[0]
			}
		}
		return "main"
	}
	return gate.opened[len(gate.opened)-1]
}

func (gate *restoreGate) openWorkspace() string {
	gate.t.Helper()
	gate.until(45*time.Second, func() bool {
		_, err := gate.try("app.boot.wait", "window="+gate.answeringWindow())
		return err == nil
	}, "control-plane window never declared its commands")
	root, err := filepath.Abs(".")
	if err != nil {
		gate.t.Fatalf("resolving a workspace root: %v", err)
	}
	// Opened without focus. window.open takes it by default, which is right for a person clicking
	// and wrong for a run: it takes the machine from whoever is at it, and it makes every gate that
	// opens a window contend with every other for the front. Coming to the front is a deliberate
	// act here — layout_scenarios requests it behind SOKSAK_GATE_FRONT and nothing else does.
	out := gate.run("window.open", "window="+gate.answeringWindow(), "root="+root, "focus=false")
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
	gate.opened = append(gate.opened, answer.Data.Label)
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
