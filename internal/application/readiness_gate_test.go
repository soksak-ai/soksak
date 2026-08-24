//go:build applicationgate

package application

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
)

type gateControlReadyWriter struct {
	mu      sync.Mutex
	pending []byte
	events  chan controlReadyEvent
}

func newGateControlReadyWriter() *gateControlReadyWriter {
	return &gateControlReadyWriter{events: make(chan controlReadyEvent, 1)}
}

func (writer *gateControlReadyWriter) Write(payload []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.pending = append(writer.pending, payload...)
	for {
		newline := bytes.IndexByte(writer.pending, '\n')
		if newline < 0 {
			break
		}
		line := append([]byte(nil), writer.pending[:newline]...)
		writer.pending = writer.pending[newline+1:]
		var event controlReadyEvent
		if json.Unmarshal(line, &event) == nil && event.Event == "soksak.host.ready" {
			select {
			case writer.events <- event:
			default:
			}
		}
	}
	return len(payload), nil
}

func TestGateControlReadyWriterConsumesASplitEvent(t *testing.T) {
	writer := newGateControlReadyWriter()
	_, _ = writer.Write([]byte("noise\n{\"event\":\"soksak.host."))
	_, _ = writer.Write([]byte("ready\",\"protocol\":1,\"socket\":\"<local-evidence>/gate.sock\",\"identifier\":\"com.soksak.gate\",\"pid\":42}\n"))
	select {
	case event := <-writer.events:
		if event.Protocol != 1 || event.Socket != "<local-evidence>/gate.sock" || event.Identifier != "com.soksak.gate" || event.PID != 42 {
			t.Fatalf("event=%+v", event)
		}
	default:
		t.Fatal("readiness event was not published")
	}
}
