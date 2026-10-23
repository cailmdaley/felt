package shuttlecli

import (
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// The daemon decides which live worker serves which fiber: a fiber's
// unconcluded runtime names the conversation its worker holds, and a claim
// moves a worker to another fiber without renaming its tmux session. A
// session's name records only the fiber that launched it, so the CLI asks the
// daemon (GET /api/v1/state, running_detail) before it attaches to a worker
// or reports one running.

// workerAssignments maps each fiber uid the daemon runs a terminal worker for
// to that worker's tmux session. ok is false when no daemon answers.
func (a *app) workerAssignments() (map[string]string, bool) {
	endpoint, err := a.daemonEndpoint("/api/v1/state")
	if err != nil {
		return nil, false
	}
	snapshot, err := getDaemonJSON[struct {
		Running []struct {
			UID        string `json:"uid"`
			RuntimeKey string `json:"runtime_key"`
			Session    string `json:"session"`
		} `json:"running_detail"`
	}](a, endpoint, "parsing daemon assignments")
	if err != nil {
		return nil, false
	}
	sessions := map[string]string{}
	for _, worker := range snapshot.Running {
		uid := worker.UID
		if uid == "" {
			uid = worker.RuntimeKey
		}
		if uid != "" && worker.Session != "" && !strings.HasPrefix(worker.Session, "codex-app:") {
			sessions[uid] = worker.Session
		}
	}
	return sessions, true
}

// liveWorkerSession reports the tmux session of the worker serving f. With
// no daemon to ask, it falls back to the one live session launched for f's
// uid, which a claim may since have moved to another fiber; callers that act
// on a worker use assignedWorkerSession instead.
func (a *app) liveWorkerSession(f *felt.Felt) (string, bool) {
	if session, ok, answered := a.assignedWorkerSession(f); answered {
		return session, ok
	}
	return launchedSession(a.liveTmuxSessions(), f.UID)
}

// assignedWorkerSession is the daemon's answer alone: answered is false when
// no daemon answers.
func (a *app) assignedWorkerSession(f *felt.Felt) (session string, ok, answered bool) {
	sessions, answered := a.workerAssignments()
	if !answered {
		return "", false, false
	}
	session = sessions[f.UID]
	return session, session != "" && f.UID != "", true
}

// launchedSession is the single live session launched for uid, by the uid its
// name carries.
func launchedSession(live map[string]bool, uid string) (string, bool) {
	if uid == "" {
		return "", false
	}
	found := ""
	for session := range live {
		if fiberUIDFromTmuxSession(session) == uid {
			if found != "" {
				return "", false
			}
			found = session
		}
	}
	return found, found != ""
}
