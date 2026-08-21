package wails

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

// The renderer command bridge: the transport that puts a page's commands on the
// one registry.
//
// The renderer owns the layout tree, the DOM and the view registry, and it
// registered those commands only inside its own page. The one door that reached
// them was a second application instance with a debugging server compiled in —
// that is another window, not a control plane.
//
// Three channels, each picked for the single guarantee it has to make:
//
//   - A declaration arrives as a framework event, because the framework stamps
//     the sending window's name onto it (CustomEvent.Sender). A page that named
//     itself could name another page and take that page's commands.
//   - A request is dispatched to one window's page. A broadcast would run the
//     same command in every window and only the first answer would be read.
//   - The answer comes back as an ordinary command call carrying the id this
//     process minted. The id is the correlation: it was handed to exactly one
//     page, so no other page can answer in its place and two windows cannot
//     collide on it.
const (
	// rendererRequestEvent and rendererReplyCommand are the page's existing
	// executor protocol (frontend/src/commands/executor.ts). The bridge speaks
	// it rather than inventing a second one: a second request path would run
	// commands through a different gate, permission check and envelope than the
	// one the page already uses, and the two would drift.
	rendererRequestEvent = "cmd-request"
	rendererReplyCommand = "cmd_result"

	// The declaration channel. Spelled the same in
	// frontend/src/framework/wails/rendererDoor.ts — a wire name has to be
	// written on both sides of a language boundary.
	rendererDeclareEvent         = "renderer:commands.declare"
	rendererWithdrawEvent        = "renderer:commands.withdraw"
	rendererReceiptEvent         = "renderer:commands.declared"
	rendererDocumentationCommand = "command.docs"
)

// rendererDeadline bounds one call to a page.
//
// A window that never answers must not hold the caller forever: the socket
// answers one request at a time, so one silent page would stop the whole
// control plane rather than one command.
//
// Twenty seconds is twice the longest path anyone has measured into this
// renderer. A command that arrives during boot queues behind the page's own
// plugin gate (measured 2.46s for 46 plugins, 2026-08-08). A 10s cap on a
// socket command is not enough: one first command consumed 9.4s
// of an 11.7s boot (measured 2026-08-08). At twice that, a timeout means the
// page is not answering rather than that it is busy.
const rendererDeadline = 20 * time.Second

// RendererDelivery hands one payload to one window's page, or fails naming the
// window. It is a function rather than the vendor's window handle so every rule
// below is answerable in a test with no application at all.
type RendererDelivery func(window, event string, payload any) error

// RendererExclusion is one declared name that is not delegated to the window.
type RendererExclusion struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// RendererDeclaration is what a window is told about its own declaration.
//
// It is delivered rather than returned because the declaration arrives as an
// event, which returns no answer. Without it a refusal would be silence, and
// the page would believe every name it sent is reachable.
type RendererDeclaration struct {
	Window string `json:"window"`
	// Prefix is what every name of this window is addressable under, whatever
	// happened to the bare form.
	// Held is the bare names this window answers. A name that is missing here
	// and absent from Excluded was never declared.
	Held     []string            `json:"held"`
	Excluded []RendererExclusion `json:"excluded"`
}

// RendererCommands is the backend half of the bridge.
type RendererCommands struct {
	registry *control.Registry
	deliver  RendererDelivery
	// deadline is a field rather than the constant so a test can drive the
	// timeout without waiting out a real one.
	deadline time.Duration

	mu      sync.Mutex
	nextID  uint64
	pending map[uint64]*rendererCall
	windows map[string]*rendererWindow
	waiters map[string][]chan error
	// order is declaration order, which is what a refusal lists when a caller
	// named no window.
	order []string
}

type rendererWindow struct {
	names   []string
	receipt RendererDeclaration
	told    bool
}

type rendererCall struct {
	window  string
	command string
	answer  chan rendererAnswer
}

type rendererAnswer struct {
	result json.RawMessage
	err    error
}

// rendererRequest is one command on its way to a page. The field names are the
// page executor's, not this package's.
type rendererRequest struct {
	ID     uint64       `json:"id"`
	Method string       `json:"method"`
	Params control.Args `json:"params"`
	Window string       `json:"window"`
}

