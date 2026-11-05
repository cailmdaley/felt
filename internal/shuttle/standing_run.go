package shuttle

import "time"

// RunFacts distinguish a worker's conclusion from an owner rearm. An exit verb
// belongs to its handoff timestamp, not to a later dispatch that retained it.
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

// StandingRunDisposition distinguishes an unfinished run, a worker's reviewable
// result, and a rearm by the owner (acceptance or the next scheduled occurrence).
// Rearm markers at the dispatch instant keep an occurrence due without letting
// a late exit close it again. A prior run's handoff cannot conclude a newer one.
func StandingRunDisposition(f RunFacts) RunDisposition {
	dispatch, err := time.Parse(time.RFC3339Nano, f.DispatchedAt)
	if err != nil {
		return RunUnrecorded
	}
	handoff, err := time.Parse(time.RFC3339Nano, f.HandedOffAt)
	if err != nil || handoff.Before(dispatch) {
		return RunInProgress
	}
	if f.ExitVerb == "rearmed" || f.ExitVerb == "tempered" {
		return RunRearmed
	}
	return RunHandedOff
}
