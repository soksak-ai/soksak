package control

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/i18n"
)

// A caller's language is put in front of the handler that answers them.
//
// Answer parses it and renders a Go refusal at the edge, which covers everything this process
// writes. It does not cover a window: a delegated command runs in a page with its own display
// language, and that page has no way to learn what the caller reads. Measured 2026-08-16, an
// English sok call answered TARGET_NOT_FOUND with its sentence in Korean, because the window
// rendered in its own language and nothing had told it otherwise.
//
// The language is stamped onto the arguments, the same way the calling window is. A caller may
// send the name and is never believed; the transport overwrites it.
func TestTheCallersLanguageIsStampedOntoTheArguments(t *testing.T) {
	registry := NewRegistry()
	var seen Args
	registry.MustRegister(Command{
		Name:  "probe",
		Owner: OwnerCore,
		Handler: func(args Args) (any, error) {
			seen = args
			return map[string]any{}, nil
		},
	})

	if _, err := registry.InvokeFrom(Caller{Window: "win-a", Language: i18n.Korean}, "probe", Args{}); err != nil {
		t.Fatalf("invoking: %v", err)
	}
	raw, stamped := seen[CallerLanguageArgument]
	if !stamped {
		t.Fatal("the handler was not told what the caller reads")
	}
	var language string
	if err := json.Unmarshal(raw, &language); err != nil {
		t.Fatalf("decoding the stamp: %v", err)
	}
	if language != "ko" {
		t.Errorf("the stamp says %q", language)
	}
}

func TestACallerWhoNamesNoLanguageLeavesNoStamp(t *testing.T) {
	// Absent is a fact, and a window with no stamp answers in its own language, which is what it
	// did before there was a stamp at all. Filling in English here would make every unlabelled
	// caller silently override a window's own setting.
	registry := NewRegistry()
	var seen Args
	registry.MustRegister(Command{
		Name:    "probe",
		Owner:   OwnerCore,
		Handler: func(args Args) (any, error) { seen = args; return map[string]any{}, nil },
	})
	if _, err := registry.InvokeFrom(Caller{Window: "win-a"}, "probe", Args{
		CallerLanguageArgument: json.RawMessage(`"ko"`),
	}); err != nil {
		t.Fatalf("invoking: %v", err)
	}
	if _, stamped := seen[CallerLanguageArgument]; stamped {
		// A caller who supplies it and is not contradicted would be believed by omission.
		t.Error("a language the caller sent itself was left in place")
	}
}

func TestTheAnswerCarriesTheLanguageToTheDelegate(t *testing.T) {
	// The whole point: a window answering a delegated command receives what the caller reads.
	registry := NewRegistry()
	var seen Args
	if err := registry.Delegate("win/main", OwnerPlugin, []string{"pane.list"},
		func(_ string, args Args) (any, error) { seen = args; return map[string]any{}, nil }); err != nil {
		t.Fatalf("delegating: %v", err)
	}

	response := Answer(registry, "app", Request{
		ID: "1", Command: "pane.list", Language: "en",
	})
	if response.Error != "" {
		t.Fatalf("answering: %s", response.Error)
	}
	raw, stamped := seen[CallerLanguageArgument]
	if !stamped {
		t.Fatal("the delegate was not told what the caller reads")
	}
	if !strings.Contains(string(raw), "en") {
		t.Errorf("the delegate was told %s", raw)
	}
}