// RegisterRendererCommands builds the bridge and registers the one command a
// page needs to answer with.
func RegisterRendererCommands(registry *control.Registry, deliver RendererDelivery) *RendererCommands {
	if registry == nil {
		panic("wails: the renderer command bridge needs a registry")
	}
	if deliver == nil {
		panic("wails: the renderer command bridge needs a way to reach a page")
	}
	bridge := &RendererCommands{
		registry: registry,
		deliver:  deliver,
		deadline: rendererDeadline,
		pending:  map[uint64]*rendererCall{},
		windows:  map[string]*rendererWindow{},
		waiters:  map[string][]chan error{},
	}

	registry.MustRegister(control.Command{
		Name:  rendererReplyCommand,
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			id, err := control.Arg[uint64](args, "id")
			if err != nil {
				return nil, err
			}
			result, err := control.RawArg(args, "result")
			if err != nil {
				return nil, err
			}
			return nil, bridge.answer(id, result)
		},
	})
	registry.MustRegister(control.Command{
		Name:  "window_renderer_wait",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			window, err := control.Arg[string](args, "targetWindow")
			if err != nil {
				return nil, err
			}
			timeoutMs, err := control.OptionalArg[uint64](args, "timeoutMs", 30000)
			if err != nil {
				return nil, err
			}
			if timeoutMs == 0 || timeoutMs > 60000 {
				return nil, i18n.Errorf("wails.rendererWait.invalidTimeout", nil)
			}
			if err := bridge.WaitDeclared(window, time.Duration(timeoutMs)*time.Millisecond); err != nil {
				return nil, err
			}
			return map[string]any{"window": window, "declared": true}, nil
		},
	})
	return bridge
}

// rendererSource names the one delegation this bridge holds.
//
// One source, not one per window: every window serves the same catalogue, and
// which window answers is decided per call rather than per name.
const rendererSource = "renderer"

// DeclareFrom records what one window answers, from the payload its page sent.
func (r *RendererCommands) DeclareFrom(window string, payload any) error {
	if window == "" {
		return i18n.Errorf("wails.declare.noWindow", nil)
	}
	names, err := rendererDeclaredNames(payload)
	if err != nil {
		return fmt.Errorf("window %s declared its commands unreadably: %w", window, err)
	}
	return r.Declare(window, names)
}

// rendererDeclaredNames reads the catalogue out of an event payload.
func rendererDeclaredNames(payload any) ([]string, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var declaration struct {
		Names *[]string `json:"names"`
	}
	if err := json.Unmarshal(encoded, &declaration); err != nil {
		return nil, err
	}
	if declaration.Names == nil {
		// A page that declares an empty catalogue and a page that sent the
		// wrong shape are different answers. Read as the first, the second
		// would silently withdraw every command that window serves.
		return nil, i18n.Errorf("wails.declare.noNames", map[string]string{"field": "names"})
	}
	return *declaration.Names, nil
}

// Declare records a window's whole catalogue, replacing whatever it declared
// before.
//
// Replacing rather than adding is what a reload needs: the page that came back
// has a new catalogue, and a name it no longer serves must stop being
// answerable rather than point at a page that is gone.
func (r *RendererCommands) Declare(window string, names []string) error {
	if window == "" {
		return i18n.Errorf("wails.declare.noWindow", nil)
	}
	r.mu.Lock()
	previous, known := r.windows[window]
	if !known {
		r.order = append(r.order, window)
		previous = &rendererWindow{}
	}
	previous.names = append([]string{}, names...)
	// A declaration is always answered, even when it changed nothing. The page
	// that sent it may be a reloaded one, and a reloaded page has no record of
	// what it holds until it receives one — measured 2026-08-15: reloading the
	// control plane produced an identical table, no receipt, and a page that
	// never heard which of its names were refused.
	previous.told = false
	r.windows[window] = previous
	waiters := r.waiters[window]
	delete(r.waiters, window)
	receipts := r.reconcileLocked()
	r.mu.Unlock()
	for _, waiter := range waiters {
		waiter <- nil
	}
	return r.tell(receipts)
}

