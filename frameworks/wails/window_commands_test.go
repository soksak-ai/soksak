package wails

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"unsafe"

	"github.com/soksak/soksak-core/core/control"
)

// fakeWindow is one window a fake host holds. `live` is what separates a name
// this process holds from a name a command can reach.
type fakeWindow struct {
	name       string
	live       bool
	focused    bool
	frame      Frame
	title      string
	background string
}

// fakeHost answers window facts with no window anywhere. Its existence is the
// proof that these rules never took the vendor's handle.
type fakeHost struct {
	started  bool
	windows  []*fakeWindow
	displays []Display
	// calls records every effect in order, so a test can say that the frame
	// was applied before the window was revealed rather than only that both
	// happened.
	calls []string
	// opensLive reports whether a window this host opens gains a native lifetime.
	// False reproduces a creation that never becomes an address.
	opensLive bool
	openErr   error
	// placeErr and revealErr fail an effect that runs after the window already
	// exists, which is the only way to reach the rollback for a window that did
	// become an address.
	placeErr  error
	revealErr error
}

func (h *fakeHost) note(format string, args ...any) {
	h.calls = append(h.calls, fmt.Sprintf(format, args...))
}

func (h *fakeHost) find(name string) *fakeWindow {
	for _, window := range h.windows {
		if window.name == name {
			return window
		}
	}
	return nil
}

func (h *fakeHost) Started() bool { return h.started }

func (h *fakeHost) Names() []string {
	names := make([]string, 0, len(h.windows))
	for _, window := range h.windows {
		names = append(names, window.name)
	}
	return names
}

func (h *fakeHost) Live(name string) bool {
	window := h.find(name)
	return window != nil && window.live
}

// NativeHandle: this package has no application, so no window here has pixels.
// Capture must answer that rather than pretend.
func (h *fakeHost) NativeHandle(string) unsafe.Pointer { return nil }

// ContentSize: this package has no application, so a window here has no content
// area. The commands must answer that rather than invent a size.
func (h *fakeHost) ContentSize(name string) (float64, float64, error) {
	window := h.find(name)
	if window == nil || !window.live {
		return 0, 0, fmt.Errorf("window %s has no native lifetime and no content area", name)
	}
	return float64(window.frame.W), float64(window.frame.H), nil
}

// FitWebview: nothing to fit without an application.
func (h *fakeHost) FitWebview(name string) error {
	if window := h.find(name); window == nil || !window.live {
		return fmt.Errorf("window %s has no native lifetime and holds no view to fit", name)
	}
	return nil
}

// WebviewRect: this package has no application, so no window holds a view.
func (h *fakeHost) WebviewRect(name string) (float64, float64, float64, float64, error) {
	window := h.find(name)
	if window == nil || !window.live {
		return 0, 0, 0, 0, fmt.Errorf("window %s has no native lifetime and holds no view", name)
	}
	return 0, 0, float64(window.frame.W), float64(window.frame.H), nil
}

func (h *fakeHost) SetBackground(name string, colour string) error {
	window := h.find(name)
	if window == nil || !window.live {
		return fmt.Errorf("window %s has no native lifetime and cannot be coloured", name)
	}
	window.background = colour
	return nil
}

// background is what this window was last painted, or "" if never.
func (h *fakeHost) background(name string) string {
	if window := h.find(name); window != nil {
		return window.background
	}
	return ""
}

func (h *fakeHost) Title(name string) (string, error) {
	window := h.find(name)
	if window == nil || !window.live {
		return "", fmt.Errorf("window %s has no native lifetime and no title", name)
	}
	return window.title, nil
}

func (h *fakeHost) Focused(name string) bool {
	window := h.find(name)
	return window != nil && window.live && window.focused
}

func (h *fakeHost) Frame(name string) (Frame, bool) {
	window := h.find(name)
	if window == nil || !window.live {
		return Frame{}, false
	}
	return window.frame, true
}

func (h *fakeHost) Displays() []Display { return h.displays }

func (h *fakeHost) Open(spec OpenSpec) error {
	h.note("open %s %s", spec.Name, spec.URL)
	if h.openErr != nil {
		return h.openErr
	}
	h.windows = append(h.windows, &fakeWindow{
		name:  spec.Name,
		live:  h.opensLive,
		frame: Frame{X: 0, Y: 0, W: 1000, H: 618},
	})
	return nil
}

func (h *fakeHost) Reveal(name string, key bool) error {
	h.note("reveal %s key=%v", name, key)
	return h.revealErr
}

func (h *fakeHost) Discard(name string) error {
	h.note("discard %s", name)
	for i, window := range h.windows {
		if window.name == name {
			h.windows = append(h.windows[:i], h.windows[i+1:]...)
			return nil
		}
	}
	return fmt.Errorf("discard: no window named %s", name)
}

func (h *fakeHost) Place(name string, frame Frame) error {
	h.note("place %s %v", name, frame)
	if h.placeErr != nil {
		return h.placeErr
	}
	window := h.find(name)
	if window == nil {
		return fmt.Errorf("place: no window named %s", name)
	}
	window.frame = frame
	return nil
}

func (h *fakeHost) Focus(name string) error {
	h.note("focus %s", name)
	return nil
}

func (h *fakeHost) Reload(name string) error {
	h.note("reload %s", name)
	return nil
}

