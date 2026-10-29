package shuttlecli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestBoardRecordFixture(t *testing.T) {
	env, sink, _ := sendFileTestEnv(t)
	a := newApp(env)
	a.eventNow = func() time.Time { return time.UnixMilli(1793300000000) }
	entropy := make([]byte, 100)
	for i := range entropy {
		entropy[i] = byte(i)
	}
	a.boardEntropy = bytes.NewReader(entropy)
	for _, kind := range []string{"message", "post", "human", "asked", "answered", "cleared", "closed", "handed_off", "rested", "unblocked"} {
		record := boardRecord{Kind: kind, By: &boardParty{Fiber: "actor", Session: "shuttle://test-host/pi/session", Label: "worker"}, Fiber: "member", Text: "hello"}
		if kind == "message" {
			record.To = &boardParty{Fiber: "member", Session: "shuttle://test-host/pi/target"}
			record.Wake = true
		}
		if kind == "closed" {
			record.Verdict = "tempered"
		}
		if err := a.appendBoard(record); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(sink)
	if err != nil {
		t.Fatal(err)
	}
	fixture := filepath.Join("..", "..", "daemon", "test", "fixtures", "board", "records.jsonl")
	if os.Getenv("UPDATE_BOARD_FIXTURE") == "1" {
		if err := os.MkdirAll(filepath.Dir(fixture), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixture, got, 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("board fixture differs\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestBoardReadsDaemon(t *testing.T) {
	env, _, _ := sendFileTestEnv(t)
	const raw = `{"family":{"root_uid":"root","root_id":"work","name":"Work","label":"work"},"viewer":"member","records":[{"id":"brd-test","type":"board","timestamp":1793300000000,"kind":"post","fiber":"member","member":"work/member","actor":"member","delivered":false,"text":"hello","future_field":42}],"future":true}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/board/family" || r.URL.Query().Get("fiber") != "worker" {
			t.Errorf("unexpected request %s", r.URL)
		}
		_, _ = w.Write([]byte(raw))
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	out, _, err := executeIn(t, env, "", "board", "worker")
	if err != nil || !strings.Contains(out, "work/member posted: hello") {
		t.Fatalf("board output %q: %v", out, err)
	}
	out, _, err = executeIn(t, env, "", "board", "worker", "--json")
	if err != nil || out != raw {
		t.Fatalf("board JSON %q: %v", out, err)
	}
}

func TestBoardText(t *testing.T) {
	if got := boardSingleLine("a  b\r\nc\td"); got != "a  b c\td" {
		t.Fatalf("collapsed text: %q", got)
	}
	got := boardText(strings.Repeat("é", 1100))
	if len(got) > 2000 || !utf8.ValidString(got) || !strings.HasSuffix(got, "…") {
		t.Fatalf("invalid trimmed text: %q", got)
	}
}
