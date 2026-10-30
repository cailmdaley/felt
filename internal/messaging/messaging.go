package messaging

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv"
)

func adapters() map[string]adapter {
	return map[string]adapter{
		"codex": codexAdapter{}, "pi": piAdapter{}, "claude": claudeAdapter{},
	}
}

// adapterDiscoveryTimeout caps each harness's discovery. It sits well inside
// the daemon's 10s cap on `shuttle sessions --local` and a peer's 12s cap on
// `/api/v1/peers`, so on a loaded host a slow harness comes back as that
// harness's gap while the other harnesses' sessions still reach the fleet.
const adapterDiscoveryTimeout = 5 * time.Second

func Discover(ctx context.Context, env *sysenv.Env, host string) Directory {
	d := Directory{Host: host, Sessions: []Session{}, Gaps: []Gap{}}
	if validatePart("host", host) != nil {
		d.Gaps = append(d.Gaps, Gap{Host: host, Harness: "*", Error: "invalid host"})
		return d
	}
	type result struct {
		name     string
		sessions []Session
		err      error
	}
	ch := make(chan result, 4)
	var wg sync.WaitGroup
	for name, a := range adapters() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			child, cancel := context.WithTimeout(ctx, adapterDiscoveryTimeout)
			defer cancel()
			ss, err := a.discover(child, env, host)
			ch <- result{name, ss, err}
		}()
	}
	go func() { wg.Wait(); close(ch) }()
	for x := range ch {
		d.Sessions = append(d.Sessions, x.sessions...)
		if x.err != nil {
			d.Gaps = append(d.Gaps, Gap{Host: host, Harness: x.name, Error: x.err.Error()})
		}
	}
	sort.Slice(d.Sessions, func(i, j int) bool { return d.Sessions[i].Address < d.Sessions[j].Address })
	sort.Slice(d.Gaps, func(i, j int) bool { return d.Gaps[i].Harness < d.Gaps[j].Harness })
	return d
}

func Send(ctx context.Context, env *sysenv.Env, host string, req Request) (Receipt, error) {
	addr, err := ParseAddress(req.Address)
	if err != nil {
		return rejected(req, "validation", err.Error()), err
	}
	req.Address, err = FormatAddress(addr.Host, addr.Harness, addr.ID)
	if err != nil {
		return rejected(req, "validation", err.Error()), err
	}
	if err := validateRequest(host, req); err != nil {
		return rejected(req, "validation", err.Error()), err
	}
	a, ok := adapters()[addr.Harness]
	if !ok {
		err := errCode("unsupported_harness", "unsupported harness %q", addr.Harness)
		return rejected(req, "none", err.Error()), err
	}
	return withDedup(ctx, env, req, func(sendCtx context.Context) dedupSendResult {
		if req.NotifyWhenIdle && req.Text == "" && len(req.Attachments) == 0 {
			sub := subscribeIdle(env, addr, req)
			receipt := Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusSubscribed, Transport: "idle-watch", Detail: sub.Detail, Idle: sub}
			if sub.State != IdleWatching {
				receipt.Status = StatusRejected
				return dedupSendResult{Receipt: receipt, Err: errCode("unsupported", "%s", sub.Detail)}
			}
			return dedupSendResult{Receipt: receipt}
		}
		if err := sendCtx.Err(); err != nil {
			receipt := rejected(req, "validation", err.Error())
			return dedupSendResult{Receipt: receipt, Err: errCode("preflight_failed", "message deadline expired before delivery: %v", err)}
		}
		if reason := mailboxUnavailable(env, addr.Harness, addr.ID, addr.Host); strings.HasPrefix(reason, "session has ended;") {
			return dedupSendResult{Receipt: rejected(req, addr.Harness+"-hook", reason), Err: errCode("unavailable", "%s", reason)}
		}
		files, err := materializeAttachments(env, req.MessageID, req.Attachments)
		if err != nil {
			receipt := rejected(req, "attachments", err.Error())
			return dedupSendResult{Receipt: receipt, Err: errCode("preflight_failed", "cannot store attachments: %v", err)}
		}
		text, err := renderAttachmentText(req.Text, files)
		if err != nil {
			receipt := rejected(req, "attachments", err.Error())
			return dedupSendResult{Receipt: receipt, Err: errCode("preflight_failed", "%v", err)}
		}
		if err := sendCtx.Err(); err != nil {
			receipt := rejected(req, "validation", err.Error())
			return dedupSendResult{Receipt: receipt, Err: errCode("preflight_failed", "message deadline expired before delivery: %v", err)}
		}
		delivery := req
		delivery.Text = text
		delivery.Attachments = nil
		if err := recordEnvelope(env, addr.ID, delivery); err != nil {
			return dedupSendResult{Receipt: rejected(req, "envelope-store", err.Error()), Err: errCode("preflight_failed", "cannot record message envelope: %v", err)}
		}
		var result dedupSendResult
		if detailed, ok := a.(dedupMetadataSender); ok {
			result.Receipt, result.Err, result.Metadata = detailed.sendWithDedupMetadata(sendCtx, env, addr, delivery)
		} else {
			result.Receipt, result.Err = a.send(sendCtx, env, addr, delivery)
		}
		result.Receipt.Files = files
		if req.NotifyWhenIdle && result.Receipt.Status != StatusRejected {
			result.Receipt.Idle = subscribeIdle(env, addr, req)
		}
		return result
	})
}