func (r *RendererCommands) WaitDeclared(window string, timeout time.Duration) error {
	if window == "" {
		return i18n.Errorf("wails.declare.noWindow", nil)
	}
	r.mu.Lock()
	if _, declared := r.windows[window]; declared {
		r.mu.Unlock()
		return nil
	}
	waiter := make(chan error, 1)
	r.waiters[window] = append(r.waiters[window], waiter)
	r.mu.Unlock()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-waiter:
		return err
	case <-timer.C:
		r.mu.Lock()
		removeWaiter(r.waiters, window, waiter)
		r.mu.Unlock()
		return i18n.Errorf("wails.rendererWait.timeout", map[string]string{"window": window})
	}
}

func removeWaiter(waiters map[string][]chan error, window string, target chan error) {
	values := waiters[window]
	for index, waiter := range values {
		if waiter == target {
			values = append(values[:index], values[index+1:]...)
			break
		}
	}
	if len(values) == 0 {
		delete(waiters, window)
	} else {
		waiters[window] = values
	}
}

// Withdraw removes a window's names.
//
// A window that closed answers nothing, and a caller already waiting on it
// receives that now rather than at the deadline — the deadline is for a page that
// is there and silent, which is a different fact.
func (r *RendererCommands) Withdraw(window string) error {
	r.mu.Lock()
	if _, known := r.windows[window]; !known {
		waiters := r.waiters[window]
		delete(r.waiters, window)
		r.mu.Unlock()
		for _, waiter := range waiters {
			waiter <- i18n.Errorf("wails.rendererWait.closed", map[string]string{"window": window})
		}
		return nil
	}
	delete(r.windows, window)
	for index, name := range r.order {
		if name == window {
			r.order = append(r.order[:index], r.order[index+1:]...)
			break
		}
	}
	// The delegation is the bridge's, not this window's — reconcile rebuilds it
	// from what is left. Withdrawing here would take away names the remaining
	// windows still serve.

	var abandoned []*rendererCall
	for id, call := range r.pending {
		if call.window == window {
			delete(r.pending, id)
			abandoned = append(abandoned, call)
		}
	}
	receipts := r.reconcileLocked()
	waiters := r.waiters[window]
	delete(r.waiters, window)
	r.mu.Unlock()

	for _, waiter := range waiters {
		waiter <- i18n.Errorf("wails.rendererWait.closed", map[string]string{"window": window})
	}
	for _, call := range abandoned {
		call.answer <- rendererAnswer{err: fmt.Errorf(
			"window %s stopped answering %s before it replied", call.window, call.command)}
	}
	return r.tell(receipts)
}

// reconcileLocked rebuilds the whole delegation table from the ledger and
// answers with the receipts no window has been told yet.
//
// Bare names are a lease held in declaration order: the first window to declare
// a name answers it, and when that window goes the next one that serves it
// takes over. Leaving the name unheld once its holder closed would make
// `sok ui.tree` answer "not registered" while a window on screen still serves
// it, which is the failure this whole bridge exists to end.
func (r *RendererCommands) reconcileLocked() []RendererDeclaration {
	// One name, one entry, every window. The window is an argument, the way it
	// is for window_snapshot and window_set_background — and the way the address
	// grammar already includes it, since `ui.measure address='win-a/…'` names the
	// window in the address rather than in the command.
	//
	// The rejected shape put the window in the name (`win/main/ui.tree`). It
	// worked and it cost this: measured 2026-08-15, two windows put 577 entries
	// on the table, and the second window held none of the 250 bare names — so
	// `sok ui.measure`, the spelling the geometry constitution documents for
	// proving an alignment claim, reached one window only.
	union := map[string]bool{}
	for _, window := range r.order {
		for _, name := range r.windows[window].names {
			if name != "" && name != control.HelloCommand {
				union[name] = true
			}
		}
	}
	names := make([]string, 0, len(union))
	for name := range union {
		names = append(names, name)
	}
	sort.Strings(names)

	// A name this process serves itself is separated out first, so the page is
	// told which one rather than being handed the registry's verdict about the
	// first offender for the whole set. Two answers under one name is the drift
	// a single registry prevents, and the local one is the one with a test.
	taken := map[string]string{}
	delegable := names[:0:0]
	for _, name := range names {
		if r.registry.ServedLocally(name) {
			taken[name] = "provided by process"
			continue
		}
		delegable = append(delegable, name)
	}

	var excluded []RendererExclusion
	if err := r.registry.Delegate(rendererSource, control.OwnerFramework, delegable, r.forward()); err != nil {
		excluded = append(excluded, RendererExclusion{Reason: err.Error()})
	}

	var changed []RendererDeclaration
	for _, window := range r.order {
		declared := r.windows[window]
		receipt := RendererDeclaration{Window: window, Held: []string{}}
		for _, name := range declared.names {
			switch {
			case name == "":
				receipt.Excluded = append(receipt.Excluded, RendererExclusion{
					Reason: "a command with no name cannot be addressed"})
			case name == control.HelloCommand:
				// The socket answers this one before the registry sees it, so a
				// delegation would be accepted and never reached.
				receipt.Excluded = append(receipt.Excluded, RendererExclusion{Name: name,
					Reason: "provided by control transport"})
			case taken[name] != "":
				receipt.Excluded = append(receipt.Excluded, RendererExclusion{
					Name: name, Reason: taken[name]})
			default:
				receipt.Held = append(receipt.Held, name)
			}
		}
		receipt.Excluded = append(receipt.Excluded, excluded...)

		if !declared.told || !sameDeclaration(declared.receipt, receipt) {
			declared.receipt = receipt
			declared.told = true
			changed = append(changed, receipt)
		}
	}
	return changed
}

