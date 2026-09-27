package cmd

import (
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
	strict bool     // a command line (indented, Example, or quoted), not prose
}

func walkCommands(c *cobra.Command, visit func(*cobra.Command)) {
	visit(c)
	for _, sub := range c.Commands() {
		walkCommands(sub, visit)
	}
}

// helpTokens splits a command segment shell-style: quoted strings are one
// token. It stops at a comment, a pipe, or a command separator.
func helpTokens(s string) []string {
	var tokens []string
	var cur strings.Builder
	inToken := false
	var quote rune
	flush := func() {
		if inToken {
			tokens = append(tokens, cur.String())
		}
		cur.Reset()
		inToken = false
	}
	for _, r := range s {
		switch {
		case quote != 0:
			cur.WriteRune(r)
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
			inToken = true
			cur.WriteRune(r)
		case r == ' ' || r == '\t':
			flush()
		default:
			inToken = true
			cur.WriteRune(r)
		}
	}
	flush()
	for i, tok := range tokens {
		if strings.HasPrefix(tok, "#") || tok == "|" || tok == "||" || tok == "&&" || tok == ";" {
			return tokens[:i]
		}
		if strings.HasSuffix(tok, ";") {
			return append(tokens[:i:i], strings.TrimSuffix(tok, ";"))
		}
	}
	return tokens
}

// commandLineArgs parses a line that is a felt command: everything after
// "felt" up to a comment, separator, or a run of two spaces that introduces
// an aligned description.
func commandLineArgs(trimmed string) []string {
	rest := strings.TrimPrefix(trimmed, "felt ")
	if i := strings.Index(rest, "  "); i >= 0 {
		rest = rest[:i]
	}
	return helpTokens(rest)
}

var quotedFeltSpan = regexp.MustCompile("(?:`felt ([^`]+)`)|(?:'felt ([^']+)')|(?:\"felt ([^\"]+)\")")

// proseArgs reads a bare "felt ..." mention in running text. The mention runs
// until a token carrying closing punctuation or a dash separator.
func proseArgs(after string) []string {
	var args []string
	for _, tok := range strings.Fields(after) {
		if tok == "—" || strings.HasPrefix(tok, "(") || strings.HasPrefix(tok, "#") {
			break
		}
		trimmed := strings.TrimRight(tok, ".,;:)")
		if trimmed != tok {
			if trimmed != "" {
				args = append(args, trimmed)
			}
			break
		}
		args = append(args, tok)
	}
	return args
}

// helpInvocations extracts every felt invocation from a command's help.
func helpInvocations(c *cobra.Command) []helpInvocation {
	var out []helpInvocation
	for _, line := range strings.Split(c.Example, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "felt ") {
			out = append(out, helpInvocation{line: trimmed, args: commandLineArgs(trimmed), strict: true})
		}
	}

	var prose []string
	scanProse := func(text string) {
		for _, m := range quotedFeltSpan.FindAllStringSubmatch(text, -1) {
			span := m[1] + m[2] + m[3]
			out = append(out, helpInvocation{line: "felt " + span, args: helpTokens(span), strict: true})
		}
		text = quotedFeltSpan.ReplaceAllString(text, " ")
		fields := strings.Fields(text)
		for i, f := range fields {
			if f == "felt" && i+1 < len(fields) {
				args := proseArgs(strings.Join(fields[i+1:], " "))
				if len(args) > 0 {
					out = append(out, helpInvocation{line: "felt " + strings.Join(args, " "), args: args})
				}
			}
		}
	}
	flushProse := func() {
		if len(prose) > 0 {
			scanProse(strings.Join(prose, " "))
			prose = nil
		}
	}
	for _, line := range strings.Split(c.Long, "\n") {
		trimmed := strings.TrimSpace(line)
		indented := trimmed != "" && trimmed != line && (line[0] == ' ' || line[0] == '\t')
		switch {
		case indented && strings.HasPrefix(trimmed, "felt "):
			flushProse()
			out = append(out, helpInvocation{line: trimmed, args: commandLineArgs(trimmed), strict: true})
		case indented:
			flushProse()
			scanProse(trimmed)
		case trimmed == "":
			flushProse()
		default:
			prose = append(prose, trimmed)
		}
	}
	flushProse()
	return out
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

func TestHelpCommandLinesResolve(t *testing.T) {
	walkCommands(rootCmd, func(owner *cobra.Command) {
		for _, inv := range helpInvocations(owner) {
			hasFlag := false
			for _, a := range inv.args {
				hasFlag = hasFlag || isFlagToken(a)
			}
			target, rest, err := rootCmd.Find(inv.args)
			if err != nil {
				// Running text such as "felt keeps fibers" names no verb; it
				// is only an invocation when it carries a flag.
				if inv.strict || hasFlag {
					t.Errorf("%q help: %q names no felt command: %v", owner.CommandPath(), inv.line, err)
				}
				continue
			}
			named := len(inv.args) > 0 && !isFlagToken(inv.args[0])
			if named && target == rootCmd {
				t.Errorf("%q help: %q names no felt command", owner.CommandPath(), inv.line)
				continue
			}
			if target.Deprecated != "" {
				t.Errorf("%q help: %q uses deprecated %q", owner.CommandPath(), inv.line, target.CommandPath())
			}
			if inv.strict && !target.Runnable() && target.HasSubCommands() {
				for _, a := range rest {
					if !isFlagToken(a) {
						t.Errorf("%q help: %q: %q has no subcommand %q", owner.CommandPath(), inv.line, target.CommandPath(), a)
						break
					}
				}
			}
			for _, flag := range unknownFlags(target, inv.args) {
				t.Errorf("%q help: %q: %q has no flag %s", owner.CommandPath(), inv.line, target.CommandPath(), flag)
			}
		}
	})
}

// The extractor itself must see what a reader sees; pin the shapes it has to
// handle so a quiet regression cannot turn the drift test into a no-op.
func TestHelpInvocationExtraction(t *testing.T) {
	c := &cobra.Command{
		Use: "probe",
		Long: `Prose mentions felt sync --push. Then felt keeps going,
and 'felt add launch/log' is quoted, as is ` + "`felt hook session`" + `.

  felt ls "query" --body -r         regex, including bodies
  felt show <id> -d summary # comment
  -t rule:        an indented flag line`,
		Example: `  felt edit analysis/covariance -o "done" | cat`,
	}
	var got []string
	for _, inv := range helpInvocations(c) {
		got = append(got, strings.Join(inv.args, " "))
	}
	want := []string{
		"edit analysis/covariance -o \"done\"",
		"add launch/log",
		"hook session",
		"sync --push",
		"keeps going",
		"ls \"query\" --body -r",
		"show <id> -d summary",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("extracted invocations:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}

	bad := unknownFlags(lsCmd, []string{"ls", "-rv", "-s", "all", "--body", "--json", "-C", "dir", "-q", "--bogus=1", "--", "--after"})
	if strings.Join(bad, " ") != "-q --bogus=1" {
		t.Fatalf("unknownFlags(ls) = %v, want [-q --bogus=1]", bad)
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
	for _, c := range rootCmd.Commands() {
		if c.Hidden || c.Name() == "completion" {
			continue
		}
		if c.GroupID == "" {
			t.Errorf("felt %s has no GroupID; it would fall into Additional Commands", c.Name())
		}
	}
}
