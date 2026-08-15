package control

import (
	"fmt"
	"sync/atomic"

	"github.com/soksak/soksak-core/core/i18n"
)

// One notification, and who owns which half of it.
//
// The core owns the handle and the deep link, because both are host-independent
// facts: a number that names one notification, and the command a click runs.
// What a notification looks like is not — it needs a platform, so the host
// supplies the Notifier.
//
// No table of shown notifications is kept here. The host holds the operating
// system's own object for each one and is the only thing that can act on it; a
// second table in the core would be a second answer to "which notifications
// exist", and the two disagree the moment the user dismisses one.

// Notice is one notification, as the core hands it to the host.
type Notice struct {
	// Handle names this notification so a later command can reach the one that
	// was shown. It is never zero: zero is what a caller reads as "none".
	Handle uint64 `json:"handle"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	// DeepLink is what a click runs (soksak[-env]://cmd/<name>). Empty means
	// this notification has nothing to run, which is a different fact from
	// a link that failed to parse — parsing it is the host's, at click time.
	DeepLink string `json:"deepLink"`
}

// Notifier puts one notification on screen.
type Notifier interface {
	Show(notice Notice) error
}

// shownHandle is what a notification is named by.
//
// It starts at one and only ever increases. A handle reused after a
// notification is dismissed would let a stale caller activate whatever took its
// place.
type shownHandle struct{ last atomic.Uint64 }

func (handle *shownHandle) next() uint64 { return handle.last.Add(1) }

// noticeExtra is the envelope a click's destination travels in.
type noticeExtra struct {
	DeepLink string `json:"deepLink"`
}

// shown is what notify_show answers: the address of the notification it put up.
type shown struct {
	Handle uint64 `json:"handle"`
}

func registerNotice(registry *Registry, deps Deps) {
	if deps.Notify == nil {
		refuse(registry, commandNotifyShow,
			"this process was given no notification backend and can put nothing on screen")
		return
	}

	handles := &shownHandle{}
	registry.MustRegister(Command{
		Name:  commandNotifyShow,
		Owner: OwnerCore,
		Handler: func(args Args) (any, error) {
			title, err := Arg[string](args, "title")
			if err != nil {
				return nil, err
			}
			if title == "" {
				// A notification with no title is a rectangle the user cannot
				// attribute to anything, and it is indistinguishable on screen
				// from one this application did not send.
				return nil, i18n.Errorf("control.notify.emptyTitle", map[string]string{"name": "title"})
			}
			body, err := Arg[string](args, "body")
			if err != nil {
				return nil, err
			}
			extra, err := OptionalArg(args, "extra", noticeExtra{})
			if err != nil {
				return nil, err
			}

			notice := Notice{
				Handle:   handles.next(),
				Title:    title,
				Body:     body,
				DeepLink: extra.DeepLink,
			}
			if err := deps.Notify.Show(notice); err != nil {
				// No handle comes back from a failed show. Answering one would
				// hand the caller an address for a notification that is not
				// there, and the next command against it fails somewhere else.
				return nil, fmt.Errorf("showing the notification %q: %w", title, err)
			}
			return shown{Handle: notice.Handle}, nil
		},
	})
}
