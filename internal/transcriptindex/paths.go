// Package transcriptindex indexes harness-owned JSONL transcripts as rebuildable
// local data. It has no dependency on Shuttle's ledgers or messaging transports.
package transcriptindex

import (
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/harnesspaths"
	"github.com/cailmdaley/felt/internal/sysenv"
)

type Root struct{ Harness, Path string }

// Roots are the harness transcript trees the index covers.
func Roots(env *sysenv.Env) ([]Root, error) {
	var roots []Root
	for _, r := range []struct {
		harness string
		path    func(*sysenv.Env) (string, error)
	}{{"claude", harnesspaths.ClaudeProjects}, {"codex", harnesspaths.CodexSessions}, {"pi", harnesspaths.PiSessions}} {
		path, err := r.path(env)
		if err != nil {
			return nil, err
		}
		roots = append(roots, Root{r.harness, path})
	}
	return roots, nil
}

func DefaultPath(env *sysenv.Env) (string, error) {
	if p := strings.TrimSpace(env.Getenv("SHUTTLE_TRANSCRIPT_INDEX")); p != "" {
		return env.Resolve(p), nil
	}
	base := env.Getenv("XDG_CACHE_HOME")
	if base == "" {
		home, err := env.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".cache")
	}
	return env.Resolve(filepath.Join(base, "felt", "transcript-index.sqlite")), nil
}
