package session

import controlwire "github.com/soksak-ai/soksak-contract-control"

// Delivery is one notice and the view it goes to.
//
// The core delivers it and does not act on it. What an attachment does with the news is that
// component's: the core owns which sessions exist, never what a session's content means.
type Delivery struct {
	ViewID string                    `json:"viewId"`
	Notice controlwire.SessionNotice `json:"notice"`
}

// Notices is what goes out after an owner stood its sessions back up.
//
// One per attached session with an outcome. A session nothing is attached to has nobody to tell,
// and one whose owner answered nothing has no restore to report: emitting a notice for either would
// state something that did not happen or send it nowhere.
func Notices(listed []Listed) []Delivery {
	deliveries := make([]Delivery, 0, len(listed))
	for _, one := range listed {
		if one.ViewID == "" || one.Outcome == "" {
			continue
		}
		deliveries = append(deliveries, Delivery{
			ViewID: one.ViewID,
			Notice: controlwire.SessionNotice{
				Session: one.Session,
				Owner:   one.Owner,
				Outcome: one.Outcome,
				Reason:  one.Reason,
			},
		})
	}
	return deliveries
}
