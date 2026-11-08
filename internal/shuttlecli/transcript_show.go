package shuttlecli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cailmdaley/felt/internal/transcriptindex"
	"github.com/spf13/cobra"
)

// A transcript address names a place in a local session transcript:
// <session>[/<agent>][:<line>]. The session is an id or a unique prefix of at
// least eight characters, the agent a subagent's key (transcriptindex.AgentKey),
// and the line the JSONL line of a message. shuttle find prints one per
// session hit; shuttle show opens it.
var transcriptAddressPattern = regexp.MustCompile(`^([0-9a-f][0-9a-f-]{7,35})(?:/([0-9a-z]{1,16}))?(?::([0-9]+))?$`)

type transcriptAddress struct {
	Session, Agent string
	Line           int64
}

func parseTranscriptAddress(s string) (transcriptAddress, bool) {
	m := transcriptAddressPattern.FindStringSubmatch(s)
	if m == nil {
		return transcriptAddress{}, false
	}
	addr := transcriptAddress{Session: m[1], Agent: m[2]}
	if m[3] != "" {
		addr.Line, _ = strconv.ParseInt(m[3], 10, 64)
	}
	return addr, true
}

func (t transcriptAddress) String() string {
	s := shortSession(t.Session)
	if t.Agent != "" {
		s += "/" + t.Agent
	}
	if t.Line > 0 {
		s += ":" + strconv.FormatInt(t.Line, 10)
	}
	return s
}

func addressOf(path, session string, line int64) string {
	return transcriptAddress{Session: session, Agent: transcriptindex.AgentKey(path), Line: line}.String()
}

// sessionLabels names sessions for a reader: the fibers they worked on, from
// the daemon's session ledger, and the harness's own title.
type sessionLabels struct {
	a      *app
	idx    *transcriptindex.Index
	ledger *sessionLedgerResponse
	names  map[string]string
}

func (a *app) newSessionLabels(idx *transcriptindex.Index) (*sessionLabels, error) {
	ledger, err := a.fetchSessionLedger()
	return &sessionLabels{a: a, idx: idx, ledger: ledger, names: map[string]string{}}, err
}

func (l *sessionLabels) fibers(session string) []transcriptFiber {
	out := []transcriptFiber{}
	if l.ledger == nil {
		return out
	}
	seen := map[string]bool{}
	for _, row := range l.ledger.Records {
		if row.Session != session && row.ThreadID != session {
			continue
		}
		id := row.fiber()
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		name, ok := l.names[id]
		if !ok {
			name = filepath.Base(id)
			if f, e := l.a.shuttleAddressFiber(id); e == nil {
				name = f.Name
			}
			l.names[id] = name
		}
		out = append(out, transcriptFiber{ID: id, Name: name})
	}
	return out
}

// title is the session's own name: the title Claude gives a conversation, or,
// for a session that worked no fiber, the first line of its first user message.
func (l *sessionLabels) title(ctx context.Context, session string, hasFibers bool) string {
	main, err := l.idx.ResolveFile(ctx, session, "")
	if err != nil {
		return ""
	}
	if t := claudeTitle(main.Path); t != "" || hasFibers {
		return t
	}
	if m, err := l.idx.FirstMessage(ctx, main.Path, "user"); err == nil {
		return clip(firstLine(m.Text), 90)
	}
	return ""
}

// claudeTitle reads the last ai-title or custom-title record near the end of a
// Claude transcript, where Claude Code rewrites it as the conversation goes.
func claudeTitle(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	const tail = 1 << 20
	info, err := f.Stat()
	if err != nil {
		return ""
	}
	start := max(info.Size()-tail, 0)
	buf := make([]byte, info.Size()-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return ""
	}
	lines := bytes.Split(buf, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if !bytes.Contains(line, []byte(`"ai-title"`)) && !bytes.Contains(line, []byte(`"custom-title"`)) {
			continue
		}
		var rec struct {
			Type        string `json:"type"`
			AITitle     string `json:"aiTitle"`
			CustomTitle string `json:"customTitle"`
		}
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		if rec.Type == "custom-title" && rec.CustomTitle != "" {
			return rec.CustomTitle
		}
		if rec.Type == "ai-title" && rec.AITitle != "" {
			return rec.AITitle
		}
	}
	return ""
}

