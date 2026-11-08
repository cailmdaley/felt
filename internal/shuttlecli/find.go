package shuttlecli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/feltcli"
	"github.com/cailmdaley/felt/internal/transcriptindex"
	"github.com/spf13/cobra"
)

// findResult is `shuttle find --json`: felt find's fiber hits, then
// transcript search's session hits, with whatever kept either half short.
type findResult struct {
	Query       string                 `json:"query"`
	Fibers      []feltcli.FindHit      `json:"fibers"`
	Transcripts []transcriptSearchHit  `json:"transcripts"`
	Index       *transcriptindex.Stats `json:"index,omitempty"`
	Errors      []string               `json:"errors"`
}

func (a *app) findCmd() *cobra.Command {
	var fq feltcli.FindQuery
	var since, harness string
	cmd := &cobra.Command{
		Use:   "find <query...>",
		Short: "Search fibers and session transcripts together",
		Long: `find answers "does this exist, was this discussed, where did we put X" in one
call. It runs felt find over the whole store, then shuttle transcript search
over every Claude, Codex and Pi session on this host, and prints the fibers
first and the sessions after.

The fiber half takes felt find's flags and ranking. The transcript half
searches the same words, grouped by session, leaving out the calling session;
it is skipped for a regex (-r) or a query-less filter (-t, --has-field).
--limit caps both the enclosing store's fiber block and the session count.
A half that fails is reported and the other still prints.

felt find searches fibers alone; shuttle transcript search searches sessions
alone, with more filters.`,
		Example: `  shuttle find "fish recipe"
  shuttle find covariance --since 30d
  shuttle find -t decision quarantine --json`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			fq.Query = strings.Join(args, " ")
			fq.Changed(cmd)
			tq := transcriptQuery{Query: fq.Query, Since: since, Harness: harness, Limit: fq.Limit}
			if tq.Limit <= 0 {
				tq.Limit = 100
			}
			if harness != "" && harness != "claude" && harness != "codex" && harness != "pi" {
				return fmt.Errorf("--harness must be claude, codex, or pi")
			}
			if _, err := parseTranscriptSince(since, a.eventNow()); err != nil {
				return err
			}
			searchTranscripts := strings.TrimSpace(fq.Query) != "" && !fq.Regex

			var transcripts transcriptSearchResult
			var transcriptErr error
			done := make(chan struct{})
			if searchTranscripts {
				go func() {
					defer close(done)
					ctx, cancel := context.WithTimeout(cmd.Context(), 2*time.Minute)
					defer cancel()
					transcripts, transcriptErr = a.searchTranscripts(ctx, tq)
				}()
			} else {
				close(done)
			}
			fibers, fiberErr := feltcli.Find(a.env, a.dir, fq, a.json)
			<-done

			if fiberErr != nil && (transcriptErr != nil || !searchTranscripts) {
				return errors.Join(fiberErr, transcriptErr)
			}

			result := findResult{Query: fq.Query, Fibers: []feltcli.FindHit{}, Transcripts: []transcriptSearchHit{}, Errors: []string{}}
			if fiberErr != nil {
				result.Errors = append(result.Errors, "fibers: "+fiberErr.Error())
			} else {
				result.Fibers = fibers.Hits()
			}
			if transcriptErr != nil {
				result.Errors = append(result.Errors, "transcripts: "+transcriptErr.Error())
			} else if searchTranscripts {
				result.Transcripts = transcripts.Hits
				result.Index = &transcripts.Index
				for _, problem := range transcripts.Errors {
					result.Errors = append(result.Errors, "transcripts: "+problem)
				}
			}

			if a.json {
				felts := make([]*felt.Felt, len(result.Fibers))
				for i, hit := range result.Fibers {
					felts[i] = hit.Felt
				}
				if err := a.resolveShuttleJSON(felts...); err != nil {
					return err
				}
				return a.outputJSON(result)
			}
			for _, problem := range result.Errors {
				fmt.Fprintln(a.env.Stderr, "warning:", problem)
			}
			out := a.env.Stdout
			if fiberErr == nil {
				fibers.Write(out)
			}
			if !searchTranscripts || transcriptErr != nil {
				return nil
			}
			if fiberErr == nil {
				fmt.Fprintln(out)
			}
			if len(result.Transcripts) == 0 {
				fmt.Fprintf(out, "No sessions matching %q\n", fq.Query)
				return nil
			}
			fmt.Fprintln(out, "── sessions ──")
			writeTranscriptHits(out, result.Transcripts)
			return nil
		},
	}
	feltcli.AddFindFlags(cmd, &fq)
	cmd.Flags().Lookup("limit").Usage = "Cap on fibers printed from the enclosing store and on sessions (0 = fibers uncapped, 100 sessions)"
	cmd.Flags().StringVar(&since, "since", "", "sessions: restrict by age (30d or YYYY-MM-DD)")
	cmd.Flags().StringVar(&harness, "harness", "", "sessions: harness (claude, codex, pi)")
	return cmd
}
