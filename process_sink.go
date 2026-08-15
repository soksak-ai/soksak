package main

import (
	"github.com/soksak/soksak-core/core/process"
	"github.com/soksak/soksak-core/frameworks/wails"
)

// processEventSink delivers a child's output and exit to the windows.
//
// Delivery is the sink's answer to "is anyone still reading this", and it is
// what stops a child producing into nothing. This host can answer it at one
// resolution only: the framework's event bus does not report its listeners, so
// the last live window going away is the only departure it can observe.
//
// The consequence is stated rather than hidden: a pane that unmounts while its
// window stays open keeps its child producing. Closing that gap needs a
// per-view acknowledgement, which is the view registry's to own — not something
// this sink can infer.
type processEventSink struct{ bridge *wails.Bridge }

func (sink processEventSink) EmitProcessOutput(output process.Output) process.Delivery {
	return sink.deliver("process:output", output)
}

func (sink processEventSink) EmitProcessExit(exit process.Exit) process.Delivery {
	return sink.deliver("process:exit", exit)
}

func (sink processEventSink) deliver(event string, payload any) process.Delivery {
	if len(sink.bridge.Live()) == 0 {
		// No window exists, so no view can be reading. Draining continues; the
		// manager stops production.
		return process.Gone
	}
	sink.bridge.Emit(event, payload)
	return process.Delivered
}