func (h *fakeHost) Close(name string) error {
	h.note("close %s", name)
	return nil
}

func (h *fakeHost) ActivateApplication() error {
	h.note("activate")
	return nil
}

// startedHost is a run loop that owns the main thread and holds the windows
// given.
func startedHost(windows ...*fakeWindow) *fakeHost {
	return &fakeHost{started: true, windows: windows, opensLive: true}
}

func liveWindow(name string) *fakeWindow {
	return &fakeWindow{name: name, live: true, frame: Frame{X: 0, Y: 0, W: 1000, H: 618}}
}

// deadWindow is a name this process still holds over a window that no longer
// answers. It exists because that state is what makes two windows under one
// name possible, so it must stay countable.
func deadWindow(name string) *fakeWindow {
	return &fakeWindow{name: name}
}

// counter hands out identifiers the way the process would, without touching
// anything ambient.
func counter(names ...string) func() string {
	index := 0
	return func() string {
		if index < len(names) {
			name := names[index]
			index++
			return name
		}
		index++
		return fmt.Sprintf("generated-%d", index)
	}
}

func registryFor(t *testing.T, host WindowHost, newID func() string) *control.Registry {
	t.Helper()
	registry := control.NewRegistry()
	Register(registry, Deps{Host: host, NewID: newID})
	return registry
}

func callArgs(t *testing.T, values map[string]any) control.Args {
	t.Helper()
	args := control.Args{}
	for key, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding argument %q: %v", key, err)
		}
		args[key] = encoded
	}
	return args
}

// windowCommands is every command this group answers.
var windowCommands = []string{
	"window_create", "window_close", "window_focus", "window_activate",
	"window_place", "window_reload", "window_list", "window_census",
	"window_is_key", "window_monitors",
}

// A window queued ahead of the run loop is in the registry, visible to a
// listing and reachable by nothing. Answering "there are no windows" there
// sends a restore into recreating every one of them.
func TestEveryCommandRefusesBeforeTheRunLoopStarts(t *testing.T) {
	host := &fakeHost{started: false, windows: []*fakeWindow{liveWindow("main")}}
	registry := registryFor(t, host, counter("a"))

	for _, name := range windowCommands {
		result, err := registry.Invoke(name, callArgs(t, map[string]any{
			"label": "main", "x": 0, "y": 0, "w": 100, "h": 100,
		}))
		if err == nil {
			t.Errorf("%s answered %v before the run loop started", name, result)
			continue
		}
		if !strings.Contains(err.Error(), "run loop") {
			t.Errorf("%s refused with %q; the message must separate this from a missing window", name, err)
		}
	}
	if len(host.calls) != 0 {
		t.Errorf("effects ran before the run loop started: %v", host.calls)
	}
}

// A repeated respawn must not produce a second window under one name: this
// host resolves a duplicate name by map order, so the two would be
// indistinguishable and one of them unreachable forever.
func TestCreatingAHeldNameCreatesNothingAndReturnsTheName(t *testing.T) {
	host := startedHost(liveWindow("win-1"))
	registry := registryFor(t, host, counter("2"))

	result, err := registry.Invoke("window_create", callArgs(t, map[string]any{"label": "win-1"}))
	if err != nil {
		t.Fatalf("a held name must be idempotent: %v", err)
	}
	if result != "win-1" {
		t.Fatalf("window_create returned %v, want win-1", result)
	}
	if len(host.calls) != 0 {
		t.Fatalf("a held name produced effects: %v", host.calls)
	}
}

// A name this process holds but cannot reach still blocks creation, because
// creating a second window under it is what makes both unreachable.
func TestCreatingAHeldButUnreachableNameStillCreatesNothing(t *testing.T) {
	host := startedHost(&fakeWindow{name: "win-1", live: false})
	registry := registryFor(t, host, counter("2"))

	result, err := registry.Invoke("window_create", callArgs(t, map[string]any{"label": "win-1"}))
	if err != nil {
		t.Fatalf("a held name must be idempotent whether or not it answers: %v", err)
	}
	if result != "win-1" || len(host.calls) != 0 {
		t.Fatalf("window_create returned %v with effects %v", result, host.calls)
	}
}

// An addressless window is not a success artifact: it is visible to a listing
// and answers nothing, so the name must be given back rather than kept.
func TestAWindowThatNeverBecomesAnAddressIsRolledBack(t *testing.T) {
	host := startedHost()
	host.opensLive = false
	registry := registryFor(t, host, counter("1"))

	result, err := registry.Invoke("window_create", control.Args{})
	if err == nil {
		t.Fatalf("a window that never became an address was reported created: %v", result)
	}
	if !strings.Contains(err.Error(), "win-1") {
		t.Errorf("the failure did not name the window: %v", err)
	}
	if host.find("win-1") != nil {
		t.Error("the addressless window was left behind for the next name to collide with")
	}
	if !contains(host.calls, "discard win-1") {
		t.Errorf("the window was not discarded: %v", host.calls)
	}
}

