package application

import (
	"encoding/json"
	"fmt"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	ptycontract "github.com/soksak-ai/soksak-contract-pty"
	"github.com/soksak-ai/soksak-core/core/process"
	"github.com/soksak-ai/soksak-core/core/sidecar"
)

// terminalProcessInventorySource is an adapter at the application boundary. It uses only the
// public PTY wire and the sidecar host; it never imports the PTY implementation.
type terminalProcessInventorySource struct{ units terminalUnitHost }

func (source terminalProcessInventorySource) Inventory() (process.OwnerInventory, error) {
	started, canList := source.units.(interface{ Started() []sidecar.Open })
	if canList {
		present := false
		for _, unit := range started.Started() {
			if unit.Name == ptycontract.SidecarName {
				present = true
				break
			}
		}
		if !present {
			return process.OwnerInventory{Owner: ptycontract.SidecarName}, nil
		}
	}
	payload, err := json.Marshal(map[string]any{})
	if err != nil {
		return process.OwnerInventory{}, err
	}
	response, err := source.units.Send(ptycontract.SidecarName, controlwire.Request{
		ID: "process-inventory", Command: ptycontract.CommandProcessInventory,
		Args: map[string]json.RawMessage{"request": payload},
	})
	if err != nil {
		return process.OwnerInventory{}, err
	}
	if !response.Ok {
		return process.OwnerInventory{}, fmt.Errorf("%s: %s", ptycontract.CommandProcessInventory, response.Error)
	}
	encoded, err := json.Marshal(response.Result)
	if err != nil {
		return process.OwnerInventory{}, err
	}
	var answer struct {
		Code string                       `json:"code"`
		Data ptycontract.ProcessInventory `json:"data"`
	}
	if err := json.Unmarshal(encoded, &answer); err != nil {
		return process.OwnerInventory{}, err
	}
	if answer.Code != "" && answer.Code != "OK" {
		return process.OwnerInventory{}, fmt.Errorf("%s: %s", ptycontract.CommandProcessInventory, answer.Code)
	}
	owner := process.OwnerInventory{Owner: ptycontract.SidecarName, Revision: answer.Data.Revision, Processes: make([]process.OwnedProcess, 0, len(answer.Data.Processes))}
	for _, value := range answer.Data.Processes {
		owner.Processes = append(owner.Processes, process.OwnedProcess{
			ID: value.ID, Owner: value.Owner, Window: value.Window, Pane: value.Pane,
			PID: value.PID, ParentPID: value.ParentPID, Command: value.Command, State: value.State,
			StartedAtUnixMs: value.StartedAtUnixMs, EndedAtUnixMs: value.EndedAtUnixMs,
		})
	}
	return owner, nil
}
