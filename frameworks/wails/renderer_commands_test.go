package wails

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/soksak/soksak-core/core/control"
)

// page is a stand-in for one window's document: it records what was delivered
// to it and lets a test answer on that window's behalf.
type page struct {
	mu        sync.Mutex
	requests  []rendererRequest
	receipts  []RendererDeclaration
	unreached map[string]bool
	arrived   chan rendererRequest
}

func newPage() *page {
	return &page{unreached: map[string]bool{}, arrived: make(chan rendererRequest, 8)}
}

func (p *page) deliver(window, event string, payload any) error {
	p.mu.Lock()
	if p.unreached[window] {
		p.mu.Unlock()
		return errUnreachable
	}
	switch event {
	case rendererRequestEvent:
		request := payload.(rendererRequest)
		p.requests = append(p.requests, request)
		p.mu.Unlock()
		p.arrived <- request
		return nil
	case rendererReceiptEvent:
		p.receipts = append(p.receipts, payload.(RendererDeclaration))
	}
	p.mu.Unlock()
	return nil
}

// errUnreachable is what a delivery answers for a window this process no longer
// holds — the same shape the real one answers with.
var errUnreachable = errors.New("this process holds no such window")

// lastWindow is which window the most recent request was delivered to.
func (p *page) lastWindow() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.requests) == 0 {
		return ""
	}
	return p.requests[len(p.requests)-1].Window
}

// lastReceipt answers what a window was last told about its declaration.
func (p *page) lastReceipt(t *testing.T, window string) RendererDeclaration {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	for index := len(p.receipts) - 1; index >= 0; index-- {
		if p.receipts[index].Window == window {
			return p.receipts[index]
		}
	}
	t.Fatalf("window %s was never told what it holds", window)
	return RendererDeclaration{}
}

func exclusionFor(declaration RendererDeclaration, name string) (RendererExclusion, bool) {
	for _, exclusion := range declaration.Excluded {
		if exclusion.Name == name {
			return exclusion, true
		}
	}
	return RendererExclusion{}, false
}

func holds(declaration RendererDeclaration, name string) bool {
	for _, held := range declaration.Held {
		if held == name {
			return true
		}
	}
	return false
}

// bridged builds a registry with the bridge on it and a page to answer for.
func bridged(t *testing.T) (*control.Registry, *RendererCommands, *page) {
	t.Helper()
	registry := control.NewRegistry()
	document := newPage()
	bridge := RegisterRendererCommands(registry, document.deliver)
	// Short enough that a test that means to wait one out finishes, long enough
	// that a scheduled goroutine is not mistaken for a silent page.
	bridge.deadline = 250 * time.Millisecond
	return registry, bridge, document
}

// answerOnce replies to the next request delivered to the page.
func answerOnce(t *testing.T, registry *control.Registry, document *page, envelope string) {
	t.Helper()
	go func() {
		request := <-document.arrived
		_, err := registry.Invoke(rendererReplyCommand, control.Args{
			"id":     json.RawMessage(itoa(request.ID)),
			"result": json.RawMessage(envelope),
		})
		if err != nil {
			t.Errorf("%s: %v", rendererReplyCommand, err)
		}
	}()
}

