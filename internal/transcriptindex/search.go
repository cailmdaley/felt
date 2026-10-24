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
	sql := `SELECT f.session,f.harness,f.project,f.path,m.line,m.timestamp,m.role,-bm25(search),snippet(search,0,'«','»','…',40)
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
	sql += " ORDER BY bm25(search),m.id LIMIT ?"
	args = append(args, opts.Limit)
	rows, err := i.db.QueryContext(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var h Hit
		if err = rows.Scan(&h.Session, &h.Harness, &h.Project, &h.Path, &h.Line, &h.Timestamp, &h.Role, &h.Score, &h.Snippet); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}
