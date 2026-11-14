package transcriptindex

import (
	"context"
)

// Activity is one session's indexed activity inside a window: its main
// transcript file, the UTC time of its latest message and how many messages
// fall in the window, subagent files included.
type Activity struct {
	Session  string `json:"session"`
	Harness  string `json:"harness"`
	Project  string `json:"project"`
	Path     string `json:"path"`
	Last     string `json:"last_activity"`
	Messages int64  `json:"messages"`
}

// Recent lists the sessions with a message at or after since (RFC3339),
// newest activity first, optionally restricted to one harness.
func (i *Index) Recent(ctx context.Context, since, harness string) ([]Activity, error) {
	sql := `SELECT f.session, max(f.harness), max(f.project),
 coalesce(max(CASE WHEN instr(f.path,'/subagents/')=0 THEN f.path END), max(f.path)),
 strftime('%Y-%m-%dT%H:%M:%SZ',max(julianday(m.timestamp))), count(*)
 FROM messages m JOIN files f ON f.id=m.file_id
 WHERE f.session != '' AND julianday(m.timestamp)>=julianday(?)`
	args := []any{since}
	if harness != "" {
		sql += " AND f.harness=?"
		args = append(args, harness)
	}
	sql += " GROUP BY f.session ORDER BY max(julianday(m.timestamp)) DESC, f.session"
	rows, err := i.db.QueryContext(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Activity{}
	for rows.Next() {
		var a Activity
		if err := rows.Scan(&a.Session, &a.Harness, &a.Project, &a.Path, &a.Last, &a.Messages); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
