package shuttlecli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/transcriptindex"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

type transcriptSearchResult struct {
	Query  string                `json:"query"`
	Index  transcriptindex.Stats `json:"index"`
	Hits   []transcriptSearchHit `json:"hits"`
	Errors []string              `json:"errors"`
}

// transcriptSearchHit is one session's best message, with what a reader needs
// to tell the session apart and the address `shuttle show` opens it at.
type transcriptSearchHit struct {
	transcriptindex.Hit
	Address  string            `json:"address"`
	Title    string            `json:"title,omitempty"`
	Subagent string            `json:"subagent,omitempty"`
	Fibers   []transcriptFiber `json:"fibers"`
}
type transcriptFiber struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (a *app) transcriptIndexCmd() *cobra.Command {
	var rebuild bool
	var file, harness string
	cmd := &cobra.Command{Use: "index", Short: "Build or update the local transcript search index", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		if cmd.Flags().Changed("file") && file == "" {
			return fmt.Errorf("--file must name a transcript")
		}
		if file == "" && harness != "" {
			return fmt.Errorf("--harness is only valid with --file")
		}
		path, err := transcriptindex.DefaultPath(a.env)
		if err != nil {
			return err
		}
		idx, err := transcriptindex.Open(path)
		if err != nil {
			return err
		}
		defer idx.Close()
		ctx := cmd.Context()
		if file != "" {
			if harness != "claude" && harness != "codex" && harness != "pi" {
				return fmt.Errorf("--file requires --harness claude, codex, or pi")
			}
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()
			if err := idx.IndexFile(ctx, file, harness); err != nil {
				return err
			}
		} else {
			roots, err := transcriptindex.Roots(a.env)
			if err != nil {
				return err
			}
			problems, err := idx.CatchUp(ctx, roots, rebuild)
			if err != nil {
				return err
			}
			if a.json {
				s, err := idx.Stats(ctx)
				if err != nil {
					return err
				}
				return a.outputJSON(struct {
					Index  transcriptindex.Stats `json:"index"`
					Errors []string              `json:"errors"`
				}{s, problems})
			}
			for _, problem := range problems {
				fmt.Fprintln(a.env.Stderr, "warning:", problem)
			}
		}
		if a.json {
			s, err := idx.Stats(ctx)
			if err != nil {
				return err
			}
			return a.outputJSON(struct {
				Index  transcriptindex.Stats `json:"index"`
				Errors []string              `json:"errors"`
			}{s, []string{}})
		}
		s, err := idx.Stats(ctx)
		if err == nil {
			fmt.Fprintf(a.env.Stdout, "Indexed %d sessions, %d messages (%s)\n", s.Sessions, s.Messages, s.Path)
		}
		return err
	}}
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "discard and rebuild the index")
	cmd.Flags().StringVar(&file, "file", "", "index one transcript file")
	cmd.Flags().StringVar(&harness, "harness", "", "transcript harness")
	_ = cmd.Flags().MarkHidden("file")
	_ = cmd.Flags().MarkHidden("harness")
	return cmd
}

// transcriptQuery is one search over this host's transcript index, as
// `shuttle transcript search` and `shuttle find` take it.
type transcriptQuery struct {
	Query           string
	Sessions        []string
	ExcludeSessions []string
	Fiber           string
	Since           string
	Project         string
	Harness         string
	Limit           int
	NoIndex         bool
	IncludeSelf     bool
	PerMessage      bool
}

