package control

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// recordingNotifier is a host that shows notifications and remembers them.
type recordingNotifier struct {
	shown  []Notice
	refuse error
}

func (notifier *recordingNotifier) Show(notice Notice) error {
	if notifier.refuse != nil {
		return notifier.refuse
	}
	notifier.shown = append(notifier.shown, notice)
	return nil
}

func TestShowCarriesTheClicksDestinationToTheHost(t *testing.T) {
	// The deep link is the whole of what a click does. A notification shown
	// without it looks identical on screen and does nothing when pressed.
	notifier := &recordingNotifier{}
	registry := NewRegistry()
	Register(registry, Deps{Notify: notifier})

	answer, err := registry.Invoke(commandNotifyShow, argsOf(t, map[string]any{
		"title": "deploy finished",
		"body":  "the prod deploy finished",
		"extra": map[string]any{"deepLink": "soksak-dev://cmd/window.projects"},
	}))
	if err != nil {
		t.Fatalf("notify_show: %v", err)
	}
	if len(notifier.shown) != 1 {
		t.Fatalf("the host was handed %d notification(s)", len(notifier.shown))
	}
	notice := notifier.shown[0]
	if notice.Title != "deploy finished" || notice.Body != "the prod deploy finished" {
		t.Errorf("the host was handed %+v", notice)
	}
	if notice.DeepLink != "soksak-dev://cmd/window.projects" {
		t.Errorf("deep link = %q", notice.DeepLink)
	}
	if notice.Handle == 0 {
		t.Error("handle 0 is what a caller reads as none")
	}

	// The caller reads r.handle off this answer to reach the notification again.
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatalf("encoding the answer: %v", err)
	}
	if !strings.HasPrefix(string(encoded), `{"handle":`) {
		t.Errorf("notify_show answered %s", encoded)
	}
}

func TestNoDeepLinkIsEmptyRatherThanTheFourBytesNull(t *testing.T) {
	// The transport sends {"deepLink": null} for a notification carrying
	// nothing. A host handed the string "null" would try to open it as a URI.
	notifier := &recordingNotifier{}
	registry := NewRegistry()
	Register(registry, Deps{Notify: notifier})

	if _, err := registry.Invoke(commandNotifyShow, argsOf(t, map[string]any{
		"title": "build failed", "body": "", "extra": map[string]any{"deepLink": nil},
	})); err != nil {
		t.Fatalf("notify_show: %v", err)
	}
	if notifier.shown[0].DeepLink != "" {
		t.Errorf("deep link = %q, want empty", notifier.shown[0].DeepLink)
	}
}

func TestEachNotificationGetsItsOwnHandle(t *testing.T) {
	// A reused handle lets a stale caller activate whatever took its place.
	notifier := &recordingNotifier{}
	registry := NewRegistry()
	Register(registry, Deps{Notify: notifier})

	seen := map[uint64]bool{}
	for index := 0; index < 3; index++ {
		if _, err := registry.Invoke(commandNotifyShow, argsOf(t, map[string]any{
			"title": "t", "body": "b",
		})); err != nil {
			t.Fatalf("notify_show: %v", err)
		}
	}
	for _, notice := range notifier.shown {
		if seen[notice.Handle] {
			t.Fatalf("handle %d names two notifications", notice.Handle)
		}
		seen[notice.Handle] = true
	}
}

func TestAShowThatFailedAnswersNoHandle(t *testing.T) {
	// A handle for a notification that is not on screen is an address the next
	// command fails against, somewhere else.
	notifier := &recordingNotifier{refuse: errors.New("notifications are turned off")}
	registry := NewRegistry()
	Register(registry, Deps{Notify: notifier})

	answer, err := registry.Invoke(commandNotifyShow, argsOf(t, map[string]any{
		"title": "t", "body": "b",
	}))
	if err == nil {
		t.Fatalf("a failed show answered %v", answer)
	}
	if !strings.Contains(err.Error(), "notifications are turned off") {
		t.Errorf("the failure reads %q and loses what the host said", err)
	}
}

func TestATitlelessNotificationIsRefused(t *testing.T) {
	registry := NewRegistry()
	Register(registry, Deps{Notify: &recordingNotifier{}})

	if _, err := registry.Invoke(commandNotifyShow, argsOf(t, map[string]any{
		"title": "", "body": "b",
	})); err == nil {
		t.Fatal("a notification with no title is one the user cannot attribute")
	}
}

func TestNoNotificationBackendIsRefusedRatherThanSilentlySucceeding(t *testing.T) {
	registry := NewRegistry()
	Register(registry, Deps{})

	_, err := registry.Invoke(commandNotifyShow, argsOf(t, map[string]any{
		"title": "t", "body": "b",
	}))
	if err == nil {
		t.Fatal("a process with no backend must not answer as though it showed something")
	}
	if !strings.Contains(err.Error(), "no notification backend") {
		t.Errorf("the refusal reads %q", err)
	}
}
