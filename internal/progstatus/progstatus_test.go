package progstatus

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEncodeProbeB2(t *testing.T) {
	r := Report{State: "blocked", Kind: "permission", App: "child", Msg: "child"}
	want := []byte("\x1b]7501;state=blocked:kind=permission:app=child:msg=Y2hpbGQ=\x1b\\")
	if got := r.Encode(); !bytes.Equal(got, want) {
		t.Fatalf("Encode() = %q, want probe B2 bytes %q", got, want)
	}
}

func TestWrapTmuxProbeB3(t *testing.T) {
	seq := Report{State: "working", App: "wrappedon"}.Encode()
	want := []byte("\x1bPtmux;\x1b\x1b]7501;state=working:app=wrappedon\x1b\x1b\\\x1b\\")
	if got := WrapTmux(seq); !bytes.Equal(got, want) {
		t.Fatalf("WrapTmux() = %q, want probe B3 bytes %q", got, want)
	}
	if !bytes.Equal(seq, []byte("\x1b]7501;state=working:app=wrappedon\x1b\\")) {
		t.Fatalf("WrapTmux mutated its input: %q", seq)
	}
}

func TestWrapTmuxEveryEscape(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"", "\x1bPtmux;\x1b\\"},
		{"a\x1bb\x1b\x1bc", "\x1bPtmux;a\x1b\x1bb\x1b\x1b\x1b\x1bc\x1b\\"},
	} {
		if got := WrapTmux([]byte(tc.input)); string(got) != tc.want {
			t.Errorf("WrapTmux(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestEncodeStatesAndKindGate(t *testing.T) {
	for _, state := range []string{"idle", "working", "done", "blocked", "error", "clear"} {
		for _, kind := range []string{"", "permission", "question", "auth", "unknown", "permission:app=spoof", "\x1b\\"} {
			t.Run(state+"/"+kind, func(t *testing.T) {
				want := "\x1b]7501;state=" + state
				if state == "blocked" && (kind == "permission" || kind == "question" || kind == "auth") {
					want += ":kind=" + kind
				}
				want += "\x1b\\"
				if got := (Report{State: state, Kind: kind}).Encode(); string(got) != want {
					t.Fatalf("Encode() = %q, want %q", got, want)
				}
			})
		}
	}
	for _, state := range []string{"", "unknown", "working:app=spoof", "working\x1b\\"} {
		if got := (Report{State: state}).Encode(); got != nil {
			t.Errorf("invalid state %q encoded as %q", state, got)
		}
	}
}

func TestEncodeAppGrammar(t *testing.T) {
	for _, tc := range []struct {
		app   string
		valid bool
	}{
		{"", false}, {"claude-code", true}, {"AZaz09_.+-", true},
		{strings.Repeat("a", 32), true}, {strings.Repeat("a", 33), false},
		{"a/b", false}, {"a:b", false}, {"a;b", false}, {"a=b", false},
		{"a b", false}, {"a\n", false}, {"\x1b\\", false}, {"é", false},
	} {
		want := "\x1b]7501;state=working"
		if tc.valid {
			want += ":app=" + tc.app
		}
		want += "\x1b\\"
		if got := (Report{State: "working", App: tc.app}).Encode(); string(got) != want {
			t.Errorf("app %q: got %q, want %q", tc.app, got, want)
		}
	}
}

func TestEncodeIDGrammar(t *testing.T) {
	maxID := strings.Repeat("a", 32) + "/" + strings.Repeat("b", 32) + "/" + strings.Repeat("c", 32) + "/" + strings.Repeat("d", 29)
	for _, tc := range []struct {
		id    string
		valid bool
	}{
		{"", false}, {"sub/a", true}, {"AZaz09_.+-", true},
		{strings.Repeat("a", 32), true}, {strings.Repeat("a", 33), false},
		{strings.TrimSuffix(strings.Repeat("a/", 8), "/"), true},
		{strings.TrimSuffix(strings.Repeat("a/", 9), "/"), false},
		{maxID, true}, {maxID + "a", false},
		{"/a", false}, {"a/", false}, {"a//b", false},
		{"a:b", false}, {"a;b", false}, {"a=b", false}, {"a b", false},
		{"a\n", false}, {"\x1b\\", false}, {"é", false},
	} {
		want := "\x1b]7501;state=working"
		if tc.valid {
			want += ":id=" + tc.id
		}
		want += "\x1b\\"
		if got := (Report{State: "working", ID: tc.id}).Encode(); string(got) != want {
			t.Errorf("id %q: got %q, want %q", tc.id, got, want)
		}
	}
}

func TestEncodeText(t *testing.T) {
	var controls, spaces strings.Builder
	for r := rune(0); r <= 0x9f; r++ {
		if r <= 0x1f || r >= 0x7f {
			controls.WriteRune(r)
			spaces.WriteByte(' ')
		}
	}
	for _, tc := range []struct{ input, want string }{
		{"a\n\t\x1b\x7f\u0085b", "a     b"},
		{controls.String(), spaces.String()},
		{"Question: yes; no? 🦉", "Question: yes; no? 🦉"},
		{"a\xffb", "a\ufffdb"},
	} {
		r := Report{State: "blocked", Title: tc.input, Msg: tc.input}
		pairs := reportPairs(t, r.Encode())
		for _, key := range []string{"title", "msg"} {
			encoded := pairs[key]
			if encoded != base64.StdEncoding.EncodeToString([]byte(tc.want)) {
				t.Errorf("%s = %q, want padded standard base64 of %q", key, encoded, tc.want)
			}
			decoded, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil || !utf8.Valid(decoded) || string(decoded) != tc.want {
				t.Errorf("%s decoded as %q, %v; want %q", key, decoded, err, tc.want)
			}
		}
	}
}

func TestEncodeTextLimits(t *testing.T) {
	for _, field := range []struct {
		key   string
		limit int
	}{{"msg", 128}, {"title", 192}} {
		for _, runeText := range []string{"x", "é", "界", "🦉"} {
			for _, prefix := range []string{"", "a", "ab", "abc"} {
				input := prefix + strings.Repeat(runeText, field.limit+1)
				wantLen := len(prefix) + (field.limit-len(prefix))/len(runeText)*len(runeText)
				want := input[:wantLen]
				r := Report{State: "working", Title: input, Msg: input}
				encoded := reportPairs(t, r.Encode())[field.key]
				decoded, err := base64.StdEncoding.DecodeString(encoded)
				if err != nil || !utf8.Valid(decoded) || string(decoded) != want {
					t.Fatalf("%s/%q/prefix %q: decoded %d bytes, %v; want %d rune-safe bytes", field.key, runeText, prefix, len(decoded), err, len(want))
				}
			}
		}
	}
	// Sanitizing precedes truncation: each two-byte C1 character becomes one space.
	input := strings.Repeat("\u0085", 2050)
	pairs := reportPairs(t, (Report{State: "working", Title: input, Msg: input}).Encode())
	for key, limit := range map[string]int{"title": 192, "msg": 128} {
		if pairs[key] != base64.StdEncoding.EncodeToString([]byte(strings.Repeat(" ", limit))) {
			t.Errorf("%s did not truncate the sanitized text at %d bytes", key, limit)
		}
	}
}

func TestEncodeWholeSequenceLimit(t *testing.T) {
	seq := (Report{
		State: "blocked", Kind: "permission", App: strings.Repeat("a", 32),
		ID:    strings.Repeat("a", 32) + "/" + strings.Repeat("b", 32) + "/" + strings.Repeat("c", 32) + "/" + strings.Repeat("d", 29),
		Title: strings.Repeat("t", 10000), Msg: strings.Repeat("m", 10000),
	}).Encode()
	if n := len(WrapTmux(seq)); n > 768 {
		t.Fatalf("wrapped report has %d bytes, limit 768", n)
	}
	pairs := reportPairs(t, seq)
	if len(pairs) != 6 || len(pairs["title"]) != 256 || len(pairs["msg"]) != 172 {
		t.Fatalf("unexpected maximal report: %v", pairs)
	}
}

func reportPairs(t *testing.T, seq []byte) map[string]string {
	t.Helper()
	s := string(seq)
	if !strings.HasPrefix(s, "\x1b]7501;") || !strings.HasSuffix(s, "\x1b\\") {
		t.Fatalf("not an OSC 7501 report: %q", seq)
	}
	pairs := map[string]string{}
	for _, pair := range strings.Split(s[len("\x1b]7501;"):len(s)-2], ":") {
		key, value, ok := strings.Cut(pair, "=")
		if !ok || key == "" {
			t.Fatalf("invalid pair %q", pair)
		}
		for _, c := range value {
			if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.,+/=-", c) {
				t.Fatalf("%s value contains non-protocol character %q", key, c)
			}
		}
		pairs[key] = value
	}
	return pairs
}
