package shuttlecli

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/cailmdaley/felt/internal/harness"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/transcriptindex"
)

// recentSessions is `shuttle sessions --since --json`: every session on one
// host with a transcript message since a time, live or ended.
type recentSessions struct {
	Host     string          `json:"host"`
	Since    string          `json:"since"`
	Sessions []recentSession `json:"sessions"`
	Errors   []string        `json:"errors"`
}

type recentSession struct {
	transcriptindex.Activity
	Host    string            `json:"host"`
	Address string            `json:"address"`
	Live    bool              `json:"live"`
	Fibers  []transcriptFiber `json:"fibers"`
	Title   string            `json:"title,omitempty"`
}

const recentSessionsTimeout = 2 * time.Minute

// runRecentSessions lists the sessions touched since o.since on o.host: this
// host's transcript index read directly, another host's through the local
// daemon, which asks that host's daemon to run the same listing there.
func (a *app) runRecentSessions(ctx context.Context, o *sessionsDiscoveryOptions) error {
	since, err := parseTranscriptSince(o.since, a.eventNow())
	if err != nil {
		return err
	}
	kind := harness.Normalize(strings.TrimSpace(o.harness))
	if kind != "" && !harness.Known(kind) {
		return fmt.Errorf("--harness must be one of %s", harness.Names())
	}
	own, err := a.resolveOwnHost("")
	if err != nil {
		return err
	}
	if o.local && o.host != "" && o.host != own {
		return fmt.Errorf("--local lists this host (%s), not %s", own, o.host)
	}
	var result recentSessions
	if o.local || o.host == "" || o.host == own {
		result, err = a.localRecentSessions(ctx, own, since, kind)
	} else {
		result, err = a.remoteRecentSessions(o.host, since, kind)
	}
	if err != nil {
		return err
	}
	if a.json {
		return a.outputJSON(result)
	}
	for _, problem := range result.Errors {
		fmt.Fprintln(a.env.Stderr, "warning:", problem)
	}
	if len(result.Sessions) == 0 {
		fmt.Fprintf(a.env.Stdout, "no sessions on %s since %s\n", result.Host, result.Since)
		return nil
	}
	for _, s := range result.Sessions {
		state := "ended"
		if s.Live {
			state = "live"
		}
		label := sessionLabel(s.Fibers, s.Title)
		if s.Project != "" {
			label = strings.TrimSpace(label + "  · " + filepath.Base(s.Project))
		}
		fmt.Fprintf(a.env.Stdout, "%s  %-5s  %-6s  %-12s  %s\n", formatTranscriptTime(s.Last), state, s.Harness, s.Address, label)
	}
	return nil
}

func (a *app) localRecentSessions(ctx context.Context, host, since, harness string) (recentSessions, error) {
	result := recentSessions{Host: host, Since: since, Sessions: []recentSession{}, Errors: []string{}}
	path, err := transcriptindex.DefaultPath(a.env)
	if err != nil {
		return result, err
	}
	idx, err := transcriptindex.Open(path)
	if err != nil {
		return result, err
	}
	defer idx.Close()
	ready, err := idx.Ready(ctx)
	if err != nil {
		return result, err
	}
	if !ready {
		return result, fmt.Errorf("transcript index has no completed scan; the daemon builds it in the background when available; if no daemon is running, run `shuttle transcript index`")
	}
	roots, err := transcriptindex.Roots(a.env)
	if err != nil {
		return result, err
	}
	problems, err := idx.CatchUp(ctx, roots, false)
	if err != nil {
		return result, err
	}
	result.Errors = append(result.Errors, problems...)
	activity, err := idx.Recent(ctx, since, harness)
	if err != nil {
		return result, err
	}
	labels, ledgerErr := a.newSessionLabels(idx)
	if ledgerErr != nil {
		result.Errors = append(result.Errors, "session ledger unavailable: "+ledgerErr.Error())
	}
	live := map[string]bool{}
	directory := messaging.Discover(ctx, a.env, host)
	for _, s := range directory.Sessions {
		live[s.ID] = true
		if s.TranscriptID != "" {
			live[s.TranscriptID] = true
		}
	}
	for _, gap := range directory.Gaps {
		result.Errors = append(result.Errors, fmt.Sprintf("live %s sessions unknown: %s", gap.Harness, gap.Error))
	}
	for _, act := range activity {
		row := recentSession{Activity: act, Host: host, Address: shortSession(act.Session), Live: live[act.Session], Fibers: labels.fibers(act.Session)}
		row.Title = labels.title(ctx, act.Session, len(row.Fibers) > 0)
		result.Sessions = append(result.Sessions, row)
	}
	return result, nil
}

func (a *app) remoteRecentSessions(host, since, harness string) (recentSessions, error) {
	var result recentSessions
	endpoint, err := a.daemonEndpoint("/api/v1/sessions/recent")
	if err != nil {
		return result, err
	}
	q := url.Values{"host": {host}, "since": {since}}
	if harness != "" {
		q.Set("harness", harness)
	}
	body, err := a.getDaemon(endpoint+"?"+q.Encode(), recentSessionsTimeout+30*time.Second)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return result, fmt.Errorf("parsing %s's sessions: %w", host, err)
	}
	return result, nil
}
