package shuttlecli

import "testing"

// Every hop of a Poller-backed write outlasts the hop beneath it, so the
// innermost party with an answer gives it before an outer client hangs up.
// The owner and forward budgets mirror Shuttle.Poller.dispatch_call_timeout_ms/0
// and Shuttle.OriginRouter.default_forward_timeout_ms/0; daemon/test/shuttle/
// poller_call_timeout_test.exs pins the same numbers.
func TestDaemonWriteTimeoutLadder(t *testing.T) {
	if daemonOwnerCallBudget.Milliseconds() != 30_000 || daemonForwardBudget.Milliseconds() != 40_000 {
		t.Fatalf("owner/forward budgets %v/%v drifted from the daemon's 30s/40s", daemonOwnerCallBudget, daemonForwardBudget)
	}
	if daemonPostTimeout <= daemonOwnerCallBudget {
		t.Fatalf("local write timeout %v must outlast the owner's Poller call %v", daemonPostTimeout, daemonOwnerCallBudget)
	}
	if daemonRoutedPostTimeout <= daemonForwardBudget {
		t.Fatalf("routed write timeout %v must outlast the daemon's forward %v", daemonRoutedPostTimeout, daemonForwardBudget)
	}
	if routedWaitNotice >= daemonRoutedPostTimeout {
		t.Fatalf("the wait notice %v must come before the routed timeout %v", routedWaitNotice, daemonRoutedPostTimeout)
	}
}
