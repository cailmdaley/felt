package feltcli

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// Help text is the reference agents work from, so every felt invocation it
// shows must name a real command and real flags. These tests walk the whole
// command tree and hold each Long and Example to that.

// helpInvocation is one felt command line found in a command's help.
type helpInvocation struct {
	line   string   // the text as found, for the failure message
	args   []string // tokens after "felt"
	strict bool     // a command line (indented, Example, or code), not prose
	notes  []string // text describing this line (aligned column, comment): its bare flags are this command's
}

// helpScan is what one help text shows: the felt invocations in it, and the
// text outside them, whose bare flags belong to the command the text is for.
type helpScan struct {
	invocations []helpInvocation
	residual    []string
}

func walkCommands(c *cobra.Command, visit func(*cobra.Command)) {
	visit(c)
	for _, sub := range c.Commands() {
		walkCommands(sub, visit)
	}
}

// helpTokens splits a command segment shell-style: quoted strings are one
// token. It stops at a comment, a redirection, a pipe, or a command separator
// and returns the text from there on.
func helpTokens(s string) (tokens []string, tail string) {
	var starts []int
	var cur strings.Builder
	start := -1
	var quote rune
	flush := func() {
		if start >= 0 {
			tokens = append(tokens, cur.String())
			starts = append(starts, start)
		}
		cur.Reset()
		start = -1
	}
	for i, r := range s {
		switch {
		case quote != 0:
			cur.WriteRune(r)
			if r == quote {
				quote = 0
			}
		case r == ' ' || r == '\t':
			flush()
		default:
			if r == '"' || r == '\'' {
				quote = r
			}
			if start < 0 {
				start = i
			}
			cur.WriteRune(r)
		}
	}
	flush()
	for i, tok := range tokens {
		switch {
		// "<" alone is a redirection; <id> is a placeholder.
		case strings.HasPrefix(tok, "#"), strings.HasPrefix(tok, ">"), strings.HasPrefix(tok, "2>"),
			tok == "<", tok == "|", tok == "||", tok == "&&", tok == ";":
			return tokens[:i], s[starts[i]:]
		}
		if strings.HasSuffix(tok, ";") {
			return append(tokens[:i:i], strings.TrimSuffix(tok, ";")), s[starts[i]+len(tok):]
		}
	}
	return tokens, ""
}

// addCommandLine records a felt command line. What follows its arguments is
// either a comment, which describes it, or shell, whose flags belong to other
// programs but which may run felt again.
func (s *helpScan) addCommandLine(inv helpInvocation, tail string) {
	tail = strings.TrimSpace(tail)
	if strings.HasPrefix(tail, "#") {
		inv.notes = append(inv.notes, tail)
		tail = ""
	}
	s.invocations = append(s.invocations, inv)
	if tail != "" {
		s.invocations = append(s.invocations, scanProse(tail).invocations...)
	}
}

// addLine records a line that is a felt command: everything after "felt" up
// to a comment, a separator, or a run of two spaces that introduces an
// aligned description.
func (s *helpScan) addLine(trimmed string) {
	rest := strings.TrimPrefix(trimmed, "felt ")
	command, desc, aligned := strings.Cut(rest, "  ")
	args, tail := helpTokens(command)
	inv := helpInvocation{line: trimmed, args: args, strict: true}
	if aligned {
		inv.notes = append(inv.notes, strings.TrimSpace(desc))
	}
	s.addCommandLine(inv, tail)
}

var quotedFeltSpan = regexp.MustCompile("(?:`felt ([^`]+)`)|(?:'felt ([^']+)')|(?:\"felt ([^\"]+)\")")

// proseArgs reads a bare "felt ..." mention in running text. The mention runs
// until a token carrying closing punctuation or a dash separator; a mention
// opened by a backtick is code.
func proseArgs(fields []string) (args []string, consumed int, code bool) {
	for i, tok := range fields {
		if i == 0 && strings.HasPrefix(tok, "`") {
			code = true
			tok = tok[1:]
		}
		if tok == "—" || strings.HasPrefix(tok, "(") || strings.HasPrefix(tok, "#") {
			return args, i, code
		}
		trimmed := strings.TrimRight(tok, ".,;:)`")
		if trimmed != tok {
			if trimmed != "" {
				args = append(args, trimmed)
			}
			return args, i + 1, code
		}
		args = append(args, tok)
	}
	return args, len(fields), code
}

