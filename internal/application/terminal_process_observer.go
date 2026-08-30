package application

import (
	"encoding/json"
	"io"
	"log"
	"sync"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	ptycontract "github.com/soksak-ai/soksak-contract-pty"
	"github.com/soksak-ai/soksak-core/core/sidecar"
)

type terminalProcessEventUnits interface {
	ObserveStarted(func(sidecar.Open)) func()
	Stream(string, controlwire.Request) (controlwire.Response, io.ReadCloser, error)
}

func observeTerminalProcessEvents(units terminalProcessEventUnits, emit func(string, any)) func() {
	var mu sync.Mutex
	readers := make(map[io.ReadCloser]struct{})
	stopped := false
	unsubscribe := units.ObserveStarted(func(open sidecar.Open) {
		if open.Name != ptycontract.SidecarName {
			return
		}
		go func() {
			request, err := json.Marshal(map[string]any{})
			if err != nil {
				return
			}
			response, reader, err := units.Stream(ptycontract.SidecarName, controlwire.Request{
				ID: "process-observe", Command: ptycontract.CommandProcessObserve,
				Args: map[string]json.RawMessage{"request": request},
			})
			if err != nil || !response.Ok || reader == nil {
				if err != nil {
					log.Printf("process observer unavailable: %v", err)
				}
				return
			}
			mu.Lock()
			if stopped {
				mu.Unlock()
				_ = reader.Close()
				return
			}
			readers[reader] = struct{}{}
			mu.Unlock()
			defer func() {
				mu.Lock()
				delete(readers, reader)
				mu.Unlock()
				_ = reader.Close()
			}()
			decoder := json.NewDecoder(reader)
			for {
				var event ptycontract.ProcessEvent
				if err := decoder.Decode(&event); err != nil {
					return
				}
				emit("process-inventory-changed", event)
			}
		}()
	})
	return func() {
		unsubscribe()
		mu.Lock()
		stopped = true
		for reader := range readers {
			_ = reader.Close()
		}
		mu.Unlock()
	}
}
