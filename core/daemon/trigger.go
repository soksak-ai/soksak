package daemon

import "fmt"

// The trigger rules: when a job is next due, in epoch milliseconds.
//
// The shape is the caller's, field for field, and it travels back out of
// schedule_list unchanged. A caller that stored what it registered — which is
// the whole persistence model here, since this build stores nothing — compares
// the two, and a renamed field makes its own record unrecognisable.

// Trigger says when a job fires.
type Trigger struct {
	// Kind is at, every or reconcile. cron is refused: see check.
	Kind string `json:"kind"`
	// At is the epoch millisecond a one-shot fires at.
	At *int64 `json:"at,omitempty"`
	// EveryMS is the interval of a repeating job.
	EveryMS *int64 `json:"every_ms,omitempty"`
	// Anchor pins the interval to a grid, so the fire time does not drift with
	// the moment the job happened to be registered.
	Anchor *int64 `json:"anchor,omitempty"`
	// Expr is a cron expression. It is read so the refusal can name it.
	Expr string `json:"expr,omitempty"`
}

const (
	triggerAt        = "at"
	triggerEvery     = "every"
	triggerCron      = "cron"
	triggerReconcile = "reconcile"
)

// check answers whether this build can honour the trigger.
func (trigger Trigger) check() error {
	switch trigger.Kind {
	case "":
		return fmt.Errorf("a trigger names no %q — it is one of %q, %q or %q", "kind", triggerAt, triggerEvery, triggerReconcile)

	case triggerAt:
		if trigger.At == nil {
			return fmt.Errorf("an %q trigger carries no %q — there is no moment to fire at", triggerAt, "at")
		}
		return nil

	case triggerEvery:
		if trigger.EveryMS == nil {
			return fmt.Errorf("an %q trigger carries no %q — there is no interval to repeat on", triggerEvery, "every_ms")
		}
		if *trigger.EveryMS <= 0 {
			// A zero interval is a loop with no gap in it: the job would fire,
			// finish, and be due again in the same millisecond, forever.
			return fmt.Errorf("an %q trigger has %q = %d, and an interval is positive", triggerEvery, "every_ms", *trigger.EveryMS)
		}
		return nil

	case triggerReconcile:
		return nil

	case triggerCron:
		// Refused rather than approximated. A cron expression this build read
		// wrongly would fire at the wrong time for as long as the job lives,
		// and nothing about a job that runs would say it ran at the wrong hour.
		return fmt.Errorf("this build parses no %q expression (%q), so it cannot say when such a job is due; "+
			"an %q trigger re-armed after each fire is the shape it can honour", triggerCron, trigger.Expr, triggerEvery)

	default:
		return fmt.Errorf("%q is not a trigger this build knows — it is one of %q, %q or %q",
			trigger.Kind, triggerAt, triggerEvery, triggerReconcile)
	}
}

// first answers when a newly registered job is due. Nil means it waits for an
// event rather than for a time.
func (trigger Trigger) first(now int64) *int64 {
	switch trigger.Kind {
	case triggerAt:
		// A moment that has already passed is not refused: a plugin re-arming
		// what it stored while the app was closed means "as soon as you can".
		return trigger.At

	case triggerEvery:
		if trigger.Anchor != nil {
			return grid(*trigger.Anchor, *trigger.EveryMS, now)
		}
		// One interval on, never at once. Firing at registration as well would
		// make an every-minute job fire twice inside its first minute, and the
		// caller that re-registers on every activation would see a burst.
		at := now + *trigger.EveryMS
		return &at

	case triggerReconcile:
		// The registration scan the caller asks for. After this it waits to be
		// poked and never sleeps against a clock.
		at := now
		return &at
	}
	return nil
}

// after answers when a job that has just fired is next due.
func (trigger Trigger) after(now int64) *int64 {
	switch trigger.Kind {
	case triggerEvery:
		if trigger.Anchor != nil {
			return grid(*trigger.Anchor, *trigger.EveryMS, now+1)
		}
		at := now + *trigger.EveryMS
		return &at
	}
	// An "at" job has fired the once it had, and a reconcile job waits for the
	// next poke. Neither is due against a clock again.
	return nil
}

// grid answers the first point of the anchor's grid at or after now.
func grid(anchor, every, now int64) *int64 {
	if now <= anchor {
		at := anchor
		return &at
	}
	steps := (now - anchor + every - 1) / every
	at := anchor + steps*every
	return &at
}

// Retry is the caller's backoff for a job whose command failed.
type Retry struct {
	// Max is how many further attempts are made. 0 is none.
	Max int `json:"max"`
	// BaseMS is the first wait, doubled on each further attempt.
	BaseMS int64 `json:"base_ms"`
	// MaxMS is the ceiling that doubling stops at.
	MaxMS int64 `json:"max_ms"`
}

// wait answers how long before attempt number n, counting from 1.
func (retry Retry) wait(attempt int) int64 {
	wait := retry.BaseMS
	for step := 1; step < attempt; step++ {
		wait *= 2
		if wait >= retry.MaxMS {
			return retry.MaxMS
		}
	}
	if retry.MaxMS > 0 && wait > retry.MaxMS {
		return retry.MaxMS
	}
	return wait
}
