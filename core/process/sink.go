package process

// Delivery says whether a consumer is still there.
//
// The departed answer is the whole reason this is a value and not a void
// return. A reader that cannot learn its consumer is gone keeps reading
// forever, and a reader that stops reading fills the child's pipe until the
// child blocks in write — which is how a kill stops working at all.
type Delivery int

const (
	Delivered Delivery = iota
	// Gone means the consumer left (a view unmounted, a window reloaded). The
	// child may still be alive; production must stop, draining must not.
	Gone
)

// Output is one read from one of a child's output pipes.
//
// Bytes travel base64-encoded because the crossing is JSON, matching the
// terminal plugin's Output. The read size is chosen in the pump, not here.
type Output struct {
	ID     uint32 `json:"id"`
	Stream string `json:"stream"`
	// DataBase64 carries raw bytes: a child's stdout is not text, and decoding
	// it here would corrupt every non-UTF-8 byte a sidecar frame contains.
	DataBase64 string `json:"dataBase64"`
}

// Exit is the last event of a stream: one integer.
//
// It is not folded into Output because an exit code is not part of the byte
// stream, and a consumer receives a number rather than bytes.
type Exit struct {
	ID uint32 `json:"id"`
	// Code is -1 when the child left no code of its own (signalled, or its
	// status could not be read).
	Code int `json:"code"`
}

// Sink is where a child's output and its exit reach a consumer.
//
// The crossing differs per host — an event bus here, a socket elsewhere — so
// the concrete type stays outside this package. What does not vary is that a
// departed consumer comes back as a value.
type Sink interface {
	EmitProcessOutput(Output) Delivery
	EmitProcessExit(Exit) Delivery
}

const (
	// Output stream names, as the consumer sees them.
	streamStdout = "stdout"
	streamStderr = "stderr"
)
