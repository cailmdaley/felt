// Package harnesspaths names the directory trees Claude Code, Codex and Pi
// keep their transcripts in. The harnesses own those trees; felt and Shuttle
// only read them. daemon/lib/shuttle/harness_paths.ex is the daemon's copy of
// these roots, and daemon/test/fixtures/harness_paths/cases.json holds both
// to the same answers.
//
// Each root takes Shuttle's explicit override first, then the harness's own
// home variable, then the harness default under the home directory:
//
//	claude  $SHUTTLE_CLAUDE_PROJECTS_DIR → $CLAUDE_CONFIG_DIR/projects → ~/.claude/projects
//	codex   $SHUTTLE_CODEX_SESSIONS_DIR  → $CODEX_HOME/sessions        → ~/.codex/sessions
//	pi      $SHUTTLE_PI_SESSIONS_DIR     →                               ~/.pi/agent/sessions
//
// A blank variable counts as unset.
package harnesspaths

import (
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// ClaudeProjects is the root of Claude Code's per-project transcripts.
func ClaudeProjects(env *sysenv.Env) (string, error) {
	return root(env, "SHUTTLE_CLAUDE_PROJECTS_DIR", "CLAUDE_CONFIG_DIR", ".claude", "projects")
}

// CodexSessions is the root of Codex's dated rollout tree.
func CodexSessions(env *sysenv.Env) (string, error) {
	return root(env, "SHUTTLE_CODEX_SESSIONS_DIR", "CODEX_HOME", ".codex", "sessions")
}

// PiSessions is the root of Pi's per-directory session files.
func PiSessions(env *sysenv.Env) (string, error) {
	return root(env, "SHUTTLE_PI_SESSIONS_DIR", "", filepath.Join(".pi", "agent"), "sessions")
}

// Harness names the harness whose tree holds transcript, or "" for a path
// under none of them.
func Harness(env *sysenv.Env, transcript string) string {
	if transcript == "" {
		return ""
	}
	for _, r := range []struct {
		name string
		root func(*sysenv.Env) (string, error)
	}{{"claude", ClaudeProjects}, {"codex", CodexSessions}, {"pi", PiSessions}} {
		if dir, err := r.root(env); err == nil && strings.HasPrefix(transcript, dir+string(filepath.Separator)) {
			return r.name
		}
	}
	return ""
}

func root(env *sysenv.Env, override, homeVar, homeDefault, leaf string) (string, error) {
	if p := strings.TrimSpace(env.Getenv(override)); p != "" {
		return env.Resolve(p), nil
	}
	if homeVar != "" {
		if p := strings.TrimSpace(env.Getenv(homeVar)); p != "" {
			return filepath.Join(env.Resolve(p), leaf), nil
		}
	}
	home, err := env.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, homeDefault, leaf), nil
}