// scanProse reads running text: quoted felt command lines, bare felt
// mentions, and the text around them.
func scanProse(text string) helpScan {
	var s helpScan
	for _, m := range quotedFeltSpan.FindAllStringSubmatch(text, -1) {
		span := m[1] + m[2] + m[3]
		args, tail := helpTokens(span)
		s.addCommandLine(helpInvocation{line: "felt " + span, args: args, strict: true}, tail)
	}
	fields := strings.Fields(quotedFeltSpan.ReplaceAllString(text, " "))
	var rest []string
	for i := 0; i < len(fields); i++ {
		if strings.TrimLeft(fields[i], "(") == "felt" {
			args, n, code := proseArgs(fields[i+1:])
			if len(args) > 0 {
				s.invocations = append(s.invocations, helpInvocation{line: "felt " + strings.Join(args, " "), args: args, strict: code})
				i += n
				continue
			}
		}
		rest = append(rest, fields[i])
	}
	if len(rest) > 0 {
		s.residual = append(s.residual, strings.Join(rest, " "))
	}
	return s
}

func (s *helpScan) merge(o helpScan) {
	s.invocations = append(s.invocations, o.invocations...)
	s.residual = append(s.residual, o.residual...)
}

// scanHelp reads a command's Long and Example. Indented lines that start
// with felt are command lines; other indented lines stand alone; unindented
// lines join into paragraphs of prose.
func scanHelp(long, example string) helpScan {
	var s helpScan
	for _, line := range strings.Split(example, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "felt ") {
			s.addLine(trimmed)
		} else if trimmed != "" {
			s.merge(scanProse(trimmed))
		}
	}

	var prose []string
	flushProse := func() {
		if len(prose) > 0 {
			s.merge(scanProse(strings.Join(prose, " ")))
			prose = nil
		}
	}
	for _, line := range strings.Split(long, "\n") {
		trimmed := strings.TrimSpace(line)
		indented := trimmed != "" && trimmed != line && (line[0] == ' ' || line[0] == '\t')
		switch {
		case indented && strings.HasPrefix(trimmed, "felt "):
			flushProse()
			s.addLine(trimmed)
		case indented:
			flushProse()
			s.merge(scanProse(trimmed))
		case trimmed == "":
			flushProse()
		default:
			prose = append(prose, trimmed)
		}
	}
	flushProse()
	return s
}

var bareFlagPattern = regexp.MustCompile(`^(?:--[a-z][a-z0-9-]*|-[A-Za-z][A-Za-z0-9]*)$`)

// bareFlags returns the flag tokens in running text, each stripped of
// surrounding punctuation and of a =value, with -L/--depth read as two.
func bareFlags(text string) []string {
	var flags []string
	for _, field := range strings.Fields(text) {
		for _, part := range strings.FieldsFunc(field, func(r rune) bool { return r == '/' || r == '|' }) {
			part = strings.Trim(part, "`'\"()[]{},.;:!?")
			name, _, _ := strings.Cut(part, "=")
			if bareFlagPattern.MatchString(name) {
				flags = append(flags, name)
			}
		}
	}
	return flags
}

func isFlagToken(tok string) bool {
	return len(tok) > 1 && tok[0] == '-' && tok != "--" && !strings.HasPrefix(tok, "---")
}

func lookupFlag(c *cobra.Command, name string) *pflag.Flag {
	if f := c.Flags().Lookup(name); f != nil {
		return f
	}
	return c.InheritedFlags().Lookup(name)
}

func lookupShorthand(c *cobra.Command, short string) *pflag.Flag {
	if f := c.Flags().ShorthandLookup(short); f != nil {
		return f
	}
	return c.InheritedFlags().ShorthandLookup(short)
}

// unknownFlags reports each flag token in args the command does not define.
func unknownFlags(c *cobra.Command, args []string) []string {
	var bad []string
	for _, tok := range args {
		if tok == "--" {
			break
		}
		if !isFlagToken(tok) {
			continue
		}
		if strings.HasPrefix(tok, "--") {
			name, _, _ := strings.Cut(tok[2:], "=")
			if name != "help" && lookupFlag(c, name) == nil {
				bad = append(bad, tok)
			}
			continue
		}
		// A shorthand cluster: booleans may combine, and a value-taking flag
		// consumes the rest of the token.
		short, _, _ := strings.Cut(tok[1:], "=")
		for _, r := range short {
			if r == 'h' {
				continue
			}
			f := lookupShorthand(c, string(r))
			if f == nil {
				bad = append(bad, tok)
				break
			}
			if f.NoOptDefVal == "" {
				break
			}
		}
	}
	return bad
}

// initDefaultCommands adds the help and completion commands Execute would add,
// so the tests see the tree a user does whatever ran before them.
func initDefaultCommands() {
	rootCmd.InitDefaultHelpCmd()
	rootCmd.InitDefaultCompletionCmd()
}

// helpReporter is where help checks report: a *testing.T, or a recorder that
// proves a check fires.
type helpReporter interface {
	Helper()
	Errorf(format string, args ...any)
}

type helpRecorder struct{ errors []string }

func (r *helpRecorder) Helper() {}
func (r *helpRecorder) Errorf(format string, args ...any) {
	r.errors = append(r.errors, fmt.Sprintf(format, args...))
}