// A restore brings windows back behind whatever the user is looking at. A
// reveal that takes the keyboard is the thing focus:false exists to prevent.
func TestFocusFalseRevealsWithoutTakingTheKeyboard(t *testing.T) {
	host := startedHost()
	registry := registryFor(t, host, counter("1"))

	if _, err := registry.Invoke("window_create", callArgs(t, map[string]any{"focus": false})); err != nil {
		t.Fatalf("window_create: %v", err)
	}
	if !contains(host.calls, "reveal win-1 key=false") {
		t.Fatalf("a background restore asked for the keyboard: %v", host.calls)
	}

	for _, args := range []map[string]any{{}, {"focus": true}} {
		fresh := startedHost()
		registry := registryFor(t, fresh, counter("2"))
		if _, err := registry.Invoke("window_create", callArgs(t, args)); err != nil {
			t.Fatalf("window_create %v: %v", args, err)
		}
		if !contains(fresh.calls, "reveal win-2 key=true") {
			t.Fatalf("window_create %v did not bring the window forward: %v", args, fresh.calls)
		}
	}
}

// Revealing first shows the window at the OS default position and then moves
// it, which is visible as a jump rather than as an error.
func TestTheFrameIsAppliedBeforeTheWindowIsRevealed(t *testing.T) {
	host := startedHost()
	registry := registryFor(t, host, counter("1"))

	_, err := registry.Invoke("window_create", callArgs(t, map[string]any{
		"rect": map[string]any{"x": 100, "y": 200, "w": 800, "h": 600},
	}))
	if err != nil {
		t.Fatalf("window_create: %v", err)
	}

	place := indexOf(host.calls, "place win-1 {100 200 800 600}")
	reveal := indexOf(host.calls, "reveal win-1 key=true")
	if place < 0 || reveal < 0 {
		t.Fatalf("expected a place and a reveal, got %v", host.calls)
	}
	if place > reveal {
		t.Fatalf("the window was revealed before its frame was final: %v", host.calls)
	}
}

// A restore puts a window back exactly where it was. Cascading it as well
// would walk it across the screen a little further on every restart.
func TestARequestedRectSuppressesTheCascade(t *testing.T) {
	source := liveWindow("main")
	source.focused = true
	source.frame = Frame{X: 40, Y: 60, W: 1000, H: 618}
	host := startedHost(source)
	registry := registryFor(t, host, counter("1"))

	_, err := registry.Invoke("window_create", callArgs(t, map[string]any{
		"rect": map[string]any{"x": 100, "y": 200, "w": 800, "h": 600},
	}))
	if err != nil {
		t.Fatalf("window_create: %v", err)
	}
	if contains(host.calls, "place win-1 {68 88 1000 618}") {
		t.Fatalf("a restored window was cascaded off its saved position: %v", host.calls)
	}
	if !contains(host.calls, "place win-1 {100 200 800 600}") {
		t.Fatalf("the saved position was not applied: %v", host.calls)
	}
}

// frameOf answers one boolean for two different facts: no rect was asked for,
// and a rect was asked for that no window can occupy. window_place reads that
// boolean as an error. window_create read it as absence, so a caller who asked
// for a zero-width window got a cascaded one and was told it succeeded — the
// same shape as a missing directory and an unreadable one sharing an answer.
//
// Found 2026-08-15 while clearing the window group's probe: window_create with
// a rect of w=0 opened a window and returned its name.
func TestCreateRefusesARectThatIsNotOne(t *testing.T) {
	for _, rect := range []map[string]any{
		{"x": 100, "y": 200, "w": 0, "h": 600},
		{"x": 100, "y": 200, "w": 800, "h": -1},
		{"x": 1e300, "y": 200, "w": 800, "h": 600},
	} {
		host := startedHost()
		registry := registryFor(t, host, counter("1"))

		name, err := registry.Invoke("window_create", callArgs(t, map[string]any{"rect": rect}))
		if err == nil {
			t.Errorf("window_create accepted %v and answered %v", rect, name)
		}
		if len(host.calls) != 0 {
			t.Errorf("window_create acted on %v: %v", rect, host.calls)
		}
	}
}

// Landing exactly on the window that opened it makes it impossible to see that
// a new window opened at all. With no window to cascade from, the position is
// left to the OS rather than defaulted to the origin.
func TestACascadeNeedsASourceWindow(t *testing.T) {
	source := liveWindow("main")
	source.focused = true
	source.frame = Frame{X: 40, Y: 60, W: 1000, H: 618}
	host := startedHost(source)
	registry := registryFor(t, host, counter("1"))

	if _, err := registry.Invoke("window_create", control.Args{}); err != nil {
		t.Fatalf("window_create: %v", err)
	}
	if !contains(host.calls, "place win-1 {68 88 1000 618}") {
		t.Fatalf("the fresh window did not cascade from the focused window: %v", host.calls)
	}

	lonely := startedHost()
	registry = registryFor(t, lonely, counter("2"))
	if _, err := registry.Invoke("window_create", control.Args{}); err != nil {
		t.Fatalf("window_create: %v", err)
	}
	for _, call := range lonely.calls {
		if strings.HasPrefix(call, "place ") {
			t.Fatalf("a first window was placed with no source to cascade from: %v", lonely.calls)
		}
	}
}

