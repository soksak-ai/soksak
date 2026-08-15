package wails

import (
	"github.com/soksak/soksak-core/core/contentview"
)

// PublishPageReport turns one report from a native surface into the event the page listens for.
//
// The native layer reports the whole state on every change, because reading a second property
// afterwards answers about a later moment — a back button enabled a frame early is that difference
// made visible. The page's vocabulary is narrower: a navigation, a title, and a load starting or
// stopping.
//
// So the split happens here, once, against what actually moved. Fanning all three out on every
// change would emit a navigation each time a title arrived, and a consumer that resets the title on
// navigation would erase the title it had just been given.
//
// Nothing here names a plugin or an engine. The report is a surface id and a set of fields; which
// kind produced it is not a fact this needs.
func PublishPageReport(emit func(name string, payload any)) func(id string, report map[string]any) {
	return func(id string, report map[string]any) {
		// Every consumer filters by label, so a report without one is delivered to everyone or to
		// no one depending on how each filter was written.
		label, named := report["label"].(string)
		if !named || label == "" || id == "" {
			return
		}
		switch report["changed"] {
		case "URL":
			// inPage is false: this comes from the view's URL property, which the page half of the
			// old bridge could distinguish and this one cannot. Claiming true would tell a
			// consumer the document did not change when it may have.
			emit(contentview.Navigated, map[string]any{
				"label": label, "url": report["url"], "inPage": false,
			})
		case "title":
			emit(contentview.Title, map[string]any{"label": label, "title": report["title"]})
		case "loading", "estimatedProgress":
			emit(contentview.Loading, map[string]any{
				"label": label, "loading": report["loading"],
				"canBack": report["canBack"], "canForward": report["canForward"],
			})
		}
		// Anything else is dropped. Emitting under a name nobody listens for is invisible work that
		// reads, from outside, exactly like an event that was never sent.
	}
}
