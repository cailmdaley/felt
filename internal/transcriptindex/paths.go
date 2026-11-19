// Package transcriptindex indexes harness-owned JSONL transcripts as rebuildable
// local data. It has no dependency on Shuttle's ledgers or messaging transports.
package transcriptindex

import (
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/harness"
	"github.com/cailmdaley/felt/internal/sysenv"
)

type Root struct{ Harness, Path string }

// Roots are the harness transcript trees the index covers.
func Roots(env *sysenv.Env) ([]Root, error) {
	var roots []Root
	for _, f := range harness.All() {
		path, err := harness.TranscriptRoot(env, f.Name)
		if err != nil {
			return nil, err
		}
		roots = append(roots, Root{f.Name, path})
	}
	return roots, nil
}

func DefaultPath(env *sysenv.Env) (string, error) {
	if p := strings.TrimSpace(env.Getenv("SHUTTLE_TRANSCRIPT_INDEX")); p != "" {
		return env.Resolve(p), nil
	}
	base, err := env.CacheDir()
	if err != nil {
		return "", err
	}
	return env.Resolve(filepath.Join(base, "felt", "transcript-index.sqlite")), nil
}