// subagentDescription is the description Claude Code records beside a
// subagent's transcript.
func subagentDescription(path string) string {
	if !transcriptindex.IsSubagentPath(path) {
		return ""
	}
	b, err := os.ReadFile(strings.TrimSuffix(path, ".jsonl") + ".meta.json")
	if err != nil {
		return ""
	}
	var meta struct {
		Description string `json:"description"`
		Name        string `json:"name"`
	}
	if json.Unmarshal(b, &meta) != nil {
		return ""
	}
	if meta.Description != "" {
		return meta.Description
	}
	return meta.Name
}

// transcriptView is `shuttle show <address>`: a stretch of one transcript.
type transcriptView struct {
	Address  string                    `json:"address"`
	Session  string                    `json:"session"`
	Harness  string                    `json:"harness"`
	Project  string                    `json:"project"`
	Path     string                    `json:"path"`
	Title    string                    `json:"title,omitempty"`
	Subagent string                    `json:"subagent,omitempty"`
	Fibers   []transcriptFiber         `json:"fibers"`
	Total    int                       `json:"total_messages"`
	Outline  bool                      `json:"outline,omitempty"`
	Messages []transcriptViewedMessage `json:"messages"`
	Earlier  string                    `json:"earlier,omitempty"`
	Later    string                    `json:"later,omitempty"`
	Errors   []string                  `json:"errors"`
}

type transcriptViewedMessage struct {
	transcriptindex.Message
	Hit bool `json:"hit,omitempty"`
	Gap bool `json:"gap,omitempty"`
}

// wrapShowForTranscripts wraps the fiber show command so that a transcript address
// opens that transcript instead. An argument that names a fiber is a fiber,
// except one carrying a :line, which only a transcript address has.
func (a *app) wrapShowForTranscripts(show *cobra.Command) *cobra.Command {
	var around int
	fiberRun := show.RunE
	show.Use = "show <fiber-id | session[/agent][:line]>"
	show.Short = "Show a fiber, or a stretch of a session transcript"
	show.Long += `

Given a transcript address as shuttle find prints it, <session>[/<agent>][:<line>],
show prints that stretch of the local session transcript: the matching message
in full, --around conversational messages on each side, and tool calls folded
to their names. Without a line it prints how the session opened and how it
ended. Each message's line is in the margin; show <session>:<line> recenters
there.`
	show.Example += `
  shuttle show 4d5bce8a:1093
  shuttle show f1d1a7c3/b75db097:651 --around 6`
	show.Flags().IntVar(&around, "around", 3, "transcripts: user and assistant messages to show on each side")
	show.RunE = func(cmd *cobra.Command, args []string) error {
		addr, ok := parseTranscriptAddress(args[0])
		if !ok {
			return fiberRun(cmd, args)
		}
		if addr.Line == 0 {
			if err := fiberRun(cmd, args); err == nil || !strings.HasPrefix(err.Error(), "no fiber found") {
				return err
			}
		}
		if around < 0 {
			return fmt.Errorf("--around must be non-negative")
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), time.Minute)
		defer cancel()
		view, err := a.viewTranscript(ctx, addr, around)
		if err != nil {
			return err
		}
		if a.json {
			return a.outputJSON(view)
		}
		for _, problem := range view.Errors {
			fmt.Fprintln(a.env.Stderr, "warning:", problem)
		}
		writeTranscriptView(a.env.Stdout, view)
		return nil
	}
	return show
}