func itoa(value uint64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestADeclaredNameAnswersBareAndAddressed(t *testing.T) {
	// The point of the bridge: a command only the page implements becomes one
	// entry on the one table, reachable with no window involved.
	registry, bridge, document := bridged(t)
	if err := bridge.Declare("main", []string{"ui.tree"}); err != nil {
		t.Fatalf("Declare: %v", err)
	}

	answerOnce(t, registry, document, `{"ok":true,"code":"OK","message":"one pane","data":{"panes":1}}`)
	result, err := registry.InvokeFrom(control.Caller{Window: "main"}, "ui.tree", nil)
	if err != nil {
		t.Fatalf("ui.tree: %v", err)
	}
	envelope := result.(map[string]any)
	if envelope["message"] != "one pane" {
		t.Errorf("the whole envelope did not come back: %v", envelope)
	}

	answerOnce(t, registry, document, `{"ok":true,"code":"OK","message":"one pane"}`)
	if _, err := registry.InvokeFrom(control.Caller{Window: "main"}, "ui.tree", nil); err != nil {
		t.Errorf("win/main/ui.tree: %v", err)
	}

	document.mu.Lock()
	defer document.mu.Unlock()
	for _, request := range document.requests {
		if request.Method != "ui.tree" {
			t.Errorf("the page was asked for %q rather than the name it serves", request.Method)
		}
		if request.Window != "main" {
			t.Errorf("the request named window %q", request.Window)
		}
	}
}

func TestTheArgumentsReachThePageUntouched(t *testing.T) {
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.measure"})

	answerOnce(t, registry, document, `{"ok":true,"code":"OK","message":""}`)
	_, err := registry.InvokeFrom(control.Caller{Window: "main"}, "ui.measure", control.Args{"address": json.RawMessage(`"win/main/chrome"`)})
	if err != nil {
		t.Fatalf("ui.measure: %v", err)
	}

	document.mu.Lock()
	defer document.mu.Unlock()
	if got := string(document.requests[0].Params["address"]); got != `"win/main/chrome"` {
		t.Errorf("the page received %s", got)
	}
}

func TestTheBackendMintsTheCorrelationID(t *testing.T) {
	// A page-supplied id is forgeable, and two windows would collide on it. The
	// id is minted here and handed to exactly one page.
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})
	_ = bridge.Declare("win-a", []string{"ui.tree"})

	answerOnce(t, registry, document, `{"ok":true,"code":"OK","message":"main"}`)
	if _, err := registry.InvokeFrom(control.Caller{Window: "main"}, "ui.tree", nil); err != nil {
		t.Fatalf("win/main/ui.tree: %v", err)
	}
	answerOnce(t, registry, document, `{"ok":true,"code":"OK","message":"win-a"}`)
	if _, err := registry.InvokeFrom(control.Caller{Window: "win-a"}, "ui.tree", nil); err != nil {
		t.Fatalf("win/win-a/ui.tree: %v", err)
	}

	document.mu.Lock()
	defer document.mu.Unlock()
	if len(document.requests) != 2 {
		t.Fatalf("the page received %d requests", len(document.requests))
	}
	if document.requests[0].ID == document.requests[1].ID {
		t.Errorf("two windows were handed the same id %d", document.requests[0].ID)
	}
}

func TestAnAnswerNobodyIsWaitingForIsRefusedByItsID(t *testing.T) {
	// A page whose answers are being dropped must find that out rather than
	// believe it replied.
	registry, _, _ := bridged(t)
	_, err := registry.Invoke(rendererReplyCommand, control.Args{
		"id":     json.RawMessage(`4242`),
		"result": json.RawMessage(`{"ok":true,"code":"OK","message":""}`),
	})
	if err == nil {
		t.Fatal("an answer for an unknown id was accepted")
	}
	if !strings.Contains(err.Error(), "4242") {
		t.Errorf("the refusal did not carry the id: %v", err)
	}
}

func TestASilentWindowTimesOutCarryingTheWindowAndCommand(t *testing.T) {
	// A window that never replies must not hold the caller forever: the socket
	// answers one request at a time, so one silent page would stop the whole
	// control plane rather than one command.
	registry, bridge, _ := bridged(t)
	_ = bridge.Declare("win-a", []string{"ui.tree"})

	_, err := registry.InvokeFrom(control.Caller{Window: "win-a"}, "ui.tree", nil)
	if err == nil {
		t.Fatal("a silent window answered")
	}
	if !strings.Contains(err.Error(), "win-a") || !strings.Contains(err.Error(), "ui.tree") {
		t.Errorf("the timeout named neither the window nor the command: %v", err)
	}
}

