package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	coreenvironment "github.com/soksak-ai/soksak-core/core/environment"
)

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRecoveryRollsBackPublishedContentBeforeEnvironmentCommit(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".transactions")
	transactionID := "tx-before"
	staged := filepath.Join(root, transactionID, "handle")
	final := filepath.Join(home, "components", "plugin", "view", "0.0.1")
	if err := os.MkdirAll(final, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, transactionID), 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, filepath.Join(root, transactionID, commitJournalFile), commitJournal{TransactionID: transactionID, PreviousGeneration: 0, Generation: 1, Moves: []journalMove{{Staged: staged, Final: final}}})
	if err := RecoverTransactions(home, root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(final); !os.IsNotExist(err) {
		t.Fatalf("published artifact remains: %v", err)
	}
	if _, err := os.Stat(staged); !os.IsNotExist(err) {
		t.Fatalf("abandoned staging remains: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, transactionID)); !os.IsNotExist(err) {
		t.Fatalf("transaction remains: %v", err)
	}
}

func TestRecoveryCompletesJournalAfterEnvironmentCommit(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".transactions")
	transactionID := "tx-after"
	final := filepath.Join(home, "components", "plugin", "view", "0.0.1")
	if err := os.MkdirAll(final, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, transactionID), 0o700); err != nil {
		t.Fatal(err)
	}
	environment := coreenvironment.Empty()
	writeJSONFile(t, filepath.Join(home, coreenvironment.File), environment)
	writeJSONFile(t, filepath.Join(root, transactionID, commitJournalFile), commitJournal{TransactionID: transactionID, PreviousGeneration: 0, Generation: 1, Moves: []journalMove{{Staged: filepath.Join(root, transactionID, "handle"), Final: final}}})
	if err := RecoverTransactions(home, root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(final); err != nil {
		t.Fatalf("committed artifact was removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, transactionID)); !os.IsNotExist(err) {
		t.Fatalf("journal remains: %v", err)
	}
}
