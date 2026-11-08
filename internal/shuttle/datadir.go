package shuttle

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// DataDir is the host-local shuttle state directory: $SHUTTLE_DATA_DIR, else
// ~/.shuttle. The variable is trimmed, and a leading "~" or "~/" is expanded
// to the home directory; the value is otherwise neither cleaned nor made
// absolute, so a socket-path check sees what the operator wrote. Every
// host-local file the CLI and the daemon keep — the event stream, the ledgers,
// the mailboxes, the daemon socket — lives under it.
//
// The daemon's Shuttle.data_dir/0 applies the same rule, and
// daemon/test/fixtures/data_dir/cases.json holds both readers to it.
//
// It errors only when a home directory is needed and cannot be resolved.
func DataDir(env *sysenv.Env) (string, error) {
	v := strings.TrimSpace(env.Getenv("SHUTTLE_DATA_DIR"))
	if v != "" && v != "~" && !strings.HasPrefix(v, "~/") {
		return v, nil
	}
	home, err := env.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	if v == "" {
		return filepath.Join(home, ".shuttle"), nil
	}
	return home + v[1:], nil
}

// StatePath resolves one host-local state file the way the daemon's
// Shuttle.state_path/2 does: $<envVar>, trimmed and otherwise taken as
// written, else <DataDir>/<leaf>. explicit reports whether the env var named
// the path. The path is "" when the data directory cannot be resolved.
// daemon/test/fixtures/data_dir/cases.json holds both readers to it.
func StatePath(env *sysenv.Env, envVar, leaf string) (path string, explicit bool) {
	if v := strings.TrimSpace(env.Getenv(envVar)); v != "" {
		return v, true
	}
	dir, err := DataDir(env)
	if err != nil {
		return "", false
	}
	return filepath.Join(dir, leaf), false
}

// EventsFile is the hook-event stream, events.jsonl. Its rotated sibling is
// the path plus ".1".
func EventsFile(env *sysenv.Env) (string, bool) {
	return StatePath(env, "SHUTTLE_EVENTS_FILE", "events.jsonl")
}

// SessionsFile is the daemon's session ledger, sessions.jsonl.
func SessionsFile(env *sysenv.Env) (string, bool) {
	return StatePath(env, "SHUTTLE_SESSIONS_FILE", "sessions.jsonl")
}

// CommitsFile is the commit ledger, commits.jsonl.
func CommitsFile(env *sysenv.Env) (string, bool) {
	return StatePath(env, "SHUTTLE_COMMITS_FILE", "commits.jsonl")
}