func sameDeclaration(before, after RendererDeclaration) bool {
	if before.Window != after.Window {
		return false
	}
	if len(before.Held) != len(after.Held) || len(before.Excluded) != len(after.Excluded) {
		return false
	}
	for index := range before.Held {
		if before.Held[index] != after.Held[index] {
			return false
		}
	}
	for index := range before.Excluded {
		if before.Excluded[index] != after.Excluded[index] {
			return false
		}
	}
	return true
}

// tell hands each changed receipt to its window.
func (r *RendererCommands) tell(receipts []RendererDeclaration) error {
	var failures []string
	for _, receipt := range receipts {
		if err := r.deliver(receipt.Window, rendererReceiptEvent, receipt); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", receipt.Window, err))
		}
	}
	if len(failures) > 0 {
		return i18n.Errorf("wails.declare.notTold", map[string]string{"windows": strings.Join(failures, "; ")})
	}
	return nil
}

// forward is what the registry calls for a delegated name.
//
// Which window answers is the caller's to say: named explicitly by an operator
// who has no window of their own, and stamped by the transport for a page. A
// caller that supplies neither is refused rather than routed somewhere plausible —
// an answer about a window nobody asked about looks exactly like a right one.
func (r *RendererCommands) forward() func(string, control.Args) (any, error) {
	return func(name string, args control.Args) (any, error) {
		window, err := control.OptionalArg(args, "window", "")
		if err != nil {
			return nil, err
		}
		if window == "" {
			window, err = control.OptionalArg(args, control.CallerWindowArgument, "")
			if err != nil {
				return nil, err
			}
		}
		if window == "" {
			if name == rendererDocumentationCommand {
				serving := r.serving(name)
				if len(serving) > 0 {
					window = serving[0]
				}
			}
		}
		if window == "" {
			return nil, i18n.Errorf("wails.renderer.needsWindow", map[string]string{
				"command": name,
				"windows": strings.Join(r.serving(name), ", "),
			})
		}
		// The routing arguments are this transport's, not the page's. Passing
		// them on makes a page refuse a parameter it never declared, which reads
		// as the command being wrong rather than the envelope carrying extra.
		return r.call(window, name, withoutRouting(args))
	}
}

// serving is which windows declared this name, in declaration order.
func (r *RendererCommands) serving(name string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	windows := []string{}
	for _, window := range r.order {
		for _, declared := range r.windows[window].names {
			if declared == name {
				windows = append(windows, window)
				break
			}
		}
	}
	return windows
}

