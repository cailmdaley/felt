package transcriptindex

import (
	"context"
	"fmt"
	"strings"
	"unicode"
)

type Options struct {
	Sessions         []string
	ExcludeSessions  []string
	Since            string
	Project, Harness string
	Limit            int
	PerMessage       bool
}
type Hit struct {
	Session   string  `json:"session"`
	Harness   string  `json:"harness"`
	Project   string  `json:"project"`
	Path      string  `json:"path"`
	Line      int64   `json:"line"`
	Timestamp string  `json:"timestamp"`
	Role      string  `json:"role"`
	Score     float64 `json:"score"`
	Snippet   string  `json:"snippet"`
	Matches   int     `json:"matches"`
}

// literalQuery quotes whitespace-separated terms, so operator names are
// ordinary words, and punctuation-separated path fragments stay adjacent.
// SQLite applies the index's tokenizer inside each quoted term.
func literalQuery(query string) string {
	var terms []string
	for _, word := range strings.Fields(query) {
		if !strings.ContainsFunc(word, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' }) {
			continue
		}
		terms = append(terms, "\""+strings.ReplaceAll(word, "\"", "\"\"")+"\"")
	}
	return strings.Join(terms, " AND ")
}
func (i *Index) Search(ctx context.Context, query string, opts Options) ([]Hit, error) {
	hits := []Hit{}
	match := literalQuery(query)
	if match == "" {
		return hits, nil
	}
	if opts.Sessions != nil && len(opts.Sessions) == 0 {
		return hits, nil
	}
	if opts.Limit == 0 {
		opts.Limit = 20
	}
	if opts.Limit < 0 {
		return nil, fmt.Errorf("limit must be positive")
	}
	// Native Codex exports can carry external-agent tools as assistant text.
	// Resolve their anchored envelopes at query time so populated indexes need
	// no rebuild; both the returned role and ranking use the effective role.
	const role = `CASE
 WHEN substr(m.text,1,28)='[external_agent_tool_result]' THEN 'tool_result'
 WHEN substr(m.text,1,26)='[external_agent_tool_call:' THEN 'tool_call'
 ELSE m.role END`
	// BM25 scores are negative; negate before applying the conversational-role
	// boost. A tool match can still win if its raw relevance is >1.5 times
	// that of a user/assistant match. Apply this before LIMIT, not to a shortlist.
	sql := `SELECT f.session,f.harness,f.project,f.path,m.line,m.timestamp,` + role + ` AS role,
 -bm25(search) * CASE WHEN (` + role + `) IN ('user','assistant') THEN 1.5 ELSE 1.0 END AS score,
 snippet(search,0,'«','»','…',40) AS snippet,m.id AS message_id
 FROM search JOIN messages m ON m.id=search.rowid JOIN files f ON f.id=m.file_id WHERE search MATCH ?`
	args := []any{match}
	if opts.Sessions != nil {
		sql += " AND f.session IN (" + strings.TrimSuffix(strings.Repeat("?,", len(opts.Sessions)), ",") + ")"
		for _, s := range opts.Sessions {
			args = append(args, s)
		}
	}
	if len(opts.ExcludeSessions) > 0 {
		sql += " AND f.session NOT IN (" + strings.TrimSuffix(strings.Repeat("?,", len(opts.ExcludeSessions)), ",") + ")"
		for _, s := range opts.ExcludeSessions {
			args = append(args, s)
		}
	}
	if opts.Since != "" {
		sql += " AND julianday(m.timestamp)>=julianday(?)"
		args = append(args, opts.Since)
	}
	if opts.Project != "" {
		sql += " AND substr(f.project,1,length(?))=?"
		args = append(args, opts.Project, opts.Project)
	}
	if opts.Harness != "" {
		sql += " AND f.harness=?"
		args = append(args, opts.Harness)
	}
	// Materialize FTS auxiliary values before applying window functions: SQLite
	// requires bm25 and snippet to run in the MATCH query's context.
	if opts.PerMessage {
		sql = "SELECT session,harness,project,path,line,timestamp,role,score,snippet,1 AS matches FROM (" + sql + ") ORDER BY score DESC,message_id LIMIT ?"
	} else {
		sql = `WITH matched AS MATERIALIZED (` + sql + `), ranked AS (
 SELECT *, count(*) OVER (PARTITION BY session) AS matches,
 row_number() OVER (PARTITION BY session ORDER BY score DESC,message_id) AS position
 FROM matched)
 SELECT session,harness,project,path,line,timestamp,role,score,snippet,matches
 FROM ranked WHERE position=1 ORDER BY score DESC,message_id LIMIT ?`
	}
	args = append(args, opts.Limit)
	rows, err := i.db.QueryContext(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var h Hit
		if err = rows.Scan(&h.Session, &h.Harness, &h.Project, &h.Path, &h.Line, &h.Timestamp, &h.Role, &h.Score, &h.Snippet, &h.Matches); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}