func validateRequest(host string, r Request) error {
	a, err := ParseAddress(r.Address)
	if err != nil {
		return err
	}
	if a.Host != host {
		return errCode("wrong_host", "address belongs to host %q, not %q", a.Host, host)
	}
	if r.MessageID == "" || len(r.MessageID) > 256 || hasControl(r.MessageID) {
		return errCode("invalid_request", "invalid message_id")
	}
	if r.NotifyWake && !r.NotifyWhenIdle {
		return errCode("invalid_request", "notify_wake requires notify_when_idle")
	}
	if len(r.NotifyAddress) > 1024 || hasControl(r.NotifyAddress) {
		return errCode("invalid_request", "notify_address is too long or contains control characters")
	}
	if r.NotifyWhenIdle {
		notifyAddress := r.NotifyAddress
		if notifyAddress == "" {
			notifyAddress = r.From
		}
		from, err := ParseAddress(notifyAddress)
		if err != nil {
			return errCode("invalid_request", "notify_when_idle needs a callback session address; %q is not one", notifyAddress)
		}
		if from == a {
			return errCode("invalid_request", "notify_when_idle cannot target the subscribing session itself")
		}
	}
	if (r.Text == "" && len(r.Attachments) == 0 && !r.NotifyWhenIdle) || len(r.Text) > 64<<10 || strings.ContainsRune(r.Text, 0) {
		return errCode("invalid_request", "text must be at most 65536 bytes and may be empty only with attachments")
	}
	if len(r.From) > 1024 || hasControl(r.From) || strings.ContainsAny(r.From, "[];") {
		return errCode("invalid_request", "from is too long or contains header delimiters")
	}
	if err := ValidateSenderClaim(r.FromClaim); err != nil {
		return err
	}
	if len(r.ReplyTo) > 1024 || hasControl(r.ReplyTo) {
		return errCode("invalid_request", "reply_to is too long or contains control characters")
	}
	return validateAttachments(r.Attachments)
}

// ValidateSenderClaim keeps caller-supplied labels bounded and on one line of
// the Shuttle message header.
func ValidateSenderClaim(claim string) error {
	if len(claim) > 1024 || hasControl(claim) || strings.ContainsAny(claim, "[];") {
		return errCode("invalid_request", "from_claim is too long or contains header delimiters")
	}
	return nil
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 32 || r == 127 {
			return true
		}
	}
	return false
}

func rejected(r Request, transport, detail string) Receipt {
	return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusRejected, Transport: transport, Detail: detail}
}

// dataDir is shuttle.DataDir. With no home directory to expand against it is
// /.shuttle, which no unprivileged process can write, so every store below it
// fails loudly instead of landing relative to the working directory.
func dataDir(env *sysenv.Env) string {
	if dir, err := shuttle.DataDir(env); err == nil {
		return dir
	}
	return "/.shuttle"
}