func (a *app) transcriptSearchCmd() *cobra.Command {
	q := transcriptQuery{}
	cmd := &cobra.Command{Use: "search <query...>", Short: "Search local harness transcripts by relevance", Long: "Search local harness transcripts by relevance, returning each session's best message and matching-message count. Use --per-message for individual messages. The limit counts sessions by default. shuttle find runs this search alongside a fiber search.", Args: cobra.MinimumNArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		q.Query = strings.Join(args, " ")
		ctx, cancel := context.WithTimeout(cmd.Context(), 2*time.Minute)
		defer cancel()
		result, err := a.searchTranscripts(ctx, q)
		if err != nil {
			return err
		}
		if a.json {
			return a.outputJSON(result)
		}
		for _, problem := range result.Errors {
			fmt.Fprintln(a.env.Stderr, "warning:", problem)
		}
		writeTranscriptHits(a.env.Stdout, result.Hits)
		return nil
	}}
	cmd.Flags().StringArrayVar(&q.Sessions, "session", nil, "restrict to session ID (repeatable)")
	cmd.Flags().StringArrayVar(&q.ExcludeSessions, "exclude-session", nil, "exclude session ID even with --include-self (repeatable)")
	cmd.Flags().BoolVar(&q.IncludeSelf, "include-self", false, "disable automatic exclusion of the calling harness session")
	cmd.Flags().StringVar(&q.Fiber, "fiber", "", "restrict to sessions linked to this fiber")
	cmd.Flags().StringVar(&q.Since, "since", "", "restrict by age (30d or YYYY-MM-DD)")
	cmd.Flags().StringVar(&q.Project, "project", "", "project path prefix")
	cmd.Flags().StringVar(&q.Harness, "harness", "", "harness (claude, codex, pi)")
	cmd.Flags().IntVarP(&q.Limit, "limit", "n", 20, "maximum sessions (messages with --per-message)")
	cmd.Flags().BoolVar(&q.PerMessage, "per-message", false, "return individual messages instead of grouping by session")
	cmd.Flags().BoolVar(&q.NoIndex, "no-index", false, "search without checking for new transcript content")
	return cmd
}

// searchTranscripts runs q against this host's transcript index, first
// catching the index up with new transcript content unless q.NoIndex, and
// labels each hit with the fibers its session worked on.
func (a *app) searchTranscripts(ctx context.Context, q transcriptQuery) (transcriptSearchResult, error) {
	var none transcriptSearchResult
	if q.Limit < 1 {
		return none, fmt.Errorf("--limit must be positive")
	}
	if q.Harness != "" && q.Harness != "claude" && q.Harness != "codex" && q.Harness != "pi" {
		return none, fmt.Errorf("--harness must be claude, codex, or pi")
	}
	sinceValue, err := parseTranscriptSince(q.Since, a.eventNow())
	if err != nil {
		return none, err
	}
	path, err := transcriptindex.DefaultPath(a.env)
	if err != nil {
		return none, err
	}
	idx, err := transcriptindex.Open(path)
	if err != nil {
		return none, err
	}
	defer idx.Close()
	stats, err := idx.Stats(ctx)
	if err != nil {
		return none, err
	}
	errorsList := []string{}
	ready, err := idx.Ready(ctx)
	if err != nil {
		return none, err
	}
	if !ready && stats.UpdatedAt == "" && stats.Messages == 0 {
		return none, fmt.Errorf("transcript search index is empty; the daemon builds it in the background when available; if no daemon is running, run `shuttle transcript index`")
	}
	if !q.NoIndex {
		if !ready {
			return none, fmt.Errorf("transcript search index has no completed scan; the daemon builds it in the background when available; if no daemon is running, run `shuttle transcript index`")
		}
		roots, e := transcriptindex.Roots(a.env)
		if e != nil {
			return none, e
		}
		problems, catchErr := idx.CatchUp(ctx, roots, false)
		errorsList = append(errorsList, problems...)
		if catchErr != nil {
			return none, catchErr
		}
		if stats, err = idx.Stats(ctx); err != nil {
			return none, err
		}
	}
	var selected []string
	labels, ledgerErr := a.newSessionLabels(idx)
	ledger := labels.ledger
	if ledgerErr != nil {
		errorsList = append(errorsList, "session ledger unavailable: "+ledgerErr.Error())
	}
	if q.Fiber != "" {
		selected = []string{}
		if ledgerErr == nil {
			_, rows, _, resolveErr := a.resolveProvenanceRows(q.Fiber, ledger.Records)
			if resolveErr != nil {
				errorsList = append(errorsList, "fiber filter unavailable: "+resolveErr.Error())
			} else {
				requested := map[string]bool{}
				for _, session := range q.Sessions {
					requested[session] = true
				}
				for _, row := range rows {
					if len(q.Sessions) > 0 && !requested[row.Session] && !requested[row.ThreadID] {
						continue
					}
					selected = append(selected, row.Session)
					if row.ThreadID != "" {
						selected = append(selected, row.ThreadID)
					}
				}
			}
		}
	} else if len(q.Sessions) > 0 {
		selected = q.Sessions
	}
	excluded := append([]string(nil), q.ExcludeSessions...)
	if !q.IncludeSelf {
		if _, session := a.harnessSessionFromEnv(); session != "" {
			excluded = append(excluded, session)
		}
	}
	hits, err := idx.Search(ctx, q.Query, transcriptindex.Options{Sessions: selected, ExcludeSessions: excluded, Since: sinceValue, Project: q.Project, Harness: q.Harness, Limit: q.Limit, PerMessage: q.PerMessage})
	if err != nil {
		return none, err
	}
	result := transcriptSearchResult{Query: q.Query, Index: stats, Hits: []transcriptSearchHit{}, Errors: errorsList}
	for _, hit := range hits {
		labelled := transcriptSearchHit{Hit: hit, Address: addressOf(hit.Path, hit.Session, hit.Line), Subagent: subagentDescription(hit.Path), Fibers: labels.fibers(hit.Session)}
		labelled.Title = labels.title(ctx, hit.Session, len(labelled.Fibers) > 0)
		result.Hits = append(result.Hits, labelled)
	}
	return result, nil
}

