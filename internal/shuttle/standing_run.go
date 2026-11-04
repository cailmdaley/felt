package shuttle

import "time"

// RunFacts are the durable facts that distinguish a worker's conclusion from
// a human rearm. An exit verb belongs to its handoff timestamp, not to a later
// dispatch that retained it.
type RunFacts struct {
	DispatchedAt string
	HandedOffAt  string
	ExitVerb     string
}

type RunDisposition string

const (
	RunUnrecorded RunDisposition = "unrecorded"
	RunInProgress RunDisposition = "in_progress"
	RunHandedOff  RunDisposition = "handed_off"
	RunRearmed    RunDisposition = "rearmed"
)

// StandingRunDisposition derives the current run without inventing a conclusion
// for a dispatch newer than the preceding run's handoff.
func StandingRunDisposition(f RunFacts) RunDisposition {
	dispatch, err := time.Parse(time.RFC3339Nano, f.DispatchedAt)
	if err != nil {
		return RunUnrecorded
	}
	handoff, err := time.Parse(time.RFC3339Nano, f.HandedOffAt)
	if err != nil || handoff.Before(dispatch) {
		return RunInProgress
	}
	if f.ExitVerb == "rearmed" {
		return RunRearmed
	}
	return RunHandedOff
}
