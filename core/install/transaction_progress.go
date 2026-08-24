package install

import (
	"strconv"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

const ArtifactInstallProgressEvent = "artifact.install.progress"

type ArtifactInstallProgress struct {
	Sequence      uint64           `json:"sequence"`
	TransactionID string           `json:"transactionId"`
	RegistryID    string           `json:"registryId"`
	Root          ArtifactIdentity `json:"root"`
	Component     ArtifactIdentity `json:"component"`
	Phase         string           `json:"phase"`
	ReceivedBytes uint64           `json:"receivedBytes"`
	TotalBytes    uint64           `json:"totalBytes"`
}

func (manager *TransactionManager) recordProgress(value ArtifactInstallProgress) ArtifactInstallProgress {
	manager.mu.Lock()
	manager.progressSequence++
	value.Sequence = manager.progressSequence
	manager.progress[value.Root.ID] = value
	waiters := make([]chan ArtifactInstallProgress, 0, len(manager.progressWaiters[value.Root.ID]))
	for _, waiter := range manager.progressWaiters[value.Root.ID] {
		waiters = append(waiters, waiter)
	}
	manager.mu.Unlock()
	for _, waiter := range waiters {
		select {
		case waiter <- value:
		default:
		}
	}
	if manager.progressChanged != nil {
		manager.progressChanged(ArtifactInstallProgressEvent, value)
	}
	return value
}

func (manager *TransactionManager) Progress(rootID string) (ArtifactInstallProgress, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	value, found := manager.progress[rootID]
	if !found {
		return ArtifactInstallProgress{}, i18n.Errorf("install.progress.notFound", map[string]string{"id": rootID})
	}
	return value, nil
}

func (manager *TransactionManager) WaitProgress(rootID string, afterSequence uint64, timeout time.Duration) (ArtifactInstallProgress, error) {
	manager.mu.Lock()
	if current, found := manager.progress[rootID]; found && current.Sequence > afterSequence {
		manager.mu.Unlock()
		return current, nil
	}
	manager.progressWaiterSequence++
	wid := manager.progressWaiterSequence
	if manager.progressWaiters[rootID] == nil {
		manager.progressWaiters[rootID] = map[uint64]chan ArtifactInstallProgress{}
	}
	updates := make(chan ArtifactInstallProgress, 1)
	manager.progressWaiters[rootID][wid] = updates
	manager.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	defer func() {
		manager.mu.Lock()
		delete(manager.progressWaiters[rootID], wid)
		if len(manager.progressWaiters[rootID]) == 0 {
			delete(manager.progressWaiters, rootID)
		}
		manager.mu.Unlock()
	}()
	select {
	case value := <-updates:
		return value, nil
	case <-timer.C:
		return ArtifactInstallProgress{}, i18n.Errorf("install.progress.timedOut", map[string]string{
			"id": rootID, "sequence": strconv.FormatUint(afterSequence, 10), "timeout": timeout.String(),
		})
	}
}