// call sends one command to one page and waits for that page's answer.
func (r *RendererCommands) call(window, command string, args control.Args) (any, error) {
	if args == nil {
		args = control.Args{}
	}

	r.mu.Lock()
	declared, known := r.windows[window]
	if !known {
		r.mu.Unlock()
		return nil, i18n.Errorf("wails.renderer.windowGone", map[string]string{
			"window": window, "command": command})
	}
	if !slices.Contains(declared.names, command) {
		r.mu.Unlock()
		return nil, i18n.Errorf("wails.renderer.notServed", map[string]string{
			"window": window, "command": command})
	}
	r.nextID++
	id := r.nextID
	call := &rendererCall{window: window, command: command, answer: make(chan rendererAnswer, 1)}
	r.pending[id] = call
	deadline := r.deadline
	r.mu.Unlock()

	request := rendererRequest{ID: id, Method: command, Params: args, Window: window}
	if err := r.deliver(window, rendererRequestEvent, request); err != nil {
		r.forget(id)
		return nil, fmt.Errorf("window %s could not be handed %s: %w", window, command, err)
	}

	timer := time.NewTimer(deadline)
	defer timer.Stop()
	select {
	case answered := <-call.answer:
		if answered.err != nil {
			return nil, answered.err
		}
		return rendererResult(window, command, answered.result)
	case <-timer.C:
		r.forget(id)
		return nil, i18n.Errorf("wails.renderer.timedOut", map[string]string{
			"window": window, "command": command, "deadline": deadline.String()})
	}
}

func (r *RendererCommands) forget(id uint64) {
	r.mu.Lock()
	delete(r.pending, id)
	r.mu.Unlock()
}

// answer delivers a page's reply to whoever is waiting for it.
func (r *RendererCommands) answer(id uint64, result json.RawMessage) error {
	r.mu.Lock()
	call, waiting := r.pending[id]
	delete(r.pending, id)
	r.mu.Unlock()

	if !waiting {
		// The deadline already fired, or this id was never handed out. Either
		// way the page is told: an answer that is being thrown away must not
		// look to its sender like an answer that arrived.
		return i18n.Errorf("wails.renderer.noSuchRequest", map[string]string{"id": fmt.Sprint(id)})
	}
	call.answer <- rendererAnswer{result: append(json.RawMessage(nil), result...)}
	return nil
}

// rendererResult reads the page's envelope.
func rendererResult(window, command string, raw json.RawMessage) (any, error) {
	var envelope struct {
		Ok      *bool  `json:"ok"`
		Code    string `json:"code"`
		Message string `json:"message"`
		// What the window's own engine said, which the command layer keeps out of the human
		// sentence on purpose. A refusal that drops it sends its reader back to the window to
		// find out why — measured 2026-08-17, `window.snapshot` answered INTERNAL six runs
		// running and named nothing, and the reason was in this field the whole time.
		Data struct {
			Detail string `json:"detail"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("window %s answered %s with something that is not a command envelope: %w",
			window, command, err)
	}
	if envelope.Ok == nil {
		// "It failed" and "it did not say" are different answers, and a missing
		// verdict read as success would report a refusal as a result.
		return nil, i18n.Errorf("wails.renderer.noVerdict", map[string]string{
			"window": window, "command": command})
	}
	if !*envelope.Ok {
		// A refusal is a failed command, so it leaves as an error: `sok` exits
		// non-zero on it and a shell can branch. The page's own code and
		// message travel with it, because "it failed" alone sends the caller
		// back to the window to find out why.
		if envelope.Data.Detail != "" {
			return nil, i18n.Errorf("wails.renderer.refusedWithDetail", map[string]string{
				"window": window, "command": command, "code": envelope.Code,
				"message": envelope.Message, "detail": envelope.Data.Detail})
		}
		return nil, i18n.Errorf("wails.renderer.refused", map[string]string{
			"window": window, "command": command, "code": envelope.Code, "message": envelope.Message})
	}

	// The whole envelope is the answer, not just its payload: a caller given
	// only the payload cannot tell an empty result from a refusal.
	var result any
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// withoutRouting strips what only this transport reads.
//
// `window` selects which page answers and the stamped caller records where the
// request came from; neither is a parameter of any command. A page that
// validates its parameters — and this one does — refuses the whole call over
// them.
func withoutRouting(args control.Args) control.Args {
	stripped := make(control.Args, len(args))
	for name, value := range args {
		if name == "window" || name == control.CallerWindowArgument {
			continue
		}
		stripped[name] = value
	}
	return stripped
}