func (a *app) viewTranscript(ctx context.Context, addr transcriptAddress, around int) (transcriptView, error) {
	var view transcriptView
	path, err := transcriptindex.DefaultPath(a.env)
	if err != nil {
		return view, err
	}
	idx, err := transcriptindex.Open(path)
	if err != nil {
		return view, err
	}
	defer idx.Close()
	file, err := idx.ResolveFile(ctx, addr.Session, addr.Agent)
	if err != nil {
		return view, err
	}
	messages, err := idx.Messages(ctx, file.Path)
	if err != nil {
		return view, err
	}
	if len(messages) == 0 {
		return view, fmt.Errorf("%s has no indexed messages", addr)
	}
	view = transcriptView{
		Address: addressOf(file.Path, file.Session, addr.Line), Session: file.Session, Harness: file.Harness,
		Project: file.Project, Path: file.Path, Subagent: subagentDescription(file.Path),
		Total: len(messages), Errors: []string{},
	}
	labels, ledgerErr := a.newSessionLabels(idx)
	if ledgerErr != nil {
		view.Errors = append(view.Errors, "session ledger unavailable: "+ledgerErr.Error())
	}
	view.Fibers = labels.fibers(file.Session)
	view.Title = labels.title(ctx, file.Session, len(view.Fibers) > 0)

	at := func(i int) string { return addressOf(file.Path, file.Session, messages[i].Line) }
	if addr.Line == 0 {
		// An outline: every turn the human (or a subagent's caller) took,
		// then the session's last word.
		view.Outline = true
		last := -1
		for i, m := range messages {
			if m.Role == "user" && !harnessInjected(m.Text) {
				view.Messages = append(view.Messages, transcriptViewedMessage{Message: m})
			}
			if m.Role == "assistant" {
				last = i
			}
		}
		if last >= 0 {
			view.Messages = append(view.Messages, transcriptViewedMessage{Message: messages[last]})
		}
		return view, nil
	}
	hit := 0
	for hit < len(messages)-1 && messages[hit].Line < addr.Line {
		hit++
	}
	lo, hi := conversationalSpan(messages, hit, around, around)
	view.Messages = viewed(messages[lo:hi+1], messages[hit].Line)
	if lo > 0 {
		view.Earlier = at(max(lo-1-countBack(messages, lo-1, around), 0))
	}
	if hi < len(messages)-1 {
		view.Later = at(min(hi+1+countForward(messages, hi+1, around), len(messages)-1))
	}
	return view, nil
}

// harnessInjected reports a user-role message the harness wrote rather than a
// person: skill bodies, command echoes, notifications.
func harnessInjected(text string) bool {
	for _, prefix := range []string{"Base directory for this skill", "<command-", "<local-command", "<task-notification", "<system-reminder", "Caveat:", "[Request interrupted"} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return false
}

func conversational(role string) bool { return role == "user" || role == "assistant" }

// conversationalSpan widens [i, i] until it holds `before` user/assistant
// messages before i and `after` after it, with any tool messages between.
func conversationalSpan(ms []transcriptindex.Message, i, before, after int) (int, int) {
	return i - countBack(ms, i, before), i + countForward(ms, i, after)
}

// countBack is how many messages before i hold n conversational ones.
func countBack(ms []transcriptindex.Message, i, n int) int {
	j := i
	for found := 0; j > 0 && found < n; {
		j--
		if conversational(ms[j].Role) {
			found++
		}
	}
	return i - j
}

func countForward(ms []transcriptindex.Message, i, n int) int {
	j := i
	for found := 0; j < len(ms)-1 && found < n; {
		j++
		if conversational(ms[j].Role) {
			found++
		}
	}
	return j - i
}

func viewed(ms []transcriptindex.Message, hitLine int64) []transcriptViewedMessage {
	out := make([]transcriptViewedMessage, len(ms))
	for i, m := range ms {
		out[i] = transcriptViewedMessage{Message: m, Hit: m.Line == hitLine}
	}
	return out
}

const (
	viewTextCap = 600
	viewHitCap  = 4000
)

