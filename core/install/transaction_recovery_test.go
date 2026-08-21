package install

import (
	"os"
	"path/filepath"
	"testing"

	composition "github.com/soksak-ai/soksak-contract-composition"
)

func TestRecoveryRollsBackPublishedUnitsBeforeSettingsCommit(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".transactions")
	transactionID := "tx-before"
	staged := filepath.Join(root, transactionID, "handle")
	final := filepath.Join(home, "installed", "plugin", "view", "0.0.1")
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
		t.Fatalf("published unit remains: %v", err)
	}
	if _, err := os.Stat(staged); !os.IsNotExist(err) {
		t.Fatalf("abandoned staging remains: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, transactionID)); !os.IsNotExist(err) {
		t.Fatalf("transaction remains: %v", err)
	}
}

func TestRecoveryCompletesJournalAfterSettingsCommit(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".transactions")
	transactionID := "tx-after"
	final := filepath.Join(home, "installed", "plugin", "view", "0.0.1")
	if err := os.MkdirAll(final, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, transactionID), 0o700); err != nil {
		t.Fatal(err)
	}
	settings := composition.Settings{Spec: composition.SettingsSpec, Generation: 1, Installations: []composition.Installation{}, Plugins: []composition.PluginSelection{}, Bindings: []composition.Binding{}}
	writeJSONFile(t, filepath.Join(home, composition.SettingsFile), settings)
	writeJSONFile(t, filepath.Join(root, transactionID, commitJournalFile), commitJournal{TransactionID: transactionID, PreviousGeneration: 0, Generation: 1, Moves: []journalMove{{Staged: filepath.Join(root, transactionID, "handle"), Final: final}}})
	if err := RecoverTransactions(home, root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(final); err != nil {
		t.Fatalf("committed unit was removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, transactionID)); !os.IsNotExist(err) {
		t.Fatalf("journal remains: %v", err)
	}
}
