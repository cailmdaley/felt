// Package transcriptindex indexes harness-owned JSONL transcripts as rebuildable
// local data. It has no dependency on Shuttle's ledgers or messaging transports.
package transcriptindex

import (
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

type Root struct{ Harness, Path string }

func Roots(env *sysenv.Env) ([]Root, error) {
	home, err := env.UserHomeDir()
	if err != nil {
		return nil, err
	}
	roots := []Root{{"claude", filepath.Join(home, ".claude", "projects")}, {"codex", filepath.Join(home, ".codex", "sessions")}, {"pi", filepath.Join(home, ".pi", "agent", "sessions")}}
	for i, key := range []string{"SHUTTLE_CLAUDE_PROJECTS_DIR", "SHUTTLE_CODEX_SESSIONS_DIR", "SHUTTLE_PI_SESSIONS_DIR"} {
		if p := strings.TrimSpace(env.Getenv(key)); p != "" {
			roots[i].Path = env.Resolve(p)
		}
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
