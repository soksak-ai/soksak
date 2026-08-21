package sidecar

import (
	"bytes"
	"testing"
)

type recordingSink struct {
	bytes []Bytes
	ends  []End
}

func (sink *recordingSink) EmitSidecarBytes(value Bytes) Delivery {
	sink.bytes = append(sink.bytes, value)
	return Delivered
}

func (sink *recordingSink) EmitSidecarEnd(value End) Delivery {
	sink.ends = append(sink.ends, value)
	return Delivered
}

func TestStreamPumpUsesTheDeclaredByteAndEndReceivers(t *testing.T) {
	sink := &recordingSink{}
	pump(ioReadCloser{Reader: bytes.NewReader([]byte("output"))}, sink,
		"stm-bytes2", "stm-ended2", 32)
	if len(sink.bytes) != 1 || sink.bytes[0].Stream != "stm-bytes2" {
		t.Fatalf("byte receivers = %+v", sink.bytes)
	}
	if len(sink.ends) != 1 || sink.ends[0].Stream != "stm-ended2" {
		t.Fatalf("end receivers = %+v", sink.ends)
	}
}

type ioReadCloser struct{ *bytes.Reader }

func (ioReadCloser) Close() error { return nil }