// The source is the focused window, not a hardcoded name: a window opened from
// a workspace cascades from that workspace.
func TestTheCascadeSourceIsTheFocusedWindow(t *testing.T) {
	orchestrator := liveWindow("main")
	orchestrator.frame = Frame{X: 0, Y: 0, W: 1000, H: 618}
	workspace := liveWindow("win-a")
	workspace.focused = true
	workspace.frame = Frame{X: 500, Y: 300, W: 900, H: 700}

	host := startedHost(orchestrator, workspace)
	registry := registryFor(t, host, counter("1"))
	if _, err := registry.Invoke("window_create", control.Args{}); err != nil {
		t.Fatalf("window_create: %v", err)
	}
	if !contains(host.calls, "place win-1 {528 328 1000 618}") {
		t.Fatalf("the cascade did not start from the focused window: %v", host.calls)
	}
}

// Returning a name held by somebody else's window returns
// somebody else's window.
func TestAGeneratedNameThatIsAlreadyHeldIsRefused(t *testing.T) {
	host := startedHost(liveWindow("win-1"))
	registry := registryFor(t, host, counter("1"))

	result, err := registry.Invoke("window_create", control.Args{})
	if err == nil {
		t.Fatalf("a colliding generated name was accepted and answered %v", result)
	}
	if len(host.calls) != 0 {
		t.Errorf("a colliding generated name produced effects: %v", host.calls)
	}
}

// The boot instruction is the only channel a new window has for what it is
// meant to open. Dropping it produces a window that boots empty, with nothing
// reported anywhere — so the URL is asserted, not just the rule that screens it.
func TestTheBootInstructionReachesTheNewWindowsURL(t *testing.T) {
	host := startedHost()
	registry := registryFor(t, host, counter("1"))
	if _, err := registry.Invoke("window_create", callArgs(t, map[string]any{
		"init": "root=%2Fx&fresh=1",
	})); err != nil {
		t.Fatalf("window_create: %v", err)
	}
	if !contains(host.calls, "open win-1 /?root=%2Fx&fresh=1") {
		t.Fatalf("the boot instruction did not reach the window: %v", host.calls)
	}

	bare := startedHost()
	registry = registryFor(t, bare, counter("2"))
	if _, err := registry.Invoke("window_create", control.Args{}); err != nil {
		t.Fatalf("window_create: %v", err)
	}
	if !contains(bare.calls, "open win-2 /") {
		t.Fatalf("a window with no boot instruction opened at %v", bare.calls)
	}
}

// The screening rule is tested on its own; this proves the command calls
// it. Without it a '#' passes and everything after it never arrives at
// location.search — the window boots empty and no layer reports why.
func TestABootInstructionThatWouldNotSurviveIsRefusedByTheCommand(t *testing.T) {
	for _, init := range []string{"root=a#b", "?root=a"} {
		host := startedHost()
		registry := registryFor(t, host, counter("1"))
		result, err := registry.Invoke("window_create", callArgs(t, map[string]any{"init": init}))
		if err == nil {
			t.Errorf("init %q was accepted and answered %v", init, result)
		}
		if len(host.calls) != 0 {
			t.Errorf("init %q built a window that would boot without it: %v", init, host.calls)
		}
	}
}

// An effect that fails after the window already exists leaves a window nobody
// asked for: visible in a listing, holding the name, and never placed or
// revealed as requested.
func TestAnEffectThatFailsAfterTheWindowExistsWithdrawsIt(t *testing.T) {
	placing := startedHost()
	placing.placeErr = errors.New("the platform refused the frame")
	registry := registryFor(t, placing, counter("1"))
	if _, err := registry.Invoke("window_create", callArgs(t, map[string]any{
		"rect": map[string]any{"x": 100, "y": 200, "w": 800, "h": 600},
	})); err == nil {
		t.Fatal("a window whose frame could not be applied was reported created")
	}
	if placing.find("win-1") != nil || !contains(placing.calls, "discard win-1") {
		t.Fatalf("the window was left behind: %v", placing.calls)
	}

	revealing := startedHost()
	revealing.revealErr = errors.New("this platform has no focus-free reveal")
	registry = registryFor(t, revealing, counter("2"))
	if _, err := registry.Invoke("window_create", callArgs(t, map[string]any{"focus": false})); err == nil {
		t.Fatal("a window that could not be revealed was reported created")
	}
	if revealing.find("win-2") != nil || !contains(revealing.calls, "discard win-2") {
		t.Fatalf("the window was left behind: %v", revealing.calls)
	}
}

func TestAnUnaddressableRequestedNameIsRefused(t *testing.T) {
	for _, name := range []string{"win-a/b", "windowin-1", "", "win-"} {
		host := startedHost()
		registry := registryFor(t, host, counter("1"))
		result, err := registry.Invoke("window_create", callArgs(t, map[string]any{"label": name}))
		if err == nil {
			t.Errorf("label %q was accepted and answered %v", name, result)
		}
		if len(host.calls) != 0 {
			t.Errorf("label %q produced effects: %v", name, host.calls)
		}
	}
}

// The commands that take a window and act on it.
var windowTargetedCommands = []string{
	"window_close", "window_focus", "window_reload", "window_place", "window_is_key",
}

func TestATargetedCommandOnAnUnknownWindowFailsByName(t *testing.T) {
	for _, command := range windowTargetedCommands {
		host := startedHost(liveWindow("main"))
		registry := registryFor(t, host, counter("1"))
		_, err := registry.Invoke(command, callArgs(t, map[string]any{
			"label": "win-gone", "x": 0, "y": 0, "w": 100, "h": 100,
		}))
		if err == nil {
			t.Errorf("%s answered for a window that does not exist", command)
			continue
		}
		if !strings.Contains(err.Error(), "win-gone") {
			t.Errorf("%s refused with %q, which does not name the window", command, err)
		}
		if len(host.calls) != 0 {
			t.Errorf("%s acted on a window that does not exist: %v", command, host.calls)
		}
	}
}

