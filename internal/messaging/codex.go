package messaging

import (
	"context"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// codexAdapter treats the Codex CLI as a terminal conversation. Hooks provide
// session discovery and context delivery; idle wake uses Shuttle's terminal
// input route, which pastes into the existing TUI.
type codexAdapter struct{}

func (codexAdapter) discover(_ context.Context, env *sysenv.Env, host string) ([]Session, error) {
	return mailboxSessions(env, "codex", host), nil
}

func (codexAdapter) send(ctx context.Context, env *sysenv.Env, address Address, request Request) (Receipt, error) {
	return sendCodexTerminal(ctx, env, address, request, submitTerminalInput)
}

func sendCodexTerminal(ctx context.Context, env *sysenv.Env, address Address, request Request, submit func(context.Context, *sysenv.Env, Address, Request) (Receipt, error)) (Receipt, error) {
	return sendTerminalWithDiscovery(ctx, env, address, request, discoverTerminalReceiver, submit)
}

// terminalReceiverDiscover makes sure a live receiver's hook mailbox is
// registered, or says why none is.
type terminalReceiverDiscover func(context.Context, *sysenv.Env, Address) error

// sendTerminalWithDiscovery delivers to a harness that takes typed input in
// either phase (Codex, Antigravity): a wake is pasted into its terminal, which
// queues it behind a running turn; anything else waits in the hook mailbox,
// offered at the harness's next hook. IdleOnly is guarded by the turn state
// the last hook recorded.
func sendTerminalWithDiscovery(ctx context.Context, env *sysenv.Env, address Address, request Request, discover terminalReceiverDiscover, submit func(context.Context, *sysenv.Env, Address, Request) (Receipt, error)) (Receipt, error) {
	hook := address.Harness + "-hook"
	if !request.Wake {
		request.Wake = false
		if err := discover(ctx, env, address); err != nil {
			return rejected(request, hook, err.Error()), err
		}
		return queueMailbox(env, address, request)
	}

	var state string
	var unlock func()
	var err error
	if request.IdleOnly {
		if err := discover(ctx, env, address); err != nil {
			return rejected(request, hook, err.Error()), err
		}
		state, unlock, err = lockMailboxSessionState(env, address.Harness, address.ID, address.Host)
		if err != nil {
			return rejected(request, hook, err.Error()), err
		}
		defer unlock()
	}
	if request.IdleOnly && state != "idle" {
		turn := terminalTitle(address.Harness) + " turn is not known to be idle"
		return rejected(request, hook, turn+"; message was not delivered"), errCode("busy", "%s", turn)
	}
	return submit(ctx, env, address, request)
}

// terminalTitle names a terminal harness in messages a person reads.
func terminalTitle(name string) string {
	switch name {
	case "codex":
		return "Codex"
	case "antigravity":
		return "Antigravity"
	}
	return name
}

// UnnamedSender heads a message whose caller gave no sender.
const UnnamedSender = "external"

// Labeled renders the message text under the one header line that says who it
// is from, shared by terminal input and hook mailboxes. A session address goes
// by the fiber a reply reaches; its full address stays in the message record. The
// result holds no message id, so two messages with the same sender and text are
// equal here and in a receiver's transcript, including to Pi's content receipts.
func Labeled(request Request) string {
	from, replyTo := request.From, request.ReplyTo
	if from == "" {
		from = UnnamedSender
	}
	if _, err := ParseAddress(from); err == nil && replyTo != "" {
		from, replyTo = replyTo, ""
	}
	header := "[from " + from
	if replyTo != "" {
		header += "; reply to " + replyTo
	}
	return header + "]\n" + request.Text
}