func TestAWindowThatClosesStopsAnsweringAndReleasesItsCallers(t *testing.T) {
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("win-a", []string{"ui.tree"})

	failed := make(chan error, 1)
	go func() {
		_, err := registry.InvokeFrom(control.Caller{Window: "win-a"}, "ui.tree", nil)
		failed <- err
	}()
	<-document.arrived
	if err := bridge.Withdraw("win-a"); err != nil {
		t.Fatalf("Withdraw: %v", err)
	}

	select {
	case err := <-failed:
		if err == nil {
			t.Fatal("a call to a closed window succeeded")
		}
		if !strings.Contains(err.Error(), "win-a") || !strings.Contains(err.Error(), "ui.tree") {
			t.Errorf("the failure named neither the window nor the command: %v", err)
		}
	case <-time.After(bridge.deadline):
		// Waiting out the deadline is the defect: the window is gone, and that
		// is known now rather than in twenty seconds.
		t.Fatal("the caller waited for the deadline instead of being released")
	}

	if _, err := registry.InvokeFrom(control.Caller{Window: "main"}, "ui.tree", nil); err == nil {
		t.Error("a closed window's name still answers")
	}
	if _, err := registry.InvokeFrom(control.Caller{Window: "win-a"}, "ui.tree", nil); err == nil {
		t.Error("a closed window's addressed name still answers")
	}
}

func TestReloadingReplacesTheWholeCatalogue(t *testing.T) {
	// A page that reloaded has a new catalogue. A name it no longer serves must
	// stop answering rather than point at a page that is gone.
	registry, bridge, _ := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree", "ui.old"})
	_ = bridge.Declare("main", []string{"ui.tree", "ui.new"})

	if _, err := registry.Invoke("ui.old", nil); err == nil {
		t.Error("a name from the previous catalogue still answers")
	}
	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	if !served["ui.new"] {
		t.Errorf("the new catalogue is not on the table: %v", registry.Describe().Commands)
	}
}

func TestASecondWindowServingTheSameNameIsNotRefused(t *testing.T) {
	// Every window serves the same catalogue, so a name is one entry and the
	// window is an argument. The rejected shape put the window in the name and
	// refused every bare name to every window after the first — measured
	// 2026-08-15, the second window held 0 of 250.
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})
	_ = bridge.Declare("win-a", []string{"ui.tree"})

	for _, window := range []string{"main", "win-a"} {
		receipt := document.lastReceipt(t, window)
		if !holds(receipt, "ui.tree") {
			t.Errorf("%s was not told it holds ui.tree: %+v", window, receipt)
		}
		if len(receipt.Excluded) != 0 {
			t.Errorf("%s excluded declarations: %+v", window, receipt.Excluded)
		}
	}

	answerOnce(t, registry, document, `{"ok":true,"code":"OK","message":"second"}`)
	result, err := registry.Invoke("ui.tree", callArgs(t, map[string]any{"window": "win-a"}))
	if err != nil {
		t.Fatalf("naming the second window: %v", err)
	}
	if result.(map[string]any)["message"] != "second" {
		t.Errorf("the request reached the wrong window: %v", result)
	}
}

func TestAClosedWindowLeavesTheNameForTheOnesStillServingIt(t *testing.T) {
	// The name is the bridge's, not a window's. Withdrawing a window must not
	// take away a name the remaining windows still answer — `sok ui.tree` would
	// then say "not registered" while a window on screen serves it.
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})
	_ = bridge.Declare("win-a", []string{"ui.tree"})
	_ = bridge.Withdraw("main")

	answerOnce(t, registry, document, `{"ok":true,"code":"OK","message":"survivor"}`)
	result, err := registry.Invoke("ui.tree", callArgs(t, map[string]any{"window": "win-a"}))
	if err != nil {
		t.Fatalf("ui.tree: %v", err)
	}
	if result.(map[string]any)["message"] != "survivor" {
		t.Errorf("the request reached the wrong window: %v", result)
	}

	// And the window that closed answers nothing, by name.
	if _, err := registry.Invoke("ui.tree", callArgs(t, map[string]any{"window": "main"})); err == nil {
		t.Error("a window that closed still answered")
	}
}

