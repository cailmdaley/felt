package messaging

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

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

// Labeled renders the message text under the one header line that says who it
// is from, shared by terminal input and hook mailboxes. A verified sender goes by
// the fiber a reply reaches; its full address stays in the message record. The
// result holds no message id, so two messages with the same sender and text are
// equal here and in a receiver's transcript, including to Pi's content receipts.
func Labeled(request Request) string {
	from, replyTo := request.From, request.ReplyTo
	if _, err := ParseAddress(from); err == nil && replyTo != "" {
		from, replyTo = replyTo, ""
	}
	header := "[from " + from
	if request.FromClaim != "" {
		header += "; claims to be " + request.FromClaim
	}
	if replyTo != "" {
		header += "; reply to " + replyTo
	}
	return header + "]\n" + request.Text
}

// messageRef is the short name a failure notice gives a message.
func messageRef(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:4])
}
