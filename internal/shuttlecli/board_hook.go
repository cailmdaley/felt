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
	r := boardRecord{Kind: "human", Fiber: f.UID, By: &boardParty{Label: "human"}, Text: input.Prompt}
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

func boardDigestLine(r boardRow) string {
	line := "· " + time.UnixMilli(r.Timestamp).Local().Format("15:04") + " " + boardPhrase(r)
	if r.Text != "" && r.Kind != "closed" && r.Kind != "rested" && r.Kind != "handed_off" && r.Kind != "unblocked" {
		line += ": " + strconv.Quote(strings.Join(strings.Fields(r.Text), " "))
	}
	runes := []rune(line)
	if len(runes) > 200 {
		line = string(runes[:199]) + "…"
	}
	return line
}

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
	for i, r := range fresh {
		if i == 6 {
			break
		}
		out.WriteString(boardDigestLine(r))
		out.WriteByte('\n')
	}
	if len(fresh) > 6 {
		fmt.Fprintf(&out, "+%d more: shuttle board\n", len(fresh)-6)
	}
	return strings.TrimSuffix(out.String(), "\n")
}
