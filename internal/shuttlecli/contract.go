package shuttlecli

import (
	"fmt"

	"github.com/spf13/cobra"
)

// ShuttleContractLevel is the integer version of the daemon-shelled CLI
// surface: every flag/output shape the Elixir daemon depends on when it shells
// `shuttle <verb>` for lifecycle writes and fiber discovery. It is NOT felt's
// release version (Version, set via ldflags) — that tracks the whole binary;
// this tracks the narrower CLI contract so the daemon can boot-check compatibility.
//
// Bump this integer whenever a change to the daemon-shelled surface could break
// an already-running daemon shelling an old/new CLI, or vice versa — a daemon
// passing a flag the installed CLI does not know fails every dispatch write.
// Concretely, bump on:
//   - a flag added, removed, or renamed on a command the daemon shells, including
//     ls for fiber discovery (see daemon/lib/shuttle/continuation.ex,
//     daemon/lib/shuttle/dispatcher.ex, and daemon/lib/shuttle/transition.ex)
//   - a change to what a shelled verb's stdout/exit-code means, where the
//     daemon parses it (e.g. mark-runtime's success text, an exit code the
//     daemon now branches on)
//
// Do NOT bump for changes that don't touch a command the daemon shells (human
// verbs like `felt add` or read-only views the daemon does not consume).
//
// At daemon boot, the Poller shells `shuttle contract`, parses the bare
// integer it prints on stdout, and compares it to its own baked expectation —
// surfacing a version-skew warning/refusal at startup instead of failing one
// shelled write at a time. Bumped in lockstep with
// daemon/lib/shuttle/contract.ex's @expected_level.
const ShuttleContractLevel = 9

func (a *app) shuttleContractCmd() *cobra.Command {
	shuttleContractCmd := &cobra.Command{
		Use:   "contract",
		Short: "Print the daemon-shelled CLI contract level (daemon-facing)",
		Long: `Prints ShuttleContractLevel — a bare integer, nothing else, exit 0 — the
version of the flag/output surface the shuttle daemon depends on when it shells
mark-runtime, reopen, and the other lifecycle verbs. The daemon shells this at
Poller.init and compares it to its own baked expectation, so a stale CLI
installed alongside a newer daemon (or vice versa) is caught once at boot
instead of failing one shelled write at a time with "unknown flag".

Stable output contract: stdout is exactly "<level>\n" with no other text. Any
other output on stdout, or a non-zero exit, means the daemon cannot determine
the contract level and should treat the CLI as incompatible.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Fprintln(a.env.Stdout, ShuttleContractLevel)
			return nil
		},
	}
	return shuttleContractCmd
}
