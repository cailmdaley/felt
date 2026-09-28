package messaging

import "sort"

// addressHarnessNames is the complete address vocabulary: canonical names map
// to themselves, while ledger spellings map to their canonical address name.
// Keep the Elixir mirror in Shuttle.Harnesses aligned through the shared fixture.
var addressHarnessNames = map[string]string{
	"claude":      "claude",
	"claude-code": "claude",
	"codex":       "codex",
	"pi":          "pi",
}

// NormalizeHarness returns the canonical address name for a known harness
// spelling. Unknown names pass through so parsing can distinguish a valid but
// unsupported harness from malformed address syntax.
func NormalizeHarness(name string) string {
	if canonical, ok := addressHarnessNames[name]; ok {
		return canonical
	}
	return name
}

// LedgerHarnessName returns the spelling used by session-ledger records for a
// canonical harness. Claude's ledger spelling predates canonical addresses.
func LedgerHarnessName(name string) string {
	canonical := NormalizeHarness(name)
	if !isAddressHarness(canonical) {
		return ""
	}
	aliases := make([]string, 0, 1)
	for spelling, target := range addressHarnessNames {
		if spelling != target && target == canonical {
			aliases = append(aliases, spelling)
		}
	}
	if len(aliases) == 0 {
		return canonical
	}
	sort.Strings(aliases)
	return aliases[0]
}

func isAddressHarness(name string) bool {
	for _, canonical := range addressHarnessNames {
		if canonical == name {
			return true
		}
	}
	return false
}
