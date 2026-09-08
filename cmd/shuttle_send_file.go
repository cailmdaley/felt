package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

var shuttleSendFileCmd = &cobra.Command{
	Use:   "send-file <path> [path...]",
	Short: "Publish local artifacts to Shuttle's sent-files surface",
	Long: `Record an explicit file delivery on this host. Files remain on their owning
host and Shuttle serves them through its existing owner-routed file surface.
All paths must be readable regular files; validation completes before recording.

Session attribution uses --session, CODEX_THREAD_ID, CLAUDE_SESSION_ID, or
this tmux session's latest local session-ledger entry. A Shuttle worker's tmux
name also associates the delivery with its fiber. Outside a harness, supply
--session explicitly. Recording works while the daemon is offline; it does not
acknowledge that a client has downloaded the file.`,
	Args: cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		session, _ := cmd.Flags().GetString("session")
		files, err := sendFiles(args, session)
		if err != nil {
			return err
		}
		for _, path := range files {
			fmt.Fprintln(cmd.OutOrStdout(), "Recorded file:", path)
		}
		return nil
	},
}

func init() {
	shuttleSendFileCmd.Flags().String("session", "", "Native session ID (otherwise detected from environment or tmux ledger)")
	shuttleCmd.AddCommand(shuttleSendFileCmd)
}

func sendFiles(paths []string, session string) ([]string, error) {
	files := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			return nil, fmt.Errorf("empty file path")
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(abs)
		if err != nil {
			return nil, fmt.Errorf("stat artifact: %w", err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("artifact is not a regular file: %s", abs)
		}
		f, err := os.Open(abs)
		if err != nil {
			return nil, fmt.Errorf("read artifact: %w", err)
		}
		info, statErr := f.Stat()
		f.Close()
		if statErr != nil {
			return nil, statErr
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("artifact is not a regular file: %s", abs)
		}
		if !seen[abs] {
			files = append(files, abs)
			seen[abs] = true
		}
	}
	tmux := currentTmuxSession()
	session = strings.TrimSpace(session)
	if session == "" {
		session = strings.TrimSpace(os.Getenv("CODEX_THREAD_ID"))
	}
	if session == "" {
		session = strings.TrimSpace(os.Getenv("CLAUDE_SESSION_ID"))
	}
	if session == "" {
		session = sendFileLedgerSession(tmux)
	}
	if session == "" {
		return nil, fmt.Errorf("no session identity; supply --session or run inside a harness session")
	}
	origin, err := resolveOwnHost("")
	if err != nil {
		return nil, err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	timestamp := eventNow().UnixMilli()
	event := struct {
		eventLine
		Files []string `json:"files"`
	}{eventLine: eventLine{
		ID:        session + "-" + strconv.FormatInt(timestamp, 10) + "-" + strconv.Itoa(eventRand()),
		Timestamp: timestamp, Type: "file_sent", SessionID: session,
		CWD: cwd, TmuxSession: tmux, OriginName: origin,
	}, Files: files}
	line, err := encodeJSONLine(event)
	if err != nil {
		return nil, err
	}
	if len(line) > eventMaxLineBytes {
		return nil, fmt.Errorf("delivery exceeds %d bytes; send fewer files at once", eventMaxLineBytes)
	}
	sink, enabled := eventsSink()
	if !enabled {
		return nil, fmt.Errorf("Shuttle event recording is disabled or its state directory is missing")
	}
	if err := appendEventLine(sink, line); err != nil {
		return nil, fmt.Errorf("record delivery: %w", err)
	}
	return files, nil
}

// Use only this host's actual tmux association; cwd is not session identity.
func sendFileLedgerSession(tmux string) string {
	if tmux == "" {
		return ""
	}
	path, _ := shuttleStatePath("SHUTTLE_SESSIONS_FILE", "sessions.jsonl")
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	session := ""
	for scanner.Scan() {
		var row SessionProvenance
		if json.Unmarshal(scanner.Bytes(), &row) == nil && row.Tmux == tmux && row.Session != "" {
			session = row.Session
		}
	}
	return session
}
