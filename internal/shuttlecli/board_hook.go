package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

type boardCursor struct {
	At   int64    `json:"at"`
	Seen []string `json:"seen"`
}

// recordHumanPrompt verifies dispatch identity again under the document lock.
func (a *app) recordHumanPrompt(input eventHookInput) {
	if input.Prompt == "" || machinePrompt(input.Prompt) {
		return
	}
	path := a.env.Getenv("SHUTTLE_FIBER_PATH")
	if path == "" {
		return
	}
	f, err := a.workerFiberAtPath(path, "")
	if err != nil || shuttleRuntimeSessionID(f) != input.SessionID {
		return
	}
	st := felt.NewStorage(workerStoreRoot(f.Path))
	f, unlock, err := lockAndReloadFiber(st, f)
	if err != nil {
		return
	}
	defer unlock()
	if shuttleRuntimeSessionID(f) != input.SessionID {
		return
	}
	r := boardRecord{Kind: "human", Fiber: f.UID, By: &boardParty{Label: a.humanLabel()}, Text: input.Prompt}
	block, ok, err := shuttle.BlockOf(f)
	if err == nil && ok && block.Ask != nil && a.ensureOwnedHere(f, f.ID) == nil {
		question := block.Ask.Text
		if err := shuttle.SetNodeField(f, "ask", nil); err != nil {
			return
		}
		if err := st.Write(f); err != nil {
			fmt.Fprintf(a.env.Stderr, "warning: could not clear question: %v\n", err)
			return
		}
		r.Kind = "answered"
		r.Text = "Q: " + question + " — A: " + input.Prompt
	}
	a.recordBoard(r)
}

// humanLabel names the person typing in a worker's chat: SHUTTLE_HUMAN, else
// the first word of Git's user.name, else "human".
func (a *app) humanLabel() string {
	if name := strings.TrimSpace(a.env.Getenv("SHUTTLE_HUMAN")); name != "" {
		return name
	}
	if out, err := a.env.Command("git", "config", "--global", "user.name").Output(); err == nil {
		if fields := strings.Fields(string(out)); len(fields) > 0 {
			return fields[0]
		}
	}
	return "human"
}

func boardDigestLine(r boardRow) string {
	line := "· " + time.UnixMilli(r.Timestamp).Local().Format("15:04") + " " + boardPhrase(r)
	if r.Text != "" {
		line += ": " + strconv.Quote(boardSingleLine(r.Text))
	}
	runes := []rune(line)
	if len(runes) > 200 {
		line = string(runes[:199]) + "…"
	}
	return line
}

const boardDigestLines = 6

func (a *app) boardDigest(harness, session string) string {
	// Native ids are file names, not paths.
	if session == "" || filepath.Base(session) != session || session == "." || session == ".." {
		return ""
	}
	dir, err := shuttle.DataDir(a.env)
	if err != nil {
		return ""
	}
	path := filepath.Join(dir, "board-cursors", harness+"-"+session+".json")
	var cursor boardCursor
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &cursor)
	}
	now := a.eventNow().UnixMilli()
	since := now - int64((6*time.Hour)/time.Millisecond)
	if cursor.At > 0 {
		since = cursor.At - int64((10*time.Minute)/time.Millisecond)
	}
	endpoint, err := a.daemonEndpoint("/api/v1/board/family")
	if err != nil {
		return ""
	}
	q := url.Values{"session": {harness + ":" + session}, "since_ms": {strconv.FormatInt(since, 10)}}
	body, err := a.getDaemon(endpoint+"?"+q.Encode(), 1500*time.Millisecond)
	if err != nil {
		return ""
	}
	var response boardResponse
	if json.Unmarshal(body, &response) != nil {
		return ""
	}
	seen := make(map[string]bool, len(cursor.Seen))
	for _, id := range cursor.Seen {
		seen[id] = true
	}
	var fresh []boardRow
	next := boardCursor{At: now, Seen: []string{}}
	nextSeen := map[string]bool{}
	for _, r := range response.Records {
		if r.ID == "" {
			continue
		}
		if !seen[r.ID] && !r.Delivered {
			fresh = append(fresh, r)
		}
		seen[r.ID] = true
		if r.Timestamp >= now-int64((10*time.Minute)/time.Millisecond) && !nextSeen[r.ID] {
			next.Seen = append(next.Seen, r.ID)
			nextSeen[r.ID] = true
		}
	}
	if os.MkdirAll(filepath.Dir(path), 0700) == nil {
		if b, err := json.Marshal(next); err == nil {
			_ = atomicfile.Write(path, b, 0600)
		}
	}
	if len(fresh) == 0 {
		return ""
	}
	label := ""
	if response.Family != nil {
		label = response.Family.Label
	}
	var out strings.Builder
	fmt.Fprintf(&out, "Family board (%s), new since your last turn:\n", label)
	// The newest lines carry the current state; older ones are one command away.
	if len(fresh) > boardDigestLines {
		fmt.Fprintf(&out, "+%d earlier: shuttle board\n", len(fresh)-boardDigestLines)
		fresh = fresh[len(fresh)-boardDigestLines:]
	}
	for _, r := range fresh {
		out.WriteString(boardDigestLine(r))
		out.WriteByte('\n')
	}
	return strings.TrimSuffix(out.String(), "\n")
}
