package session

import (
	"sort"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// Ask puts the session question to one owner. The core does not know what an owner is beyond the
// name the index holds, and this is the whole of what it needs from one.
type Ask func(owner string, sessions []string) (controlwire.SessionReport, error)

// Listed is one session as the core reports it.
type Listed struct {
	Session     string `json:"session"`
	Owner       string `json:"owner"`
	State       string `json:"state"`
	WindowLabel string `json:"windowLabel"`
	ViewID      string `json:"viewId"`
	// Outcome is what the owner's last start ended in for this session. Empty when the owner
	// answered nothing, which is a different thing from an owner that answered and said lost.
	Outcome string `json:"outcome,omitempty"`
	// Reason states what stopped a failed restore. Empty for every other outcome.
	Reason string `json:"reason,omitempty"`
}

// List answers every session in the index with the state it is in.
//
// One round trip per owner rather than one per session. An owner holding sixteen panes would
// otherwise be asked sixteen times for one fact it already has in hand.
func List(index []Entry, ask Ask) ([]Listed, error) {
	byOwner := map[string][]string{}
	for _, entry := range index {
		byOwner[entry.Owner] = append(byOwner[entry.Owner], entry.Session)
	}

	// reports holds what each owner answered, and answered holds whether it answered at all. An
	// owner that is not running answers nothing, and its sessions wait for it rather than being
	// counted as gone.
	reports := map[string]map[string]controlwire.SessionOutcome{}
	answered := map[string]bool{}
	for owner, sessions := range byOwner {
		sort.Strings(sessions)
		report, err := ask(owner, sessions)
		if err != nil {
			continue
		}
		// An unfinished report is not a final one. Taking it as final would count a session lost
		// that the owner had not looked for yet.
		if !report.Complete {
			continue
		}
		answered[owner] = true
		outcomes := make(map[string]controlwire.SessionOutcome, len(report.Sessions))
		for _, outcome := range report.Sessions {
			outcomes[outcome.Session] = outcome
		}
		reports[owner] = outcomes
	}

	listed := make([]Listed, 0, len(index))
	for _, entry := range index {
		outcome := reports[entry.Owner][entry.Session]
		listed = append(listed, Listed{
			Session:     entry.Session,
			Owner:       entry.Owner,
			State:       StateOf(outcome.Outcome, answered[entry.Owner], entry.Shown),
			WindowLabel: entry.WindowLabel,
			ViewID:      entry.ViewID,
			Outcome:     outcome.Outcome,
			Reason:      outcome.Reason,
		})
	}
	sort.Slice(listed, func(left, right int) bool {
		return listed[left].Session < listed[right].Session
	})
	return listed, nil
}

// ListIn answers every session in the index, asking each owner in the window that owner's sessions
// were last shown in.
//
// Grouping by owner alone was enough while every owner answered over its own socket. A plugin
// answers in a window, so the group is the owner and the window together: one round trip per
// (owner, window) rather than one per session, and never one that names no window at all.
func ListIn(index []Entry, router Router) ([]Listed, error) {
	byPlace := map[[2]string][]string{}
	for _, entry := range index {
		byPlace[[2]string{entry.Owner, entry.WindowLabel}] = append(
			byPlace[[2]string{entry.Owner, entry.WindowLabel}], entry.Session)
	}

	reports := map[string]map[string]controlwire.SessionOutcome{}
	answered := map[string]bool{}
	for place, sessions := range byPlace {
		sort.Strings(sessions)
		report, err := router.In(place[1])(place[0], sessions)
		if err != nil || !report.Complete {
			// An owner that answered nothing, or answered an unfinished read, leaves its sessions
			// waiting for it rather than counted as gone.
			continue
		}
		answered[place[0]] = true
		outcomes := reports[place[0]]
		if outcomes == nil {
			outcomes = map[string]controlwire.SessionOutcome{}
			reports[place[0]] = outcomes
		}
		for _, outcome := range report.Sessions {
			outcomes[outcome.Session] = outcome
		}
	}

	listed := make([]Listed, 0, len(index))
	for _, entry := range index {
		outcome := reports[entry.Owner][entry.Session]
		listed = append(listed, Listed{
			Session:     entry.Session,
			Owner:       entry.Owner,
			State:       StateOf(outcome.Outcome, answered[entry.Owner], entry.Shown),
			WindowLabel: entry.WindowLabel,
			ViewID:      entry.ViewID,
			Outcome:     outcome.Outcome,
			Reason:      outcome.Reason,
		})
	}
	sort.Slice(listed, func(left, right int) bool {
		return listed[left].Session < listed[right].Session
	})
	return listed, nil
}

// windowOf is the window one session was last shown in, or empty when the index holds none.
func windowOf(index []Entry, session string) string {
	for _, entry := range index {
		if entry.Session == session {
			return entry.WindowLabel
		}
	}
	return ""
}
