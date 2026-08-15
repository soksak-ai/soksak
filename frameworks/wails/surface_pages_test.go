package wails

import (
	"reflect"
	"testing"

	"github.com/soksak/soksak-core/core/contentview"
)

// One report from a surface becomes the event the page already listens for.
//
// The native layer reports the whole state on every change, because reading a second property
// afterwards answers about a later moment. The page's vocabulary is narrower and older than that:
// a navigation, a title, and a load starting or stopping. So the split happens here, once, against
// what actually moved — fanning all three out on every change would emit a navigation every time a
// title arrived, and a consumer that resets the title on navigation would erase it.

type recordedEvent struct {
	name    string
	payload map[string]any
}

func recordingEmitter() (*[]recordedEvent, func(string, any)) {
	var seen []recordedEvent
	return &seen, func(name string, payload any) {
		seen = append(seen, recordedEvent{name: name, payload: payload.(map[string]any)})
	}
}

func TestAPageReportBecomesTheEventThatMoved(t *testing.T) {
	for _, probe := range []struct {
		changed string
		name    string
		payload map[string]any
	}{
		{"URL", contentview.Navigated, map[string]any{"label": "brw-a", "url": "https://example.com/", "inPage": false}},
		{"title", contentview.Title, map[string]any{"label": "brw-a", "title": "Example Domain"}},
		{"loading", contentview.Loading, map[string]any{"label": "brw-a", "loading": true, "canBack": true, "canForward": false}},
		{"estimatedProgress", contentview.Loading, map[string]any{"label": "brw-a", "loading": true, "canBack": true, "canForward": false}},
	} {
		seen, emit := recordingEmitter()
		PublishPageReport(emit)("brw-a", map[string]any{
			"label": "brw-a", "changed": probe.changed,
			"url": "https://example.com/", "title": "Example Domain",
			"loading": true, "progress": 0.4, "canBack": true, "canForward": false,
		})
		if len(*seen) != 1 {
			t.Fatalf("%s produced %d events, not 1: %v", probe.changed, len(*seen), *seen)
		}
		if (*seen)[0].name != probe.name {
			t.Errorf("%s produced %q, not %q", probe.changed, (*seen)[0].name, probe.name)
		}
		if !reflect.DeepEqual((*seen)[0].payload, probe.payload) {
			t.Errorf("%s carried %v, not %v", probe.changed, (*seen)[0].payload, probe.payload)
		}
	}
}

func TestAReportOfSomethingThePageHasNoEventForIsDropped(t *testing.T) {
	// Emitting under a name nobody listens for is invisible work that reads, from the outside,
	// exactly like an event that was never sent.
	seen, emit := recordingEmitter()
	PublishPageReport(emit)("brw-a", map[string]any{"label": "brw-a", "changed": "canGoBack"})
	if len(*seen) != 0 {
		t.Errorf("an unmapped change produced %v", *seen)
	}
}

func TestAReportWithNoLabelIsDropped(t *testing.T) {
	// Every consumer filters by label. A report without one is delivered to everyone or to no one,
	// and which of the two depends on how each consumer wrote its filter.
	seen, emit := recordingEmitter()
	PublishPageReport(emit)("", map[string]any{"changed": "title", "title": "Example Domain"})
	if len(*seen) != 0 {
		t.Errorf("a report with no label produced %v", *seen)
	}
}