// writeTranscriptHits prints each session as its date and name, the matching
// passage, and the command that opens it there.
func writeTranscriptHits(w io.Writer, hits []transcriptSearchHit) {
	for n, hit := range hits {
		if n > 0 {
			fmt.Fprintln(w)
		}
		head := []string{}
		if t := formatTranscriptTime(hit.Timestamp); t != "" {
			head = append(head, t[:10])
		}
		if label := sessionLabel(hit.Fibers, hit.Title); label != "" {
			head = append(head, label)
		}
		if hit.Project != "" {
			head = append(head, "· "+filepath.Base(hit.Project))
		}
		fmt.Fprintln(w, strings.Join(head, "  "))
		fmt.Fprintf(w, "  %s\n", displaySnippet(w, strings.Join(strings.Fields(hit.Snippet), " ")))
		open := "  → shuttle show " + hit.Address
		if hit.Subagent != "" {
			open += "   (in subagent: " + hit.Subagent + ")"
		}
		fmt.Fprintln(w, open)
	}
}

func displaySnippet(w io.Writer, snippet string) string {
	f, ok := w.(*os.File)
	if !ok {
		return snippet
	}
	if !isatty.IsTerminal(uintptr(f.Fd())) {
		return snippet
	}
	for {
		start := strings.Index(snippet, "«")
		if start < 0 {
			return snippet
		}
		endRel := strings.Index(snippet[start+len("«"):], "»")
		if endRel < 0 {
			return snippet
		}
		end := start + len("«") + endRel
		snippet = snippet[:start] + "\x1b[1m" + snippet[start+len("«"):end] + "\x1b[0m" + snippet[end+len("»"):]
	}
}

func parseTranscriptSince(value string, now time.Time) (string, error) {
	if value == "" {
		return "", nil
	}
	if day, err := time.Parse("2006-01-02", value); err == nil {
		return day.UTC().Format(time.RFC3339), nil
	}
	if strings.HasSuffix(value, "d") {
		days, err := strconv.ParseUint(strings.TrimSuffix(value, "d"), 10, 32)
		if err != nil || days == 0 || days > 106751 {
			return "", fmt.Errorf("invalid --since %q", value)
		}
		return now.Add(-time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339), nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return "", fmt.Errorf("--since must be a duration such as 30d or an ISO date")
	}
	return now.Add(-duration).UTC().Format(time.RFC3339), nil
}

func shortSession(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}
func fiberNames(fs []transcriptFiber) []string {
	out := []string{}
	for _, f := range fs {
		out = append(out, f.Name)
	}
	return out
}
