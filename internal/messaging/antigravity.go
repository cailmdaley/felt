package messaging

import (
	"context"

	"github.com/cailmdaley/felt/internal/harness"
	"github.com/cailmdaley/felt/internal/sysenv"
)

// antigravityAdapter treats the Antigravity CLI (agy) as a terminal
// conversation, as Codex is: its felt plugin's hooks register the session
// and inject queued context before each model call, and a wake is pasted into
// its terminal, which queues it behind a running turn. A conversation resumed
// without a prompt fires no hook until its next turn, so its receiver is found
// as Codex's is, by the daemon's process scan.
type antigravityAdapter struct{}

func (antigravityAdapter) discover(_ context.Context, env *sysenv.Env, host string) ([]Session, error) {
	return mailboxSessions(env, "antigravity", host), nil
}

func (antigravityAdapter) send(ctx context.Context, env *sysenv.Env, address Address, request Request) (Receipt, error) {
	return sendTerminalWithDiscovery(ctx, env, address, request, discoverTerminalReceiver, submitTerminalInput)
}

// PastedTransport reports a transport that types a message into a harness's
// terminal: a "submitted" receipt from it is the delivery, since the harness
// takes typed input in either phase.
func PastedTransport(transport string) bool {
	for _, f := range harness.All() {
		if (f.Delivery == "paste" || f.Delivery == "inject") && transport == f.Name+"-terminal" {
			return true
		}
	}
	return false
}
