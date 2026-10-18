package shuttlecli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

// ----------------------------------------------------------------------------
// `shuttle hook interrupted` — an interrupt no harness hook reports
// ----------------------------------------------------------------------------
//
// Neither Claude Code nor Codex fires a hook when the human interrupts a turn,
// so the stream would leave that turn open forever. Both harnesses record the
// interrupt in their own transcript, and the daemon's
// Shuttle.InterruptWatcher reads it there and calls this verb, which appends
// one `interrupted` line to the same stream through the same writer.
//
// The line carries the transcript's own timestamp and record id, so a
// re-detection after a daemon restart writes the same id. It carries no
// receiver fields: the daemon is not the receiver, and SessionBinding joins a
// line without them directly by its session UUID.

func (a *app) hookInterruptedCmd() *cobra.Command {
	var session, harness, cwd, id string
	var at int64
	cmd := &cobra.Command{
		Use:   "interrupted",
		Short: "Record a turn interrupt read from a harness transcript",
		Long: `Appends one "interrupted" line to the host-local event stream for a
harness session whose transcript records that the human interrupted its turn.
The shuttle daemon calls this; no harness hook reports an interrupt.

--at is the transcript record's time in Unix milliseconds and --id its record
id. Writes under the same gate as ` + "`shuttle hook event`" + ` and exits 0 when
the stream is disabled.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if session == "" || id == "" || at <= 0 {
				return fmt.Errorf("--session, --id and --at are required")
			}
			if harness != "claude" && harness != "codex" {
				return fmt.Errorf("--harness must be claude or codex")
			}
			origin, err := a.resolveOwnHost("")
			if err != nil {
				origin = ""
			}
			line, err := encodeJSONLine(eventLine{
				ID:         session + "-interrupted-" + id,
				Timestamp:  at,
				Type:       "interrupted",
				SessionID:  session,
				CWD:        cwd,
				Harness:    messaging.LedgerHarnessName(harness),
				OriginName: origin,
			})
			if err != nil {
				return err
			}
			path, enabled := a.eventsSink()
			if !enabled {
				return nil
			}
			return a.appendEventLine(path, line)
		},
	}
	cmd.Flags().StringVar(&session, "session", "", "harness session UUID")
	cmd.Flags().StringVar(&harness, "harness", "", "claude or codex")
	cmd.Flags().StringVar(&cwd, "cwd", "", "the session's working directory")
	cmd.Flags().StringVar(&id, "id", "", "the transcript record id of the interrupt")
	cmd.Flags().Int64Var(&at, "at", 0, "the interrupt's time, Unix milliseconds")
	return cmd
}
