package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// ShuttleContractLevel is the integer version of the daemon-shelled CLI
// surface: every flag/output shape the Elixir Poller depends on when it shells
// `felt shuttle <verb>` (mark-runtime, reopen, the lifecycle verbs) at
// dispatch/conclude time. It is NOT felt's release version (Version, set via
// ldflags) — that tracks the whole binary; this tracks one narrow contract so
// the daemon can boot-check compatibility without caring that felt gained an
// unrelated `ls` flag.
//
// Bump this integer whenever a change to the daemon-shelled surface could break
// an already-running daemon shelling an old/new CLI, or vice versa — the exact
// skew that shipped 80ce7b3 (a post-fix daemon shelling a pre-fix CLI that
// didn't know --host, silently failing every dispatch write). Concretely, bump
// on:
//   - a flag added, removed, or renamed on mark-runtime, reopen, or any other
//     lifecycle verb the daemon shells (see lib/shuttle/continuation.ex,
//     lib/shuttle/dispatcher.ex run_reopen, lib/shuttle/transition.ex)
//   - a change to what a shelled verb's stdout/exit-code means, where the
//     daemon parses it (e.g. mark-runtime's success text, an exit code the
//     daemon now branches on)
//
// Do NOT bump for changes that don't touch the daemon-shelled surface (human
// verbs like `felt add`, `felt ls`, read-only JSON views the daemon doesn't
// consume for lifecycle writes).
//
// At daemon boot, the Poller shells `felt shuttle contract`, parses the bare
// integer it prints on stdout, and compares it to its own baked expectation —
// surfacing a version-skew warning/refusal at startup instead of failing one
// shelled write at a time.
//
// Level 2 (C1): removed `--host` from mark-runtime and reopen — post-S1,
// `resolveOwnHost` is pure local state, so the daemon-shelled ownership
// override carried no correctness and a CLI that still expects it (or a
// daemon that still sends it against a CLI that dropped it) is exactly the
// kind of flag-shape skew this level exists to catch. Bumped in lockstep
// with lib/shuttle/contract.ex's @expected_level.
const ShuttleContractLevel = 2

var shuttleContractCmd = &cobra.Command{
	Use:   "contract",
	Short: "Print the daemon-shelled CLI contract level (daemon-facing)",
	Long: `Prints ShuttleContractLevel — a bare integer, nothing else, exit 0 — the
version of the flag/output surface the Shuttle daemon depends on when it shells
mark-runtime, reopen, and the other lifecycle verbs. The daemon shells this at
Poller.init and compares it to its own baked expectation, so a stale CLI
installed alongside a newer daemon (or vice versa) is caught once at boot
instead of failing one shelled write at a time with "unknown flag".

Stable output contract: stdout is exactly "<level>\n" with no other text. Any
other output on stdout, or a non-zero exit, means the daemon cannot determine
the contract level and should treat the CLI as incompatible.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Println(ShuttleContractLevel)
		return nil
	},
}

func init() {
	shuttleCmd.AddCommand(shuttleContractCmd)
}
