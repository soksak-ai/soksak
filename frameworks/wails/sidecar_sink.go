package wails

import (
	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/sidecar"
)

// Where a unit's stream bytes reach the document.
//
// One event delivers every stream's frames, the same one every other producer uses. A backend that
// invented an event per feature would have the frontend refuse each one it never declared, and the
// refusal reads as a broken feature rather than as an undeclared name.
//
// Nothing here is about any particular unit: the stream label came from the caller and the bytes are
// whatever the unit wrote.
type SidecarSink struct{ bridge *Bridge }

func NewSidecarSink(bridge *Bridge) *SidecarSink { return &SidecarSink{bridge: bridge} }

// EmitSidecarBytes delivers one read, and reports whether anyone is still there.
//
// A departed consumer comes back as a value rather than an error, and it has to: a pump that cannot
// learn its consumer is gone reads forever, and the unit on the other end fills its buffer until it
// blocks — which is indistinguishable from a unit that stopped.
func (sink *SidecarSink) EmitSidecarBytes(bytes sidecar.Bytes) sidecar.Delivery {
	return sink.deliver(bytes.Stream, control.StreamBytes{Bytes: bytes.DataBase64})
}

func (sink *SidecarSink) EmitSidecarEnd(end sidecar.End) sidecar.Delivery {
	return sink.deliver(end.Stream, map[string]string{"reason": end.Reason})
}

func (sink *SidecarSink) deliver(stream string, frame any) sidecar.Delivery {
	if sink.bridge == nil || len(sink.bridge.Live()) == 0 {
		// No window is open, so nobody is reading. That is the truth rather than a dropped
		// delivery, and reporting it as one would make the pump keep reading into nothing.
		return sidecar.Gone
	}
	sink.bridge.Emit(control.StreamEvent, control.StreamFrame{Stream: stream, Frame: frame})
	return sidecar.Delivered
}