// resolveInvocation finds the command a help invocation names, reporting
// each way it fails to be a real felt command line. It returns nil when the
// invocation names no command.
func resolveInvocation(t helpReporter, where string, inv helpInvocation) *cobra.Command {
	t.Helper()
	hasFlag := false
	for _, a := range inv.args {
		hasFlag = hasFlag || isFlagToken(a)
	}
	// Running text such as "felt keeps fibers" names no verb; it is an
	// invocation when it is code or carries a flag.
	strict := inv.strict || hasFlag
	target, rest, err := rootCmd.Find(inv.args)
	if err != nil {
		if strict {
			t.Errorf("%s: %q names no felt command: %v", where, inv.line, err)
		}
		return nil
	}
	named := len(inv.args) > 0 && !isFlagToken(inv.args[0])
	if named && target == rootCmd {
		t.Errorf("%s: %q names no felt command", where, inv.line)
		return nil
	}
	if target.Deprecated != "" {
		t.Errorf("%s: %q uses deprecated %q", where, inv.line, target.CommandPath())
	}
	if strict && !target.Runnable() && target.HasSubCommands() {
		for _, a := range rest {
			if !isFlagToken(a) {
				t.Errorf("%s: %q: %q has no subcommand %q", where, inv.line, target.CommandPath(), a)
				break
			}
		}
	}
	for _, flag := range unknownFlags(target, inv.args) {
		t.Errorf("%s: %q: %q has no flag %s", where, inv.line, target.CommandPath(), flag)
	}
	return target
}

// checkHelpScan holds a help text to the command tree: each invocation to
// the command it names, each description to the command it describes, and
// every other bare flag to target, the command the text is for.
func checkHelpScan(t helpReporter, where string, target *cobra.Command, scan helpScan) {
	t.Helper()
	for _, inv := range scan.invocations {
		named := resolveInvocation(t, where, inv)
		if named == nil {
			continue
		}
		for _, note := range inv.notes {
			checkHelpScan(t, where, named, scanProse(note))
		}
	}
	for _, text := range scan.residual {
		for _, flag := range unknownFlags(target, bareFlags(text)) {
			t.Errorf("%s: %q has no flag %s, in: %s", where, target.CommandPath(), flag, flagContext(text, flag))
		}
	}
}

// flagContext is the stretch of text around a flag, for a failure message.
func flagContext(text, flag string) string {
	i := strings.Index(text, flag)
	if i < 0 {
		return text
	}
	lo, hi := max(0, i-40), min(len(text), i+len(flag)+40)
	return "…" + text[lo:hi] + "…"
}

// cobraGenerated reports a command cobra adds on its own: help, and the
// completion tree.
func cobraGenerated(c *cobra.Command) bool {
	for ; c != nil && c != rootCmd; c = c.Parent() {
		if c.Parent() == rootCmd && (c.Name() == "help" || c.Name() == "completion") {
			return true
		}
	}
	return false
}

func TestHelpCommandLinesResolve(t *testing.T) {
	initDefaultCommands()
	walkCommands(rootCmd, func(c *cobra.Command) {
		scan := scanHelp(c.Long, c.Example)
		if cobraGenerated(c) {
			// cobra writes this help; its bare flags are the shell's.
			scan.residual = nil
		}
		checkHelpScan(t, fmt.Sprintf("%q help", c.CommandPath()), c, scan)
		c.LocalFlags().VisitAll(func(f *pflag.Flag) {
			checkHelpScan(t, fmt.Sprintf("%q --%s usage", c.CommandPath(), f.Name), c, scanProse(f.Usage))
		})
	})
}

