package daemon

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/soksak/soksak-core/core/control"
)

// The scheduler: a registry command fired at a time, on an interval, or on an
// event.
//
// It is in this group because a scheduled fire and a daemon are the same
// question asked twice — what keeps running when nobody is looking — and
// because the answer to both is that this process does it itself. There is no
// second process, and nothing here survives a restart: a job is held in memory,
// and the caller that wants one back re-registers it when it comes up. That is
// the caller's contract already ("plugins store their own schedules and re-arm
// on activate"), and inventing a store here would make two records of one
// schedule that disagree after a crash.
//
// Nothing polls. The next due job arms one timer for exactly its wait, and a
// job with no time — a reconcile job — sleeps until it is poked.

// The names this half answers to.
const (
	commandScheduleSet      = "schedule_set"
	commandScheduleRegister = "schedule_register"
	commandScheduleCancel   = "schedule_cancel"
	commandScheduleList     = "schedule_list"
	commandSchedulePoke     = "schedule_poke"
)

// Job is one scheduled job, as schedule_list reports it.
type Job struct {
	ID      string  `json:"id"`
	Trigger Trigger `json:"trigger"`
	Command string  `json:"command"`
	// Params is the object the command is fired with, never null: a caller
	// that spreads it into its own record would spread a null.
	Params control.Args `json:"params"`
	// NextAt is null when the job waits for an event rather than a time, and
	// while a fire is in flight.
	NextAt  *int64 `json:"next_at"`
	Running bool   `json:"running"`
	// Concurrency is 1 and is reported as such: one job holds one lease, and a second fire
	// of the same job waits for the first to finish.
	Concurrency int `json:"concurrency"`
	// Owner is the plugin that registered the job, when one did. It is what
	// makes "whose job is this" answerable from the list.
	Owner string `json:"owner,omitempty"`
}

// job is one entry in the table.
type job struct {
	id       string
	trigger  Trigger
	command  string
	params   control.Args
	owner    string
	retry    *Retry
	nextAt   *int64
	running  bool
	attempts int
	// poked is a fire that arrived while this job was running. It re-fires
	// once when the current fire finishes, however many pokes arrived: the
	// point of a poke is that the job runs again with what it did not see yet,
	// and one run sees everything.
	poked bool
}

// scheduler holds every job in this process.
type scheduler struct {
	deps   Deps
	invoke func(name string, args control.Args) (any, error)

	// inFlight counts the fires that have not finished. It is a receipt rather
	// than a state to look at: whoever needs to know that nothing is running —
	// a shutdown, a test — waits on it instead of asking again.
	inFlight sync.WaitGroup

	mu     sync.Mutex
	jobs   map[string]*job
	minted int
	// armed is the moment the one outstanding timer will wake at. A later
	// registration that is due sooner arms another; a stale wake finds nothing
	// due, re-arms, and costs nothing.
	armed *int64
}

func newScheduler(deps Deps, invoke func(string, control.Args) (any, error)) *scheduler {
	return &scheduler{deps: deps, invoke: invoke, jobs: map[string]*job{}}
}

// scheduleRequest is one registration, exactly as the caller sends it.
type scheduleRequest struct {
	Trigger Trigger
	Command string
	Params  control.Args
	ID      string
	Owner   string
	Retry   *Retry
}

// register puts one job on the table and answers its id.
func (schedule *scheduler) register(request scheduleRequest) (string, error) {
	if request.Command == "" {
		return "", fmt.Errorf("a schedule fires a registry command and this one names none")
	}
	if err := request.Trigger.check(); err != nil {
		return "", err
	}
	if request.Params == nil {
		request.Params = control.Args{}
	}

	schedule.mu.Lock()
	defer schedule.mu.Unlock()

	id := request.ID
	if id == "" {
		schedule.minted++
		id = "sch-" + strconv.Itoa(schedule.minted)
	}
	one := &job{
		id:      id,
		trigger: request.Trigger,
		command: request.Command,
		params:  request.Params,
		owner:   request.Owner,
		retry:   request.Retry,
		nextAt:  request.Trigger.first(schedule.deps.Now()),
	}
	// A registration under an existing id replaces that job whole. The one it
	// replaced may be in flight; its goroutine finds a different job under the
	// id and leaves the table alone, so a reload cannot resurrect what it
	// replaced.
	schedule.jobs[id] = one
	schedule.rearm()
	return id, nil
}

