package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// checkHostDrift warns about a shuttle block whose host: differs from this
// machine's resolved identity ONLY by case or a DNS suffix.
//
// That is the machine-readable signature of one specific event: the release
// that normalized the OS-hostname tier (lowercase, cut at the first ".").
// Before it, a fiber armed here could be stamped "Studio-Air.home"; after it,
// this machine answers "studio-air", and the dispatch predicate is exact
// equality — so the fiber goes quiet with nothing reporting a problem. The
// invisible-unhoming failure the normalization exists to prevent, reintroduced
// once at upgrade for exactly the people who hit the original bug.
//
// Deliberately narrow. A host: naming a genuinely different machine is normal
// and correct (cross-host installs are a feature), so only a name that
// normalizes to our own is reported, and only as a warning: check must not
// fail on a store legitimately shared with other hosts. An unresolvable local
// identity yields no issues rather than an error — `check` lints fibers, and
// a machine with no shuttle identity has nothing to compare against.
func checkHostDrift(felts []*felt.Felt) []felt.CheckIssue {
	own, err := resolveOwnHost("")
	if err != nil {
		return nil
	}
	own = strings.TrimSpace(own)
	if own == "" || own != normalizeHostname(own) {
		// An identity that is not itself normalized (an ssh alias with a dot,
		// say) gives us no signal to compare against.
		return nil
	}

	var issues []felt.CheckIssue
	for _, f := range felts {
		block, ok, err := f.ShuttleBlock()
		if err != nil || !ok || block == nil {
			continue
		}
		host := strings.TrimSpace(block.Host)
		if host == "" || host == own || normalizeHostname(host) != own {
			continue
		}
		issues = append(issues, felt.CheckIssue{
			Level:   felt.CheckLevelWarning,
			FiberID: f.ID,
			Path:    "shuttle.host",
			Message: fmt.Sprintf(
				"host %q is this machine under its pre-normalization name; the daemon now answers %q and matches host: exactly, so this fiber never dispatches — set host: %s",
				host, own, own),
		})
	}
	return issues
}
