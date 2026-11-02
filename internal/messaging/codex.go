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
	return sendCodexTerminal(ctx, env, address, request, submitCodexTerminalInput)
}

func sendCodexTerminal(ctx context.Context, env *sysenv.Env, address Address, request Request, submit func(context.Context, *sysenv.Env, Address, Request) (Receipt, error)) (Receipt, error) {
	return sendCodexTerminalWithDiscovery(ctx, env, address, request, discoverCodexTerminalReceiver, submit)
}

type codexReceiverDiscover func(context.Context, *sysenv.Env, Address) error

func sendCodexTerminalWithDiscovery(ctx context.Context, env *sysenv.Env, address Address, request Request, discover codexReceiverDiscover, submit func(context.Context, *sysenv.Env, Address, Request) (Receipt, error)) (Receipt, error) {
	if !request.Wake {
		request.Wake = false
		if err := discover(ctx, env, address); err != nil {
			return rejected(request, "codex-hook", err.Error()), err
		}
		return queueMailbox(env, address, request)
	}

	var state string
	var unlock func()
	var err error
	if request.IdleOnly {
		if err := discover(ctx, env, address); err != nil {
			return rejected(request, "codex-hook", err.Error()), err
		}
		state, unlock, err = lockMailboxSessionState(env, "codex", address.ID, address.Host)
		if err != nil {
			return rejected(request, "codex-hook", err.Error()), err
		}
		defer unlock()
	}
	if request.IdleOnly && state != "idle" {
		return rejected(request, "codex-hook", "Codex turn is not known to be idle; message was not delivered"), errCode("busy", "Codex turn is not known to be idle")
	}

	// Codex accepts terminal input while a turn is active and queues it as a
	// follow-up. A Wake therefore goes to the TUI in either phase; hooks remain
	// the context-only path and IdleOnly is guarded by the last observed hook.
	return submit(ctx, env, address, request)
}

// Labeled renders the peer header shared by terminal input and hook mailboxes.
func Labeled(request Request) string {
	header := "[Shuttle message " + request.MessageID
	if request.From != "" {
		header += " from " + request.From
	}
	if request.FromClaim != "" {
		header += "; claims to be " + request.FromClaim
	}
	if request.ReplyTo != "" {
		header += "; reply to " + request.ReplyTo
	}
	return header + "]\n" + request.Text
}