// This host's Close, Focus and Reload all return silently for a window with no
// native lifetime. Passing that through reports having done something we did
// not do.
func TestATargetedCommandOnAnUnreachableWindowFailsRatherThanSucceeding(t *testing.T) {
	for _, command := range windowTargetedCommands {
		host := startedHost(&fakeWindow{name: "win-dead", live: false})
		registry := registryFor(t, host, counter("1"))
		_, err := registry.Invoke(command, callArgs(t, map[string]any{
			"label": "win-dead", "x": 0, "y": 0, "w": 100, "h": 100,
		}))
		if err == nil {
			t.Errorf("%s reported success against a window that answers nothing", command)
		}
		if len(host.calls) != 0 {
			t.Errorf("%s acted on a window that answers nothing: %v", command, host.calls)
		}
	}
}

// Each command performs its own effect and no other. Without this, a handler
// wired to the neighbouring effect passes every other check in this file:
// closing a window would reload it, and the caller would be told it closed.
func TestEachTargetedCommandPerformsExactlyItsOwnEffect(t *testing.T) {
	for command, effect := range map[string]string{
		"window_close":  "close win-1",
		"window_focus":  "focus win-1",
		"window_reload": "reload win-1",
		"window_place":  "place win-1 {10 20 800 600}",
	} {
		host := startedHost(liveWindow("win-1"))
		registry := registryFor(t, host, counter("2"))
		result, err := registry.Invoke(command, callArgs(t, map[string]any{
			"label": "win-1", "x": 10, "y": 20, "w": 800, "h": 600,
		}))
		if err != nil {
			t.Errorf("%s: %v", command, err)
			continue
		}
		if result != nil {
			t.Errorf("%s answered %v; the outcome of an effect is asked for separately", command, result)
		}
		if !reflect.DeepEqual(host.calls, []string{effect}) {
			t.Errorf("%s performed %v, want exactly [%s]", command, host.calls, effect)
		}
	}
}

// A window can be raised successfully and still not receive the keyboard, so
// the request and the result must stay askable separately.
func TestKeyStateIsAnAnswerSeparateFromTheFocusRequest(t *testing.T) {
	window := liveWindow("win-1")
	host := startedHost(window)
	registry := registryFor(t, host, counter("2"))

	if _, err := registry.Invoke("window_focus", callArgs(t, map[string]any{"label": "win-1"})); err != nil {
		t.Fatalf("window_focus: %v", err)
	}
	if !contains(host.calls, "focus win-1") {
		t.Fatalf("window_focus did not reach the host: %v", host.calls)
	}

	key, err := registry.Invoke("window_is_key", callArgs(t, map[string]any{"label": "win-1"}))
	if err != nil {
		t.Fatalf("window_is_key: %v", err)
	}
	if key != false {
		t.Fatal("a successful focus request was reported as key ownership; they are different facts")
	}

	window.focused = true
	key, err = registry.Invoke("window_is_key", callArgs(t, map[string]any{"label": "win-1"}))
	if err != nil || key != true {
		t.Fatalf("window_is_key on the key window = %v, %v", key, err)
	}
}

// False for a window that is gone reads as "the focus failed" and sends the
// caller retrying against nothing.
func TestKeyStateForAVanishedWindowIsAnErrorAndNotFalse(t *testing.T) {
	host := startedHost(liveWindow("main"))
	registry := registryFor(t, host, counter("1"))

	result, err := registry.Invoke("window_is_key", callArgs(t, map[string]any{"label": "win-gone"}))
	if err == nil {
		t.Fatalf("window_is_key answered %v for a window that does not exist", result)
	}
}

// Go randomises map order, so two readings of an unsorted list disagree while
// nothing changed. The caller renders this.
func TestTheWindowListIsSortedAndHoldsOnlyAddresses(t *testing.T) {
	host := startedHost(
		liveWindow("win-b"),
		&fakeWindow{name: "win-queued", live: false},
		liveWindow("main"),
		liveWindow("win-a"),
	)
	registry := registryFor(t, host, counter("1"))

	result, err := registry.Invoke("window_list", control.Args{})
	if err != nil {
		t.Fatalf("window_list: %v", err)
	}
	names, ok := result.([]string)
	if !ok {
		t.Fatalf("window_list answered %T, want []string", result)
	}
	want := []string{"main", "win-a", "win-b"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("window_list = %v, want %v (a name no command can reach must not be offered as a target)", names, want)
	}
	if !sort.StringsAreSorted(names) {
		t.Fatal("window_list is unsorted; two readings would disagree with nothing changed")
	}
}

