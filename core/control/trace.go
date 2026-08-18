package control

// A diagnostic record, from whoever produced it to wherever a developer reads.
//
// The producer names its own subject, in its own shape. This is what a
// host has to offer for any of them to be readable, and it is deliberately the
// smallest thing that can carry one: a name for the kind, and the record.
//
// Written because there was no such contract and the gap showed. The Wails host
// took `EmitTerminalInputTrace(terminal.Handle, terminal.InputTrace)` — the
// terminal plugin's own types, in a host that is meant to know no plugin — for
// a method whose whole body marshals its arguments and logs them. Beside it,
// `EmitStream(stream string, frame any)` did the same work for output and named
// nothing, which is the shape a trace should have had all along.
//
// A record is data, not a sentence: it goes to a log a developer reads, so it
// stays in English under 6-1 and holds no key (I18N I1).
type TraceSink interface {
	// Trace takes one record. `kind` names what produced it, dotted and
	// lower-case — `terminal.input`, `browser.navigation`. The record is
	// whatever that producer holds; a host that cannot encode it drops the
	// record rather than the process, because a diagnostic channel that can
	// stop the thing it observes is worse than no channel.
	Trace(kind string, record any)
}

// TraceKind is the name a producer traces under.
//
// A constant per producer rather than a string at the call site: two spellings
// of one kind are two channels nobody can grep for at once, and the day one is
// renamed the other keeps writing under the old name.
type TraceKind = string
