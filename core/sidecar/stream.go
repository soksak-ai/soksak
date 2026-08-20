package sidecar

import (
	"encoding/base64"
	"io"
)

// Where a unit's bytes reach whoever asked for them.
//
// The crossing differs per host — an event bus in a window, a socket in a headless server — so the
// concrete type stays outside this package. What does not vary is that a departed consumer comes
// back as a value: a pump that cannot learn its consumer is gone reads forever, and the unit on the
// other end fills its buffer until it blocks.

// Delivery reports whether a consumer is still there.
type Delivery int

const (
	Delivered Delivery = iota
	// Gone means the consumer left — a view unmounted, a window reloaded. The unit may still be
	// running; this stream stops, and nothing else does.
	Gone
)

// Bytes is one read from a unit's stream connection.
type Bytes struct {
	// Stream is the consumer's own name for this connection. It comes from the caller and nothing
	// here interprets it: two streams from one unit are two names the caller chose.
	Stream string `json:"stream"`
	// DataBase64 holds raw bytes. The crossing is JSON, and decoding here would corrupt every byte
	// that is not valid UTF-8 — which, on a stream carrying a program's output, is most of the
	// interesting ones.
	DataBase64 string `json:"dataBase64"`
}

// End is the last event of a stream: the connection closed, and why if there was a reason.
//
// It is separate from Bytes because "the unit stopped" is not a byte. A consumer folding the two
// would have to decide what an empty read means, and an empty read means nothing.
type End struct {
	Stream string `json:"stream"`
	Reason string `json:"reason,omitempty"`
}

// Sink is where a unit's stream arrives for a consumer.
type Sink interface {
	EmitSidecarBytes(Bytes) Delivery
	EmitSidecarEnd(End) Delivery
}

// openStream records a connection under the caller's label so one stream can be ended without
// ending the unit.
//
// A unit outlives any one connection to it. Closing the unit because a view unmounted would end
// every other view's stream on the same unit, which is a fault nobody would look for in the view
// that closed.
func (host *Host) openStream(label string, from io.ReadCloser) {
	host.mu.Lock()
	if host.streams == nil {
		host.streams = make(map[string]io.Closer)
	}
	previous := host.streams[label]
	host.streams[label] = from
	host.mu.Unlock()
	if previous != nil {
		// A label reused while its stream is live is the caller's own mistake, and leaving the first
		// one open would leak a connection nothing can name any more.
		_ = previous.Close()
	}
}

// CloseStream ends one stream. A label nobody opened is not an error: a caller disposing twice, or
// disposing after the unit ended it, is doing the right thing both times.
func (host *Host) CloseStream(label string) {
	host.mu.Lock()
	held := host.streams[label]
	delete(host.streams, label)
	host.mu.Unlock()
	if held != nil {
		_ = held.Close()
	}
}

func (host *Host) forgetStream(label string) {
	host.mu.Lock()
	delete(host.streams, label)
	host.mu.Unlock()
}

// pump moves a stream connection into a sink until one end stops.
//
// The read size is chosen here rather than by the contract: it is how much this process is willing
// to hold at once, not how much a unit may send. Delivery is what ends it early — a consumer that
// left is not an error, and treating it as one would report a closed view as a failed unit.
func pump(from io.ReadCloser, into Sink, stream string, size int) {
	defer func() { _ = from.Close() }()
	buffer := make([]byte, size)
	for {
		count, err := from.Read(buffer)
		if count > 0 {
			delivery := into.EmitSidecarBytes(Bytes{
				Stream:     stream,
				DataBase64: base64.StdEncoding.EncodeToString(buffer[:count]),
			})
			if delivery == Gone {
				return
			}
		}
		if err != nil {
			reason := ""
			if err != io.EOF {
				reason = err.Error()
			}
			into.EmitSidecarEnd(End{Stream: stream, Reason: reason})
			return
		}
	}
}

// DefaultReadSize is how much of a unit's stream this process holds at once.
//
// It matches what the pumps beside it read, so a unit producing at the same rate costs the same
// number of crossings on either of them.
const DefaultReadSize = 32 * 1024