// Absence is an empty list, never nil: a caller that renders this cannot tell a
// null from a failure.
func TestAnEmptyWindowListIsAListAndNotNull(t *testing.T) {
	registry := registryFor(t, startedHost(), counter("1"))
	result, err := registry.Invoke("window_list", control.Args{})
	if err != nil {
		t.Fatalf("window_list: %v", err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	if string(encoded) != "[]" {
		t.Fatalf("an empty window list encoded as %s", encoded)
	}
}

// The census answers who holds which name. A held name that answers nothing
// still holds it, and hiding it would send a restore into creating a second
// window under the same name.
func TestTheCensusCountsEveryHeldNameOnce(t *testing.T) {
	focused := liveWindow("win-a")
	focused.focused = true
	host := startedHost(liveWindow("main"), focused, &fakeWindow{name: "win-queued", live: false})
	registry := registryFor(t, host, counter("1"))

	result, err := registry.Invoke("window_census", control.Args{})
	if err != nil {
		t.Fatalf("window_census: %v", err)
	}
	var reply struct {
		Windows []censusRow `json:"windows"`
	}
	remarshal(t, result, &reply)

	if len(reply.Windows) != 3 {
		t.Fatalf("the census reported %d rows, want 3: %+v", len(reply.Windows), reply.Windows)
	}
	for _, row := range reply.Windows {
		if row.Hosts != 1 {
			t.Errorf("%s reported %d holders in a process that holds it once", row.Label, row.Hosts)
		}
		if row.Focused != (row.Label == "win-a") {
			t.Errorf("%s reported focused=%v", row.Label, row.Focused)
		}
	}
}

// A machine holding a window has a screen. An empty catalogue means the screens
// were never enumerated, and answering {"monitors":[]} makes that look like a
// machine with no displays.
func TestMonitorsWithNoScreensIsAnErrorAndNotAnEmptyList(t *testing.T) {
	host := startedHost(liveWindow("main"))
	host.displays = nil
	registry := registryFor(t, host, counter("1"))

	result, err := registry.Invoke("window_monitors", control.Args{})
	if err == nil {
		t.Fatalf("an unenumerated screen catalogue answered %v", result)
	}
}

func TestMonitorsReportsOneSpaceAndNoMonitorForAnOffscreenWindow(t *testing.T) {
	onScreen := liveWindow("main")
	onScreen.focused = true
	onScreen.frame = Frame{X: 100, Y: 100, W: 800, H: 600}
	offScreen := liveWindow("win-a")
	offScreen.frame = Frame{X: -9000, Y: -9000, W: 200, H: 200}

	host := startedHost(onScreen, offScreen, &fakeWindow{name: "win-queued", live: false})
	host.displays = []Display{leftDisplay, rightDisplay}
	registry := registryFor(t, host, counter("1"))

	result, err := registry.Invoke("window_monitors", control.Args{})
	if err != nil {
		t.Fatalf("window_monitors: %v", err)
	}
	var reply struct {
		Monitors []Display `json:"monitors"`
		Windows  []struct {
			Label   string `json:"label"`
			X       int    `json:"x"`
			Y       int    `json:"y"`
			W       int    `json:"w"`
			H       int    `json:"h"`
			Focused bool   `json:"focused"`
			Monitor *int   `json:"monitor"`
		} `json:"windows"`
		Space string `json:"space"`
	}
	remarshal(t, result, &reply)

	// The payload names its own coordinate space, because this host reads
	// window frames in points and calls them physical, so a caller cannot tell
	// from the numbers which space it received.
	if reply.Space != "dip" {
		t.Errorf("the payload declared space %q", reply.Space)
	}
	if len(reply.Monitors) != 2 {
		t.Fatalf("reported %d monitors, want 2", len(reply.Monitors))
	}
	if len(reply.Windows) != 2 {
		t.Fatalf("reported %d windows, want the 2 with a frame: %+v", len(reply.Windows), reply.Windows)
	}
	for _, window := range reply.Windows {
		switch window.Label {
		case "main":
			if window.Monitor == nil || *window.Monitor != 0 {
				t.Errorf("main answered monitor %s", showMonitor(window.Monitor))
			}
			if !window.Focused {
				t.Error("main holds the keyboard and reported otherwise")
			}
		case "win-a":
			if window.Monitor != nil {
				t.Errorf("an off-screen window answered monitor %d rather than none", *window.Monitor)
			}
		default:
			t.Errorf("a window with no frame was given one: %+v", window)
		}
	}
}

// The index a monitor is reported under and the index a window's verdict points
// at must be the same number. Letting the host stamp one and the verdict count
// the other sends a placement to a screen nobody chose, and both numbers look
// perfectly ordinary on the way.
func TestTheReportedMonitorIndexIsThePositionTheVerdictCounts(t *testing.T) {
	// A host that numbers its screens by something other than their position —
	// a display ID, a stale catalogue, a 1-based count.
	left := leftDisplay
	left.Index = 7
	right := rightDisplay
	right.Index = 3

	window := liveWindow("win-a")
	window.frame = Frame{X: 2000, Y: 200, W: 800, H: 600}
	host := startedHost(window)
	host.displays = []Display{left, right}
	registry := registryFor(t, host, counter("1"))

	result, err := registry.Invoke("window_monitors", control.Args{})
	if err != nil {
		t.Fatalf("window_monitors: %v", err)
	}
	var reply struct {
		Monitors []Display `json:"monitors"`
		Windows  []struct {
			Monitor *int `json:"monitor"`
		} `json:"windows"`
	}
	remarshal(t, result, &reply)

	for position, monitor := range reply.Monitors {
		if monitor.Index != position {
			t.Errorf("monitor at position %d reported index %d", position, monitor.Index)
		}
	}
	if len(reply.Windows) != 1 {
		t.Fatalf("reported %d windows, want 1", len(reply.Windows))
	}
	got := reply.Windows[0]
	if got.Monitor == nil || *got.Monitor != 1 {
		t.Fatalf("the window answered monitor %s, want 1 — the position of the screen holding it", showMonitor(got.Monitor))
	}
	if reply.Monitors[*got.Monitor].W != rightDisplay.W {
		t.Fatalf("monitor %d in the catalogue is not the screen the window is on", *got.Monitor)
	}
	// The host's own slice is not rewritten under it: a second reading would
	// otherwise depend on whether the first one happened.
	if host.displays[0].Index != 7 || host.displays[1].Index != 3 {
		t.Fatalf("the answer rewrote the host's catalogue: %+v", host.displays)
	}
}

// One coordinate space, no hidden conversion: a frame handed to window_place
// comes back from window_monitors unchanged.
func TestPlaceAndMonitorsShareOneCoordinateSpace(t *testing.T) {
	window := liveWindow("win-a")
	host := startedHost(window)
	host.displays = []Display{leftDisplay, rightDisplay}
	registry := registryFor(t, host, counter("1"))

	_, err := registry.Invoke("window_place", callArgs(t, map[string]any{
		"label": "win-a", "x": 1930, "y": 40, "w": 1200, "h": 900,
	}))
	if err != nil {
		t.Fatalf("window_place: %v", err)
	}

	result, err := registry.Invoke("window_monitors", control.Args{})
	if err != nil {
		t.Fatalf("window_monitors: %v", err)
	}
	var reply struct {
		Windows []struct {
			Label   string `json:"label"`
			X       int    `json:"x"`
			Y       int    `json:"y"`
			W       int    `json:"w"`
			H       int    `json:"h"`
			Monitor *int   `json:"monitor"`
		} `json:"windows"`
	}
	remarshal(t, result, &reply)

	if len(reply.Windows) != 1 {
		t.Fatalf("reported %d windows, want 1", len(reply.Windows))
	}
	got := reply.Windows[0]
	if got.X != 1930 || got.Y != 40 || got.W != 1200 || got.H != 900 {
		t.Fatalf("the placed frame read back as %+v; the two commands are in different spaces", got)
	}
	if got.Monitor == nil || *got.Monitor != 1 {
		t.Fatalf("the placed window answered monitor %s, want the right screen", showMonitor(got.Monitor))
	}
}

// A JSON null decodes into a Go number as a silent zero, so a caller that sends
// null for a coordinate would place the window at the edge of the screen and be
// told it worked.
func TestPlaceRefusesARectThatIsNotOne(t *testing.T) {
	cases := []map[string]any{
		{"label": "win-a", "x": "left", "y": 0, "w": 100, "h": 100},
		{"label": "win-a", "x": 0, "y": 0, "w": 0, "h": 100},
		{"label": "win-a", "x": 0, "y": 0, "w": 100, "h": -1},
		{"label": "win-a", "y": 0, "w": 100, "h": 100},
		{"label": "win-a", "x": nil, "y": 0, "w": 100, "h": 100},
		{"label": "win-a", "x": 0, "y": 0, "w": nil, "h": 100},
		{"label": nil, "x": 0, "y": 0, "w": 100, "h": 100},
		// Too large to arrive: the number wraps at the platform edge, so the
		// window lands somewhere nobody chose and the caller is told it worked.
		{"label": "win-a", "x": 1e300, "y": 0, "w": 100, "h": 100},
		{"label": "win-a", "x": 0, "y": 0, "w": 1e300, "h": 100},
	}
	for _, args := range cases {
		host := startedHost(liveWindow("win-a"))
		registry := registryFor(t, host, counter("1"))
		if _, err := registry.Invoke("window_place", callArgs(t, args)); err == nil {
			t.Errorf("window_place accepted %v", args)
		}
		if len(host.calls) != 0 {
			t.Errorf("window_place acted on %v: %v", args, host.calls)
		}
	}
}

// Activation is the application's business. Requiring a window is what made
// the same request fail when a workspace renderer asked for it, and with it
// went every keystroke that window's children were waiting for.
func TestActivationTakesNoWindowAndNeedsNoKeyWindow(t *testing.T) {
	host := startedHost(&fakeWindow{name: "win-a", live: true})
	registry := registryFor(t, host, counter("1"))

	if _, err := registry.Invoke("window_activate", control.Args{}); err != nil {
		t.Fatalf("window_activate: %v", err)
	}
	if !reflect.DeepEqual(host.calls, []string{"activate"}) {
		t.Fatalf("window_activate did more than activate the application: %v", host.calls)
	}
}

// A window this host owns is a window this host must be able to answer for, so
// the split is declared at registration rather than discovered by a caller.
func TestEveryCommandRegistersAsFrameworkOwned(t *testing.T) {
	registry := registryFor(t, startedHost(), counter("1"))
	owners := map[string]control.Owner{}
	for _, command := range registry.Describe().Commands {
		owners[command.Name] = command.Owner
	}
	for _, name := range windowCommands {
		owner, served := owners[name]
		if !served {
			t.Errorf("%s was not registered", name)
			continue
		}
		if owner != control.OwnerFramework {
			t.Errorf("%s registered as %q; a window cannot be created by a process that has none", name, owner)
		}
	}
}

// Registration happens at boot. A missing dependency there is a programming
// fact, and discovering it as a failed command means every window is already
// unreachable.
func TestRegisterRefusesAMissingDependency(t *testing.T) {
	for _, deps := range []Deps{
		{Host: nil, NewID: counter("1")},
		{Host: startedHost(), NewID: nil},
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("Register accepted %+v", deps)
				}
			}()
			Register(control.NewRegistry(), deps)
		}()
	}
}