func writeTranscriptView(w io.Writer, v transcriptView) {
	header := []string{v.Address}
	if len(v.Messages) == 0 {
		fmt.Fprintln(w, v.Address+" · no turns")
		return
	}
	if t := formatTranscriptTime(v.Messages[0].Timestamp); t != "" {
		header = append(header, t)
	}
	if v.Project != "" {
		header = append(header, filepath.Base(v.Project))
	}
	header = append(header, v.Harness)
	fmt.Fprintln(w, strings.Join(header, " · "))
	if label := sessionLabel(v.Fibers, v.Title); label != "" {
		fmt.Fprintln(w, label)
	}
	if v.Subagent != "" {
		fmt.Fprintln(w, "subagent: "+v.Subagent)
	}
	fmt.Fprintf(w, "%s  (%d messages)\n", v.Path, v.Total)
	if v.Earlier != "" {
		fmt.Fprintf(w, "\n      … earlier: shuttle show %s\n", v.Earlier)
	}
	fmt.Fprintln(w)
	if v.Outline {
		for _, m := range v.Messages {
			fmt.Fprintf(w, "%6d  %s: %s\n", m.Line, m.Role, clip(strings.Join(strings.Fields(m.Text), " "), 160))
		}
		fmt.Fprintf(w, "\n      open a turn: shuttle show %s:<line>\n", strings.SplitN(v.Address, ":", 2)[0])
		return
	}
	for i := 0; i < len(v.Messages); {
		m := v.Messages[i]
		if m.Gap {
			fmt.Fprintln(w, "      …")
		}
		if !conversational(m.Role) && !m.Hit {
			j := i
			var names []string
			for j < len(v.Messages) && !conversational(v.Messages[j].Role) && !v.Messages[j].Hit && (j == i || !v.Messages[j].Gap) {
				if v.Messages[j].Role == "tool_call" {
					names = append(names, toolName(v.Messages[j].Text))
				}
				j++
			}
			if len(names) > 0 {
				fmt.Fprintf(w, "%6d  ⚙ %s\n", m.Line, foldNames(names))
			}
			i = j
			continue
		}
		mark, limit := " ", viewTextCap
		if m.Hit {
			mark, limit = "▶", viewHitCap
		}
		text := m.Text
		if len(text) > limit {
			text = clip(text, limit) + fmt.Sprintf(" [+%d chars]", len(m.Text)-limit)
		}
		lines := strings.Split(strings.TrimSpace(text), "\n")
		fmt.Fprintf(w, "%s%5d  %s: %s\n", mark, m.Line, roleLabel(m.Role), lines[0])
		for _, l := range lines[1:] {
			fmt.Fprintf(w, "         %s\n", l)
		}
		i++
	}
	if v.Later != "" {
		fmt.Fprintf(w, "\n      … later: shuttle show %s\n", v.Later)
	}
}

func roleLabel(role string) string {
	switch role {
	case "tool_call":
		return "⚙ call"
	case "tool_result":
		return "⚙ result"
	}
	return role
}

func toolName(text string) string {
	if i := strings.IndexAny(text, " \n"); i > 0 {
		return text[:i]
	}
	return text
}

// foldNames writes a run of tool names with repeats counted: Read ×3, Bash.
func foldNames(names []string) string {
	var parts []string
	for i := 0; i < len(names); {
		j := i
		for j < len(names) && names[j] == names[i] {
			j++
		}
		if j-i > 1 {
			parts = append(parts, fmt.Sprintf("%s ×%d", names[i], j-i))
		} else {
			parts = append(parts, names[i])
		}
		i = j
	}
	return strings.Join(parts, ", ")
}

// sessionLabel is how a reader tells a session apart: its title, then the
// fibers it worked on by slug.
func sessionLabel(fibers []transcriptFiber, title string) string {
	var slugs []string
	seen := map[string]bool{}
	for _, f := range fibers {
		slug := filepath.Base(f.ID)
		if !seen[slug] {
			seen[slug] = true
			slugs = append(slugs, slug)
		}
	}
	if len(slugs) == 0 {
		return title
	}
	if title == "" {
		title = fibers[0].Name
	}
	return title + "  [" + strings.Join(slugs, ", ") + "]"
}

func formatTranscriptTime(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ""
	}
	return t.Local().Format("2006-01-02 15:04")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "…"
}
