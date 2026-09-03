package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	coreenvironment "github.com/soksak-ai/soksak-core/core/environment"
	"github.com/soksak-ai/soksak-core/core/i18n"

	"github.com/soksak-ai/soksak-core/core/atomicfile"
)

const commitJournalFile = "commit.json"

type journalMove struct {
	Staged string `json:"staged"`
	Final  string `json:"final"`
}
type commitJournal struct {
	TransactionID      string        `json:"transactionId"`
	PreviousGeneration uint64        `json:"previousGeneration"`
	Generation         uint64        `json:"generation"`
	Moves              []journalMove `json:"moves"`
}

func RecoverTransactions(home, root string) error {
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	environment, exists, err := coreenvironment.Read(home)
	if err != nil {
		return err
	}
	generation := uint64(0)
	if exists {
		generation = environment.Revision
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		transactionRoot := filepath.Join(root, entry.Name())
		body, err := os.ReadFile(filepath.Join(transactionRoot, commitJournalFile))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		var journal commitJournal
		if err := json.Unmarshal(body, &journal); err != nil {
			return fmt.Errorf("read installer commit journal: %w", err)
		}
		if journal.TransactionID != entry.Name() {
			return i18n.Errorf("install.transaction.journalIdentity", nil)
		}
		if generation < journal.Generation {
			for index := len(journal.Moves) - 1; index >= 0; index-- {
				move := journal.Moves[index]
				if _, err := os.Lstat(move.Final); os.IsNotExist(err) {
					continue
				} else if err != nil {
					return err
				}
				if err := os.MkdirAll(filepath.Dir(move.Staged), 0o700); err != nil {
					return err
				}
				if err := os.Rename(move.Final, move.Staged); err != nil {
					return err
				}
			}
		} else if generation != journal.Generation {
			return i18n.Errorf("install.transaction.journalGeneration", nil)
		}
		if err := os.RemoveAll(transactionRoot); err != nil {
			return err
		}
	}
	return nil
}

func writeCommitJournal(root string, journal commitJournal) error {
	body, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return err
	}
	// Published rather than written into. This journal is read after a crash, which is the moment a
	// write into it would have been interrupted, so a torn journal is read exactly when it matters.
	path := filepath.Join(root, journal.TransactionID, commitJournalFile)
	return atomicfile.Publish(path, append(body, byte(10)), 0o600)
}
