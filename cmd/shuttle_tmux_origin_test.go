package cmd

import (
	"runtime"
	"testing"
)

// classifyTmuxOrigin is the Go half of a two-language contract — the Elixir
// daemon's Shuttle.TmuxServer.classify_origin/2 is the other. The table below
// mirrors the Elixir test's cases, including the real daemon-born argv captured
// off a live macOS host.
func TestClassifyTmuxOrigin(t *testing.T) {
	daemonArgv := "tmux new-session -d -s civbench-01KTHDNZS287ZSSG8X8V59XKWB-shuttle " +
		"-c /Users/someone/loom bash -l /var/folders/xx/T/shuttle-run-2115.sh"

	cases := []struct {
		name   string
		marker string
		argv   string
		want   string
	}{
		{"marker wins", "SHUTTLE_TMUX_ORIGIN=kitty:2026-09-12T22:15:03Z", "", tmuxOriginKittyBorn},
		{"marker beats daemon argv", "SHUTTLE_TMUX_ORIGIN=kitty:now", daemonArgv, tmuxOriginKittyBorn},
		{"blank marker is no marker", "  \n", "", tmuxOriginAbsent},
		{"real daemon-born argv", "", daemonArgv, tmuxOriginDaemonBorn},
		{"run script alone", "", "bash -l /tmp/shuttle-run-7.sh", tmuxOriginDaemonBorn},
		{"worker session alone", "", "tmux new-session -d -s leaf-uid-shuttle", tmuxOriginDaemonBorn},
		{"a human's own server", "", "tmux -CC attach", tmuxOriginUnknown},
		{"the anchor is not a worker", "", "tmux new-session -d -s shuttle-anchor", tmuxOriginUnknown},
		{"no server", "", "", tmuxOriginAbsent},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyTmuxOrigin(tc.marker, tc.argv); got != tc.want {
				t.Fatalf("classifyTmuxOrigin(%q, %q) = %q, want %q", tc.marker, tc.argv, got, tc.want)
			}
		})
	}
}

// A daemon-born server must fail the receipt: it is the one origin whose remedy
// (restart the server from kitty) no other surface would ever suggest, and
// leaving it healthy means the human keeps dismissing "erlexec" prompts forever.
func TestCollectTmuxServerReceiptFailsOnlyOnDaemonBorn(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the tmux-server receipt is macOS-only; there is nothing to report here")
	}

	for _, tc := range []struct {
		origin string
		want   receiptStatus
	}{
		{tmuxOriginDaemonBorn, receiptMismatch},
		{tmuxOriginKittyBorn, receiptHealthy},
		{tmuxOriginUnknown, receiptHealthy},
		{tmuxOriginAbsent, receiptHealthy},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			restore := stubTmuxOrigin(tmuxOriginReport{Origin: tc.origin, ServerPID: "22457"})
			defer restore()

			rec := collectTmuxServerReceipt()
			if rec == nil {
				t.Fatal("expected a tmux-server receipt on darwin")
			}
			if rec.Status != tc.want {
				t.Fatalf("origin %s: status %s, want %s", tc.origin, rec.Status, tc.want)
			}
			if tc.want == receiptMismatch && rec.Repair == "" {
				t.Fatal("a mismatch must carry the restart-from-kitty repair")
			}
		})
	}
}

// The whole-receipt propagation: a daemon-born server alone makes the runtime
// receipt mismatched, and the top-level repair names the tmux remedy rather
// than the generic "repair the mismatched plugin" line.
func TestRuntimeReceiptSurfacesDaemonBornTmuxServer(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the tmux-server receipt is macOS-only")
	}

	restore := stubTmuxOrigin(tmuxOriginReport{Origin: tmuxOriginDaemonBorn, ServerPID: "22457"})
	defer restore()

	status, repair := combineReceiptStatus(
		receiptHealthy, nil, receiptHealthy, receiptHealthy,
		receiptHealthy, collectTmuxServerReceipt().Status,
	)
	if status != receiptMismatch {
		t.Fatalf("combined status %s, want %s", status, receiptMismatch)
	}
	if repair == "" {
		t.Fatal("a mismatched receipt must carry a repair")
	}
}

func stubTmuxOrigin(report tmuxOriginReport) func() {
	prev := detectTmuxOrigin
	detectTmuxOrigin = func() tmuxOriginReport { return report }
	return func() { detectTmuxOrigin = prev }
}
