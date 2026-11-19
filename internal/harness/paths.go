package harness

import (
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// TranscriptRoot is the directory a harness keeps its transcripts in. The
// harnesses own those trees; felt and Shuttle only read them.
// daemon/lib/shuttle/harness_paths.ex is the daemon's copy of these roots, and
// daemon/test/fixtures/harness_paths/cases.json holds both to the same
// answers. A blank variable counts as unset.
func TranscriptRoot(env *sysenv.Env, name string) (string, error) {
	f, _ := Lookup(name)
	t := f.Transcripts
	if p := strings.TrimSpace(env.Getenv(t.Env)); t.Env != "" && p != "" {
		return env.Resolve(p), nil
	}
	if t.HomeEnv != "" {
		if p := strings.TrimSpace(env.Getenv(t.HomeEnv)); p != "" {
			return filepath.Join(env.Resolve(p), t.Leaf), nil
		}
	}
	home, err := env.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, filepath.FromSlash(t.Home), t.Leaf), nil
}

// ForTranscript names the harness whose tree holds transcript, or "" for a
// path under none of them.
func ForTranscript(env *sysenv.Env, transcript string) string {
	if transcript == "" {
		return ""
	}
	for _, f := range all {
		if dir, err := TranscriptRoot(env, f.Name); err == nil && strings.HasPrefix(transcript, dir+string(filepath.Separator)) {
			return f.Name
		}
	}
	return ""
}