// An effect that fails must reach the caller: swallowing it reports a window
// closed that is still open.
func TestAHostFailureReachesTheCaller(t *testing.T) {
	host := startedHost()
	host.openErr = errors.New("the platform refused")
	registry := registryFor(t, host, counter("1"))

	if _, err := registry.Invoke("window_create", control.Args{}); err == nil {
		t.Fatal("a refused creation was reported as a created window")
	}
}

func contains(values []string, want string) bool {
	return indexOf(values, want) >= 0
}

func indexOf(values []string, want string) int {
	for i, value := range values {
		if value == want {
			return i
		}
	}
	return -1
}

// remarshal reads a handler's answer the way a transport does, so a test never
// sees a shape the caller would not.
func remarshal(t *testing.T, value any, into any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding the answer: %v", err)
	}
	if err := json.Unmarshal(encoded, into); err != nil {
		t.Fatalf("decoding %s: %v", encoded, err)
	}
}

// The orchestrator is one window or none, and the launcher is the only thing
// that opens it. A command that could open it too makes "how many are there"
// depend on what anyone happened to call, and two identical windows is what a
// user sees when that goes wrong.
func TestTheControlPlaneWindowIsNotACommandsToCreate(t *testing.T) {
	host := startedHost()
	registry := registryFor(t, host, counter("1"))

	_, err := registry.Invoke("window_create", callArgs(t, map[string]any{"label": controlPlaneWindow}))
	if err == nil {
		t.Fatal("window_create opened the orchestrator")
	}
	if len(host.calls) != 0 {
		t.Errorf("window_create acted: %v", host.calls)
	}
}

