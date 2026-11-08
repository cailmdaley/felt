package shuttlecli

import (
	"path"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// orchestratorActedKey is the shuttle.runtime field naming the one lifecycle
// publication (its close, ask or rest stamp) that the thread's orchestrator
// made itself. The daemon does not deliver that publication back to the
// orchestrator: its own session already knows what it did.
const orchestratorActedKey = "orchestrator_acted_at"

// actorFlagUsage is the help for the --actor flag of the verbs a thread's
// orchestrator can act with.
const actorFlagUsage = "Session the verb acts for (default: this harness session); the daemon passes its caller's"

// actorSession is the session a lifecycle verb acts for: --actor when the
// daemon writes on a caller's behalf, else this harness session.
func (a *app) actorSession(flag string) string {
	if flag != "" {
		return flag
	}
	_, id := a.harnessSessionFromEnv()
	return id
}

// orchestratorOf is a thread's nearest strict ancestor in its own store that
// carries a shuttle: block and is not archived (a tempered or discarded
// verdict), or nil for a constitution with none above it. Where the store holds
// no constitution at the path the thread's creation reference
// (shuttle.thread_parent) names, that reference stands for its parent: a
// stub carrying the parent's uid, slug and name, whose document lives on its
// owner's host. The daemon reads the relation by the same rule
// (Shuttle.Threads.orchestrator/2).
func orchestratorOf(st *felt.Storage, f *felt.Felt) *felt.Felt {
	var pinned *shuttle.ThreadParent
	if block, ok, err := shuttle.BlockOf(f); err == nil && ok {
		pinned = block.ThreadParent
	}
	for dir := path.Dir(f.ID); dir != "." && dir != "/"; dir = path.Dir(dir) {
		if parent, err := st.Read(dir); err == nil {
			if _, ok, err := shuttle.BlockOf(parent); err == nil && ok {
				if shuttle.Verdict(parent) == "" {
					return parent
				}
				continue
			}
		}
		if pinned != nil && pinned.Slug == dir {
			return &felt.Felt{ID: dir, UID: pinned.UID, Name: pinned.Name}
		}
	}
	return nil
}

// markOrchestratorAct stamps orchestratorActedKey = stamp when actor is the
// live worker of f's orchestrator, so the publication at that stamp is not
// delivered back to the session that made it. Any other actor leaves the
// field alone: it names one stamp, so it never silences a later one.
func markOrchestratorAct(st *felt.Storage, f *felt.Felt, stamp, actor string) error {
	if actor == "" || stamp == "" {
		return nil
	}
	parent := orchestratorOf(st, f)
	if parent == nil || shuttleRuntimeSessionID(parent) != actor {
		return nil
	}
	return shuttle.SetRuntimeField(f, orchestratorActedKey, stamp)
}