func TestADeclarationCannotShadowWhatThisProcessServes(t *testing.T) {
	// Two answers under one name is the drift a single registry exists to
	// prevent, and the local one is the one with a test. The page is told, by
	// name — a refusal it never hears is a page that believes it is reachable.
	registry, bridge, document := bridged(t)
	registry.MustRegister(control.Command{
		Name:    "app_environment",
		Handler: func(control.Args) (any, error) { return "local", nil },
	})

	if err := bridge.Declare("main", []string{"app_environment"}); err != nil {
		t.Fatalf("Declare: %v", err)
	}

	exclusion, excluded := exclusionFor(document.lastReceipt(t, "main"), "app_environment")
	if !excluded {
		t.Fatal("the page was told nothing about a name this process serves")
	}
	if exclusion.Reason != "provided by process" {
		t.Errorf("exclusion reason = %q", exclusion.Reason)
	}

	result, err := registry.Invoke("app_environment", nil)
	if err != nil || result != "local" {
		t.Errorf("the local command stopped answering: %v, %v", result, err)
	}
}

func TestTheGreetingIsNotDelegatable(t *testing.T) {
	// The socket answers system.hello before the registry sees it, so a
	// delegation would be accepted and never reached — a name on the table that
	// nothing routes to.
	_, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{control.HelloCommand, "ui.tree"})

	receipt := document.lastReceipt(t, "main")
	if _, excluded := exclusionFor(receipt, control.HelloCommand); !excluded {
		t.Fatalf("%s was accepted as a bare name: %+v", control.HelloCommand, receipt)
	}
	if !holds(receipt, "ui.tree") {
		t.Error("one reserved name cost the window the rest of its catalogue")
	}
}

func TestARefusalFromThePageArrivesAsAFailure(t *testing.T) {
	// A refusal is a failed command: `sok` exits non-zero on it, and the page's
	// own code and message travel with it.
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.measure"})

	answerOnce(t, registry, document, `{"ok":false,"code":"NOT_EXPOSED","message":"no such node"}`)
	_, err := registry.InvokeFrom(control.Caller{Window: "main"}, "ui.measure", nil)
	if err == nil {
		t.Fatal("a refusal came back as a result")
	}
	for _, carried := range []string{"main", "ui.measure", "NOT_EXPOSED", "no such node"} {
		if !strings.Contains(err.Error(), carried) {
			t.Errorf("the failure did not carry %q: %v", carried, err)
		}
	}
}

func TestAnAnswerWithNoVerdictIsNotReadAsSuccess(t *testing.T) {
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})

	answerOnce(t, registry, document, `{"data":{"panes":1}}`)
	_, err := registry.InvokeFrom(control.Caller{Window: "main"}, "ui.tree", nil)
	if err == nil {
		t.Fatal("an answer that never said whether it succeeded was read as success")
	}
	if !strings.Contains(err.Error(), "ui.tree") {
		t.Errorf("the failure did not name the command: %v", err)
	}
}

func TestAWindowThatCannotBeReachedFailsByName(t *testing.T) {
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("win-a", []string{"ui.tree"})
	document.mu.Lock()
	document.unreached["win-a"] = true
	document.mu.Unlock()

	_, err := registry.InvokeFrom(control.Caller{Window: "win-a"}, "ui.tree", nil)
	if err == nil {
		t.Fatal("a command reached a window that is not there")
	}
	if !strings.Contains(err.Error(), "win-a") || !strings.Contains(err.Error(), "ui.tree") {
		t.Errorf("the failure named neither the window nor the command: %v", err)
	}
}