// cancel removes a job and answers whether there was one.
func (schedule *scheduler) cancel(id string) bool {
	schedule.mu.Lock()
	defer schedule.mu.Unlock()

	_, held := schedule.jobs[id]
	delete(schedule.jobs, id)
	// A cancelled job that is running is not interrupted: the command is
	// already inside a handler, and this build has no way to take it back. What
	// cancelling does is stop it ever being due again.
	return held
}

// list answers every job, soonest first.
func (schedule *scheduler) list() []Job {
	schedule.mu.Lock()
	defer schedule.mu.Unlock()

	// Never nil: an empty schedule and a build that cannot answer must not
	// arrive as the same JSON null.
	rows := make([]Job, 0, len(schedule.jobs))
	for _, one := range schedule.jobs {
		rows = append(rows, Job{
			ID:          one.id,
			Trigger:     one.trigger,
			Command:     one.command,
			Params:      one.params,
			NextAt:      one.nextAt,
			Running:     one.running,
			Concurrency: 1,
			Owner:       one.owner,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		left, right := rows[i].NextAt, rows[j].NextAt
		if left == nil || right == nil {
			// A job with no next time sorts last: what the reader wants at the
			// top is what is about to happen. Ties fall back to the id so two
			// readings of one table compare.
			if (left == nil) != (right == nil) {
				return right == nil
			}
			return rows[i].ID < rows[j].ID
		}
		if *left != *right {
			return *left < *right
		}
		return rows[i].ID < rows[j].ID
	})
	return rows
}

// poke fires a job now, or every reconcile job when no id is named.
func (schedule *scheduler) poke(id string) error {
	schedule.mu.Lock()
	defer schedule.mu.Unlock()

	if id != "" {
		one, held := schedule.jobs[id]
		if !held {
			// Answering "done" for a job that is not there would let a caller
			// believe a reconcile it depends on has been asked for.
			return fmt.Errorf("no schedule %q is registered here", id)
		}
		schedule.start(one)
		return nil
	}
	for _, one := range schedule.jobs {
		if one.trigger.Kind == triggerReconcile {
			schedule.start(one)
		}
	}
	return nil
}

// wake fires everything that is due. It is what the one timer calls.
func (schedule *scheduler) wake() {
	schedule.mu.Lock()
	defer schedule.mu.Unlock()

	schedule.armed = nil
	now := schedule.deps.Now()
	for _, one := range schedule.jobs {
		if one.running || one.nextAt == nil || *one.nextAt > now {
			continue
		}
		schedule.start(one)
	}
	schedule.rearm()
}

// start puts one job in flight. The table's lock is held; the command is not
// run under it.
func (schedule *scheduler) start(one *job) {
	if one.running {
		// Coalesced rather than queued. Two runs of one reconcile would do the
		// same work twice, and the second would find nothing left to do.
		one.poked = true
		return
	}
	one.running = true
	// A job in flight has no next time. Leaving one would make the next wake
	// fire it again beside itself.
	one.nextAt = nil
	// Counted before the goroutine exists, and while the count is already at
	// least one for a re-fire: a waiter must never see zero between the two.
	schedule.inFlight.Add(1)
	go schedule.run(one)
}

// run fires one job's command and records what came of it.
func (schedule *scheduler) run(one *job) {
	defer schedule.inFlight.Done()

	// The command runs with no lock held: a fired command that registers or
	// cancels a schedule is ordinary, and holding the table across it would
	// deadlock the process on its own scheduler.
	_, err := schedule.invoke(one.command, one.params)

	schedule.mu.Lock()
	defer schedule.mu.Unlock()

	one.running = false
	if schedule.jobs[one.id] != one {
		// Cancelled or replaced while it ran. Its result is a job's that
		// is no longer on the table, and rescheduling it would bring back what
		// the caller removed.
		return
	}

	now := schedule.deps.Now()
	switch {
	case err != nil && one.retry != nil && one.attempts < one.retry.Max:
		one.attempts++
		at := now + one.retry.wait(one.attempts)
		one.nextAt = &at

	case one.poked:
		one.attempts = 0
		one.poked = false
		schedule.start(one)

	default:
		one.attempts = 0
		one.nextAt = one.trigger.after(now)
		if one.nextAt == nil && one.trigger.Kind == triggerAt {
			// A one-shot has fired the once it had. Keeping it would grow the
			// list with jobs that can never be due, and make cancel answer
			// "removed" for work that already happened.
			delete(schedule.jobs, one.id)
		}
	}
	schedule.rearm()
}

// settled comes back once no fire is in flight.
func (schedule *scheduler) settled() {
	schedule.inFlight.Wait()
}

// rearm points the one timer at the soonest job. The table's lock is held.
func (schedule *scheduler) rearm() {
	var soonest *int64
	for _, one := range schedule.jobs {
		if one.running || one.nextAt == nil {
			continue
		}
		if soonest == nil || *one.nextAt < *soonest {
			soonest = one.nextAt
		}
	}
	if soonest == nil {
		return
	}
	if schedule.armed != nil && *schedule.armed <= *soonest {
		// Something no later is already armed. Its wake fires this one too, or
		// re-arms for it.
		return
	}
	at := *soonest
	schedule.armed = &at

	wait := at - schedule.deps.Now()
	if wait < 0 {
		wait = 0
	}
	schedule.deps.After(time.Duration(wait)*time.Millisecond, schedule.wake)
}

// registerSchedule puts the scheduler's commands on the registry.
func registerSchedule(registry *control.Registry, deps Deps) {
	schedule := newScheduler(deps, registry.Invoke)

	serve := func(name string, handler control.Handler) {
		registry.MustRegister(control.Command{Name: name, Owner: control.OwnerCore, Handler: handler})
	}

	serve(commandScheduleSet, func(args control.Args) (any, error) {
		at, err := epochMillis(commandScheduleSet, args, "at")
		if err != nil {
			return nil, err
		}
		command, err := namedText(commandScheduleSet, args, "command")
		if err != nil {
			return nil, err
		}
		params, err := commandParams(commandScheduleSet, args)
		if err != nil {
			return nil, err
		}
		id, err := optionalText(commandScheduleSet, args, "id")
		if err != nil {
			return nil, err
		}
		return schedule.register(scheduleRequest{
			Trigger: Trigger{Kind: triggerAt, At: &at},
			Command: command,
			Params:  params,
			ID:      id,
		})
	})

	serve(commandScheduleRegister, func(args control.Args) (any, error) {
		request, err := registration(args)
		if err != nil {
			return nil, err
		}
		return schedule.register(request)
	})

	serve(commandScheduleCancel, func(args control.Args) (any, error) {
		id, err := namedText(commandScheduleCancel, args, "id")
		if err != nil {
			return nil, err
		}
		return schedule.cancel(id), nil
	})

	serve(commandScheduleList, func(control.Args) (any, error) {
		return schedule.list(), nil
	})

	serve(commandSchedulePoke, func(args control.Args) (any, error) {
		id, err := optionalText(commandSchedulePoke, args, "id")
		if err != nil {
			return nil, err
		}
		return nil, schedule.poke(id)
	})
}

// registration reads schedule_register's arguments, and refuses the options
// this build cannot honour rather than accepting them and doing something else.
func registration(args control.Args) (scheduleRequest, error) {
	var request scheduleRequest

	raw, present := args["trigger"]
	if !present || isNull(raw) {
		return request, fmt.Errorf("%s: missing argument %q", commandScheduleRegister, "trigger")
	}
	if err := json.Unmarshal(raw, &request.Trigger); err != nil {
		return request, fmt.Errorf("%s: argument %q: %w", commandScheduleRegister, "trigger", err)
	}

	command, err := namedText(commandScheduleRegister, args, "command")
	if err != nil {
		return request, err
	}
	request.Command = command

	if request.Params, err = commandParams(commandScheduleRegister, args); err != nil {
		return request, err
	}
	if request.ID, err = optionalText(commandScheduleRegister, args, "id"); err != nil {
		return request, err
	}
	if request.Owner, err = optionalText(commandScheduleRegister, args, "owner"); err != nil {
		return request, err
	}

	if retry, present := args["retry"]; present && !isNull(retry) {
		var backoff Retry
		if err := json.Unmarshal(retry, &backoff); err != nil {
			return request, fmt.Errorf("%s: argument %q: %w", commandScheduleRegister, "retry", err)
		}
		request.Retry = &backoff
	}

	for _, refusal := range []struct {
		name   string
		reason string
	}{
		{"process_lease", "this build cannot tell which process a fired command started, so it could not hold a lease until that process exited — " +
			"the lease would be released while the work was still running, which is the one thing the option exists to prevent"},
		{"timeout_ms", "this build fires a command by calling its handler, and a handler that is running cannot be taken back — " +
			"a cap here would report a timeout while the work carried on"},
		{"concurrency", "one job holds one lease here and a second fire waits for the first; there is no other setting to choose"},
		{"zombie_backstop_ms", "it caps a process lease, and this build holds none"},
	} {
		raw, present := args[refusal.name]
		if present && !isNull(raw) {
			return request, fmt.Errorf("%s: argument %q asks for something this build does not do: %s",
				commandScheduleRegister, refusal.name, refusal.reason)
		}
	}
	return request, nil
}