// The extractor itself must see what a reader sees; pin the shapes it has to
// handle so a quiet regression cannot turn the drift test into a no-op.
func TestHelpInvocationExtraction(t *testing.T) {
	long := `Prose mentions felt sync --push. Then felt keeps going,
and 'felt add launch/log' is quoted, as is ` + "`felt hook session`" + `.
Code opens felt ` + "`ls -j`" + ` and prose closes felt nonsense --all.
An aside (felt tree -L 2) ends at its parenthesis.
Loose flags: -s "" or -L/--depth 2, key=value, outcome: |-, a -- b, 3 -1 — non-empty.
Pipes: ` + "`felt ls | head -5`" + ` and ` + "`felt sync && felt ls -r`" + `.

  felt ls "query" --body -r         regex, including bodies (--unset key)
  felt show <id> -d summary # comment -x
  felt completion zsh > "$(brew --prefix)/_felt"
  -t rule:        an indented flag line`
	example := `  felt edit analysis/covariance -o "done" | cat
  # -q in a comment`
	scan := scanHelp(long, example)
	var got []string
	for _, inv := range scan.invocations {
		line := strings.Join(inv.args, " ")
		if inv.strict {
			line += " [strict]"
		}
		for _, note := range inv.notes {
			line += " {" + note + "}"
		}
		got = append(got, line)
	}
	want := []string{
		`edit analysis/covariance -o "done" [strict]`,
		`add launch/log [strict]`,
		`hook session [strict]`,
		`ls [strict]`,
		`sync [strict]`,
		`ls -r`,
		`sync --push`,
		`keeps going`,
		`ls -j [strict]`,
		`nonsense --all`,
		`tree -L 2`,
		`ls "query" --body -r [strict] {regex, including bodies (--unset key)}`,
		`show <id> -d summary [strict] {# comment -x}`,
		`completion zsh [strict]`,
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("extracted invocations:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}

	var flags []string
	for _, text := range scan.residual {
		flags = append(flags, bareFlags(text)...)
	}
	if got, want := strings.Join(flags, " "), "-q -s -L --depth -t"; got != want {
		t.Fatalf("bare flags outside invocations = %q, want %q", got, want)
	}

	bad := unknownFlags(lsCmd, []string{"ls", "-rv", "-s", "all", "--body", "--json", "-C", "dir", "-q", "--bogus=1", "--", "--after"})
	if strings.Join(bad, " ") != "-q --bogus=1" {
		t.Fatalf("unknownFlags(ls) = %v, want [-q --bogus=1]", bad)
	}
}

// A misspelled flag or verb must fail wherever help can hold one.
func TestHelpDriftIsCaught(t *testing.T) {
	initDefaultCommands()
	cases := []struct {
		name  string
		owner *cobra.Command
		scan  helpScan
		want  string
	}{
		{"bare flag in Long", addCmd, scanHelp("--toplevel skips the view.", ""), "--toplevel"},
		{"flag in an aligned description", rootCmd, scanHelp("  felt edit <id> --set key=value    a scalar field (--unsett key)", ""), "--unsett"},
		{"verb in a flag usage", rootCmd, scanProse("park it; 'felt setup resum' arms it again"), `subcommand "resum"`},
		{"subcommand in prose before a flag", rootCmd, scanProse("see felt setup bogus --json for more"), `subcommand "bogus"`},
		{"verb in a code span after felt", rootCmd, scanProse("run felt `bogus` first"), "names no felt command"},
		{"flag in a comment", lsCmd, scanHelp("", "  felt ls  # -q is quiet"), "no flag -q"},
	}
	for _, tc := range cases {
		var probe helpRecorder
		checkHelpScan(&probe, tc.name, tc.owner, tc.scan)
		if !strings.Contains(strings.Join(probe.errors, "\n"), tc.want) {
			t.Errorf("%s: want an error naming %q, got %q", tc.name, tc.want, probe.errors)
		}
	}
}

// rootHelpOmits names the visible top-level verbs the root page deliberately
// leaves out, each with the reason an agent does not need it there.
var rootHelpOmits = map[string]string{
	"rm":           "destructive and rare; named in the views paragraph",
	"unnest":       "the inverse of nest, found from nest's help",
	"init":         "one-time store creation",
	"migrate":      "one-time layout conversion",
	"backfill-ids": "one-time identity plumbing for a store's owner",
	"setup":        "installation",
	"update":       "installation",
	"uninstall":    "installation",
	"hook":         "harness plumbing invoked by plugin hooks",
}

func TestRootHelpCoversEveryVerb(t *testing.T) {
	mentioned := map[string]bool{}
	for _, m := range regexp.MustCompile(`felt ([a-z][a-z-]*)`).FindAllStringSubmatch(rootLong, -1) {
		mentioned[m[1]] = true
	}
	for _, c := range rootCmd.Commands() {
		if c.Hidden || c.Name() == "help" || c.Name() == "completion" {
			continue
		}
		_, omitted := rootHelpOmits[c.Name()]
		switch {
		case mentioned[c.Name()] && omitted:
			t.Errorf("felt %s is in rootLong and in rootHelpOmits; drop the omission", c.Name())
		case !mentioned[c.Name()] && !omitted:
			t.Errorf("felt %s is not mentioned in rootLong; show it there or add it to rootHelpOmits with a reason", c.Name())
		}
	}
	for name := range rootHelpOmits {
		if c, _, err := rootCmd.Find([]string{name}); err != nil || c == rootCmd {
			t.Errorf("rootHelpOmits names %q, which is not a felt command", name)
		}
	}
}

func TestEveryTopLevelCommandIsGrouped(t *testing.T) {
	initDefaultCommands()
	for _, c := range rootCmd.Commands() {
		if c.Hidden || c.Name() == "completion" {
			continue
		}
		if c.GroupID == "" {
			t.Errorf("felt %s has no GroupID; it would fall into Additional Commands", c.Name())
		}
	}
}