func TestADeclarationWithNoWindowIsRefused(t *testing.T) {
	// The window name is stamped by the framework, so an empty one means the
	// event did not come from a page. Attributing it to nobody would put names
	// on the table that nothing can answer.
	_, bridge, _ := bridged(t)
	if err := bridge.DeclareFrom("", map[string]any{"names": []any{"ui.tree"}}); err == nil {
		t.Fatal("a declaration with no window was accepted")
	}
}

func TestADeclarationThatCarriesNoNamesIsRefusedRatherThanReadAsEmpty(t *testing.T) {
	// An empty catalogue and a malformed payload are different answers. Read as
	// the first, the second would silently withdraw every command the window
	// serves.
	_, bridge, _ := bridged(t)
	err := bridge.DeclareFrom("main", map[string]any{"commands": []any{"ui.tree"}})
	if err == nil {
		t.Fatal("a declaration with no names list was read as a catalogue")
	}
	if !strings.Contains(err.Error(), "main") {
		t.Errorf("the failure did not name the window: %v", err)
	}
}

func TestADeclarationReadsTheNamesItWasSent(t *testing.T) {
	registry, bridge, _ := bridged(t)
	if err := bridge.DeclareFrom("main", map[string]any{"names": []any{"ui.tree"}}); err != nil {
		t.Fatalf("DeclareFrom: %v", err)
	}
	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	if !served["ui.tree"] {
		t.Errorf("the declared name is not on the table: %v", registry.Describe().Commands)
	}
}

func TestADelegatedNameIsOwnedByTheFramework(t *testing.T) {
	// A renderer command needs this host's window, which is what the framework
	// owner means. Reading it as core would tell a headless caller the command
	// is answerable with no window.
	registry, bridge, _ := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})

	for _, command := range registry.Describe().Commands {
		if command.Name == "ui.tree" && command.Owner != control.OwnerFramework {
			t.Errorf("ui.tree is owned by %q", command.Owner)
		}
	}
}

func TestCommandDocsWithoutAWindowUsesTheFirstDeclaringRenderer(t *testing.T) {
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("win-a", []string{"command.docs"})
	_ = bridge.Declare("win-b", []string{"command.docs"})
	answerOnce(t, registry, document, `{"ok":true}`)

	if _, err := registry.Invoke("command.docs", control.Args{
		"name": json.RawMessage(`"window.snapshot"`),
	}); err != nil {
		t.Fatalf("command.docs: %v", err)
	}
	if document.lastWindow() != "win-a" {
		t.Fatalf("command.docs reached %q, want first declaring renderer win-a", document.lastWindow())
	}
}

func receiptsFor(document *page, window string) int {
	document.mu.Lock()
	defer document.mu.Unlock()
	count := 0
	for _, receipt := range document.receipts {
		if receipt.Window == window {
			count++
		}
	}
	return count
}

func TestEveryDeclarationIsAnswered(t *testing.T) {
	// A page that reloaded is a new page: it has no record of what it holds
	// until it is told. Answering only when the table changed would leave a
	// reloaded window in silence about its own refusals — measured on the
	// running application 2026-08-15, where reloading the control plane
	// produced an identical table and no receipt at all.
	_, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})
	_ = bridge.Declare("main", []string{"ui.tree"})

	if answered := receiptsFor(document, "main"); answered != 2 {
		t.Errorf("two declarations were answered %d times", answered)
	}
}

func TestAWindowIsNotToldAgainWhenNothingAboutItChanged(t *testing.T) {
	// The other half: a window that did not declare hears from the bridge only
	// when what it holds actually moved. Telling every window on every
	// declaration would make the ledger read as though something changed.
	_, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})
	_ = bridge.Declare("win-a", []string{"pane.split"})
	before := receiptsFor(document, "main")

	_ = bridge.Declare("win-a", []string{"pane.split"})

	if after := receiptsFor(document, "main"); after != before {
		t.Errorf("main was told again for a change that was not its own (%d then %d)", before, after)
	}
}
