package transcriptindex

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// File is one indexed transcript file: a session's main thread, or one of its
// subagents (whose records carry the parent's session id).
type File struct {
	Path    string `json:"path"`
	Session string `json:"session"`
	Harness string `json:"harness"`
	Project string `json:"project"`
}

// Message is one indexed message, addressed by its JSONL line.
type Message struct {
	Line      int64  `json:"line"`
	Timestamp string `json:"timestamp"`
	Role      string `json:"role"`
	Text      string `json:"text"`
}

// Subagent reports whether f is a subagent's transcript rather than a
// session's main thread.
func (f File) Subagent() bool { return IsSubagentPath(f.Path) }

func IsSubagentPath(path string) bool {
	return strings.Contains(filepath.ToSlash(path), "/subagents/")
}

// AgentKey is the short name of a subagent transcript within its session: the
// first eight characters of the agent id's final hyphen segment, e.g.
// agent-aslide7-rebuild-b75db097fa97b60c.jsonl → b75db097. Empty for a main
// thread.
func AgentKey(path string) string {
	if !IsSubagentPath(path) {
		return ""
	}
	stem := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "agent-"), ".jsonl")
	if i := strings.LastIndex(stem, "-"); i >= 0 {
		stem = stem[i+1:]
	}
	if len(stem) > 8 {
		stem = stem[:8]
	}
	return stem
}

// ResolveFile finds the transcript file a session prefix and optional agent
// key name. A prefix matching more than one session is an error naming them.
func (i *Index) ResolveFile(ctx context.Context, sessionPrefix, agent string) (File, error) {
	rows, err := i.db.QueryContext(ctx, `SELECT path,session,harness,project FROM files
 WHERE session != '' AND substr(session,1,length(?))=? ORDER BY session,path`, sessionPrefix, sessionPrefix)
	if err != nil {
		return File{}, err
	}
	defer rows.Close()
	sessions := map[string]bool{}
	var matches []File
	for rows.Next() {
		var f File
		if err := rows.Scan(&f.Path, &f.Session, &f.Harness, &f.Project); err != nil {
			return File{}, err
		}
		sessions[f.Session] = true
		if AgentKey(f.Path) == agent {
			matches = append(matches, f)
		}
	}
	if err := rows.Err(); err != nil {
		return File{}, err
	}
	if len(sessions) > 1 {
		var names []string
		for s := range sessions {
			names = append(names, s)
		}
		return File{}, fmt.Errorf("session %q is ambiguous: %s", sessionPrefix, strings.Join(names, ", "))
	}
	if len(matches) == 0 {
		if agent != "" && len(sessions) == 1 {
			return File{}, fmt.Errorf("session %s has no subagent %q", sessionPrefix, agent)
		}
		return File{}, fmt.Errorf("no indexed session %q on this host", sessionPrefix)
	}
	return matches[len(matches)-1], nil
}

// Messages returns every indexed message of one file, in transcript order.
func (i *Index) Messages(ctx context.Context, path string) ([]Message, error) {
	rows, err := i.db.QueryContext(ctx, `SELECT m.line,m.timestamp,m.role,m.text FROM messages m JOIN files f ON f.id=m.file_id
 WHERE f.path=? ORDER BY m.line,m.id`, path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.Line, &m.Timestamp, &m.Role, &m.Text); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// FirstMessage is the first indexed message of one role in a file.
func (i *Index) FirstMessage(ctx context.Context, path, role string) (Message, error) {
	var m Message
	err := i.db.QueryRowContext(ctx, `SELECT m.line,m.timestamp,m.role,m.text FROM messages m JOIN files f ON f.id=m.file_id
 WHERE f.path=? AND m.role=? ORDER BY m.line,m.id LIMIT 1`, path, role).Scan(&m.Line, &m.Timestamp, &m.Role, &m.Text)
	return m, err
}
