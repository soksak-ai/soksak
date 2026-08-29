package process

import (
	"fmt"
	"sort"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// OwnedProcess is the generic process record shared by Core and external owners. Ownership is
// explicit; the aggregator never derives it from a pid or executable name.
type OwnedProcess struct {
	ID              string  `json:"id"`
	Owner           string  `json:"owner"`
	Window          *string `json:"window,omitempty"`
	Pane            *string `json:"pane,omitempty"`
	PID             uint32  `json:"pid"`
	ParentPID       uint32  `json:"parentPid"`
	Command         string  `json:"command"`
	State           string  `json:"state"`
	StartedAtUnixMs int64   `json:"startedAtUnixMs"`
	EndedAtUnixMs   *int64  `json:"endedAtUnixMs,omitempty"`
}

// OwnerInventory is one owner's monotonic snapshot.
type OwnerInventory struct {
	Owner     string         `json:"owner"`
	Revision  uint64         `json:"revision"`
	Processes []OwnedProcess `json:"processes"`
}

// Inventory is the Core answer consumed by the monitor. Sources are injected by the application
// boundary; this package does not discover sidecars or inspect their private state.
type Inventory struct {
	Owners []OwnerInventory `json:"owners"`
}

// InventorySource is the public boundary an external process owner implements.
type InventorySource interface {
	Inventory() (OwnerInventory, error)
}

func (manager *Manager) Inventory() (Inventory, error) {
	owners := make([]OwnerInventory, 0, len(manager.deps.InventorySources)+1)
	if own := manager.List(); len(own) > 0 {
		processes := make([]OwnedProcess, 0, len(own))
		for _, value := range own {
			state := "ended"
			if value.Alive {
				state = "running"
			}
			processes = append(processes, OwnedProcess{
				ID: fmt.Sprintf("core-process-%d", value.ID), Owner: "soksak-core", PID: uint32(value.PID),
				Window: value.Window, Command: value.Cmd, State: state,
			})
		}
		owners = append(owners, OwnerInventory{Owner: "soksak-core", Revision: 1, Processes: processes})
	}
	for _, source := range manager.deps.InventorySources {
		if source == nil {
			return Inventory{}, i18n.Errorf("process.inventory.nilSource", nil)
		}
		owner, err := source.Inventory()
		if err != nil {
			return Inventory{}, err
		}
		if owner.Owner == "" {
			return Inventory{}, i18n.Errorf("process.inventory.ownerEmpty", nil)
		}
		owners = append(owners, owner)
	}
	sort.Slice(owners, func(i, j int) bool { return owners[i].Owner < owners[j].Owner })
	return Inventory{Owners: owners}, nil
}
