package messaging

import (
	"context"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

func adapters() map[string]adapter {
	return map[string]adapter{
		"codex": codexAdapter{}, "pi": piAdapter{}, "claude": claudeAdapter{},
	}
}

func Discover(ctx context.Context, host string) Directory {
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
			child, cancel := context.WithTimeout(ctx, 8*time.Second)
			defer cancel()
			ss, err := a.discover(child, host)
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

func Send(ctx context.Context, host string, req Request) (Receipt, error) {
	if err := validateRequest(host, req); err != nil {
		return rejected(req, "validation", err.Error()), err
	}
	addr, _ := ParseAddress(req.Address)
	a, ok := adapters()[addr.Harness]
	if !ok {
		err := errCode("unsupported_harness", "unsupported harness %q", addr.Harness)
		return rejected(req, "none", err.Error()), err
	}
	return withDedup(ctx, req, func() (Receipt, error) {
		files, err := materializeAttachments(req.MessageID, req.Attachments)
		if err != nil {
			receipt := rejected(req, "attachments", err.Error())
			return receipt, errCode("preflight_failed", "cannot store attachments: %v", err)
		}
		text, err := renderAttachmentText(req.Text, files)
		if err != nil {
			receipt := rejected(req, "attachments", err.Error())
			return receipt, errCode("preflight_failed", "%v", err)
		}
		delivery := req
		delivery.Text = text
		delivery.Attachments = nil
		receipt, sendErr := a.send(ctx, addr, delivery)
		receipt.Files = files
		return receipt, sendErr
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
	if (r.Text == "" && len(r.Attachments) == 0) || len(r.Text) > 64<<10 || strings.ContainsRune(r.Text, 0) {
		return errCode("invalid_request", "text must be at most 65536 bytes and may be empty only with attachments")
	}
	if len(r.From) > 1024 || hasControl(r.From) {
		return errCode("invalid_request", "from is too long or contains NUL")
	}
	return validateAttachments(r.Attachments)
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

func dataDir() string {
	if p := os.Getenv("SHUTTLE_DATA_DIR"); p != "" {
		return p
	}
	h, _ := os.UserHomeDir()
	return h + "/.shuttle"
}