// Asking for the one that exists answers with it and creates nothing. A caller
// that has to check first would race with a caller that did.
func TestAskingForTheControlPlaneWindowThatExistsIsIdempotent(t *testing.T) {
	host := startedHost(liveWindow(controlPlaneWindow))
	registry := registryFor(t, host, counter("1"))

	for range 3 {
		name, err := registry.Invoke("window_create", callArgs(t, map[string]any{"label": controlPlaneWindow}))
		if err != nil {
			t.Fatalf("window_create: %v", err)
		}
		if name != controlPlaneWindow {
			t.Fatalf("answered %v, want the window that is already open", name)
		}
	}
	if len(host.calls) != 0 {
		t.Errorf("repeating the request opened something: %v", host.calls)
	}
}

// A generated name can never be the orchestrator's, whatever the identifier
// source produces.
func TestAGeneratedNameIsNeverTheControlPlanes(t *testing.T) {
	host := startedHost()
	registry := registryFor(t, host, counter(controlPlaneWindow))

	name, err := registry.Invoke("window_create", nil)
	if err == nil && name == controlPlaneWindow {
		t.Fatal("a generated name collided with the orchestrator's")
	}
}

// The renderer writes its boot progress into the title, and that channel keeps
// answering when the binding path is dead. A census that dropped it would leave
// a window that renders the wrong shell looking exactly like one that renders
// the right one.
func TestTheCensusCarriesWhatEachWindowSaysItIs(t *testing.T) {
	main := liveWindow(controlPlaneWindow)
	main.title = "boot:render"
	workspace := liveWindow("win-a")
	workspace.title = "boot:persist-init"
	registry := registryFor(t, startedHost(main, workspace), counter("1"))

	reply, err := registry.Invoke("window_census", nil)
	if err != nil {
		t.Fatalf("window_census: %v", err)
	}
	census, ok := reply.(censusReply)
	if !ok {
		t.Fatalf("window_census answered %T", reply)
	}

	titles := map[string]string{}
	for _, row := range census.Windows {
		if row.Title == nil {
			t.Errorf("%s reported no title", row.Label)
			continue
		}
		titles[row.Label] = *row.Title
	}
	if titles[controlPlaneWindow] != "boot:render" {
		t.Errorf("%s reported %q", controlPlaneWindow, titles[controlPlaneWindow])
	}
	if titles["win-a"] != "boot:persist-init" {
		t.Errorf("win-a reported %q", titles["win-a"])
	}
}

// A window that cannot be asked leaves the field null. Empty would be a window
// that was given no title, which is a different fact — and losing the whole
// census because one window is unreachable hides the count this command exists
// to report.
func TestAWindowWithNoTitleLeavesTheFieldNullAndKeepsTheCount(t *testing.T) {
	host := startedHost(liveWindow(controlPlaneWindow), deadWindow("win-gone"))
	registry := registryFor(t, host, counter("1"))

	reply, err := registry.Invoke("window_census", nil)
	if err != nil {
		t.Fatalf("window_census: %v", err)
	}
	census := reply.(censusReply)
	if len(census.Windows) != 2 {
		t.Fatalf("the census reported %d windows, want both held names", len(census.Windows))
	}
	for _, row := range census.Windows {
		if row.Label == "win-gone" && row.Title != nil {
			t.Errorf("an unreachable window reported the title %q", *row.Title)
		}
	}
}
