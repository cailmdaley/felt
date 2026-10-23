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
type transcriptSearchHit struct {
	transcriptindex.Hit
	Fibers []transcriptFiber `json:"fibers"`
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
	cmd.Flags().StringVar(&file, "file", "", "index one transcript file (hook use)")
	cmd.Flags().StringVar(&harness, "harness", "", "transcript harness (hook use)")
	_ = cmd.Flags().MarkHidden("file")
	_ = cmd.Flags().MarkHidden("harness")
	return cmd
}

func (a *app) transcriptSearchCmd() *cobra.Command {
	var sessions []string
	var fiber, since, project, harness string
	var limit int
	var noIndex bool
	cmd := &cobra.Command{Use: "search <query...>", Short: "Search local harness transcripts by relevance", Args: cobra.MinimumNArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		query := strings.Join(args, " ")
		if limit < 1 {
			return fmt.Errorf("--limit must be positive")
		}
		if harness != "" && harness != "claude" && harness != "codex" && harness != "pi" {
			return fmt.Errorf("--harness must be claude, codex, or pi")
		}
		sinceValue, err := parseTranscriptSince(since, a.eventNow())
		if err != nil {
			return err
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
		ctx, cancel := context.WithTimeout(cmd.Context(), 2*time.Minute)
		defer cancel()
		stats, err := idx.Stats(ctx)
		if err != nil {
			return err
		}
		errorsList := []string{}
		ready, err := idx.Ready(ctx)
		if err != nil {
			return err
		}
		if !ready && stats.UpdatedAt == "" && stats.Messages == 0 {
			return fmt.Errorf("transcript search index is empty; run `shuttle transcript index` first")
		}
		if !noIndex {
			if !ready {
				return fmt.Errorf("transcript search index has no completed scan; run `shuttle transcript index` first")
			}
			roots, e := transcriptindex.Roots(a.env)
			if e != nil {
				return e
			}
			problems, catchErr := idx.CatchUp(ctx, roots, false)
			for _, problem := range problems {
				errorsList = append(errorsList, problem)
			}
			if catchErr != nil {
				return catchErr
			}
			stats, err = idx.Stats(ctx)
			if err != nil {
				return err
			}
		}
		var selected []string
		var ledger *sessionLedgerResponse
		if fiber != "" {
			var e error
			ledger, e = a.fetchSessionLedger()
			if e != nil {
				errorsList = append(errorsList, "fiber filter unavailable: "+e.Error())
				selected = []string{}
			} else {
				_, rows, _, resolveErr := a.resolveProvenanceRows(fiber, ledger.Records)
				if resolveErr != nil {
					errorsList = append(errorsList, "fiber filter unavailable: "+resolveErr.Error())
					selected = []string{}
				} else {
					selected = []string{}
					requested := map[string]bool{}
					for _, session := range sessions {
						requested[session] = true
					}
					for _, row := range rows {
						if len(sessions) > 0 && !requested[row.Session] && !requested[row.ThreadID] {
							continue
						}
						selected = append(selected, row.Session)
						if row.ThreadID != "" {
							selected = append(selected, row.ThreadID)
						}
					}
				}
			}
		} else if len(sessions) > 0 {
			selected = sessions
			ledger, err = a.fetchSessionLedger()
			if err != nil {
				errorsList = append(errorsList, "session ledger unavailable: "+err.Error())
			}
		} else {
			var e error
			ledger, e = a.fetchSessionLedger()
			if e != nil {
				errorsList = append(errorsList, e.Error())
			}
		}
		hits, err := idx.Search(ctx, query, transcriptindex.Options{Sessions: selected, Since: sinceValue, Project: project, Harness: harness, Limit: limit})
		if err != nil {
			return err
		}
		result := transcriptSearchResult{Query: query, Index: stats, Hits: []transcriptSearchHit{}, Errors: errorsList}
		fiberNamesByID := map[string]string{}
		for _, hit := range hits {
			fibers := []transcriptFiber{}
			seenFibers := map[string]bool{}
			if ledger != nil {
				for _, row := range ledger.Records {
					if row.Session == hit.Session || row.ThreadID == hit.Session {
						id := row.fiber()
						if id != "" && !seenFibers[id] {
							seenFibers[id] = true
							name, ok := fiberNamesByID[id]
							if !ok {
								name = filepath.Base(id)
								if f, e := a.shuttleAddressFiber(id); e == nil {
									name = f.Name
								}
								fiberNamesByID[id] = name
							}
							fibers = append(fibers, transcriptFiber{ID: id, Name: name})
						}
					}
				}
			}
			result.Hits = append(result.Hits, transcriptSearchHit{Hit: hit, Fibers: fibers})
		}
		if a.json {
			return a.outputJSON(result)
		}
		for _, problem := range result.Errors {
			fmt.Fprintln(a.env.Stderr, "warning:", problem)
		}
		for _, hit := range result.Hits {
			fmt.Fprintf(a.env.Stdout, "%.3f  %s  %-8s  %s  %s  %s\n  %s\n  open: %s:%d  (shuttle transcript %s)\n", hit.Score, hit.Timestamp, hit.Harness, filepath.Base(hit.Project), shortSession(hit.Session), strings.Join(fiberNames(hit.Fibers), ","), displaySnippet(a.env.Stdout, hit.Snippet), hit.Path, hit.Line, hit.Session)
		}
		return nil
	}}
	cmd.Flags().StringArrayVar(&sessions, "session", nil, "restrict to session ID (repeatable)")
	cmd.Flags().StringVar(&fiber, "fiber", "", "restrict to sessions linked to this fiber")
	cmd.Flags().StringVar(&since, "since", "", "restrict by age (30d or YYYY-MM-DD)")
	cmd.Flags().StringVar(&project, "project", "", "project path prefix")
	cmd.Flags().StringVar(&harness, "harness", "", "harness (claude, codex, pi)")
	cmd.Flags().IntVarP(&limit, "limit", "n", 20, "maximum hits")
	cmd.Flags().BoolVar(&noIndex, "no-index", false, "search without checking for new transcript content")
	return cmd
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
