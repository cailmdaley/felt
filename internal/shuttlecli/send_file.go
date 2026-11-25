package shuttlecli

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

func (a *app) shuttleSendFileCmd() *cobra.Command {
	shuttleSendFileCmd := &cobra.Command{
		Use:   "send-file <path> [path...]",
		Short: "Publish local artifacts to Shuttle's sent-files surface",
		Long: `Record an explicit file delivery on this host. Each file is copied into
the host's copy store (sent-files/ beside the event stream) by this process,
and the board opens it through the owner-routed file surface: from its
original path while the host's daemon can read it there, else from the copy,
so a file sent from a folder the daemon cannot read, or since deleted, still
opens. All paths must be readable regular files; nothing is recorded unless
every file was read. Files over 256 MiB are not copied, nor is any file of a
send that cannot hold the copy store's lock within 2 seconds; copies untouched
for 30 days are removed by a later send.

Session attribution uses --session; else the calling harness session (the
nearest harness among this process's ancestors that registered a receiver,
unless AI_AGENT=pi names Pi; else PI_SESSION_ID when AI_AGENT=pi; else the
first of ANTIGRAVITY_CONVERSATION_ID, CODEX_THREAD_ID, CLAUDE_CODE_SESSION_ID,
CLAUDE_SESSION_ID, PI_SESSION_ID); else this tmux session's latest local
session-ledger entry. A Shuttle worker's tmux
name also associates the delivery with its fiber. Outside a harness, supply
--session explicitly. --caption records why the files are sent; the board
shows it with them. Recording works while the daemon is offline; it does not
acknowledge that a client has downloaded the file.`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			session, _ := cmd.Flags().GetString("session")
			caption, _ := cmd.Flags().GetString("caption")
			files, err := a.sendFiles(args, session, caption)
			if err != nil {
				return err
			}
			for _, path := range files {
				fmt.Fprintln(a.env.Stdout, "Recorded file:", path)
			}
			return nil
		},
	}
	shuttleSendFileCmd.Flags().String("session", "", "Native session ID (otherwise detected from environment or tmux ledger)")
	shuttleSendFileCmd.Flags().String("caption", "", "Why these files are sent, shown with them")
	return shuttleSendFileCmd
}

func (a *app) wrapShowForFiles(show *cobra.Command) *cobra.Command {
	prevRun := show.RunE
	show.Use = "show <path [path...] | fiber-id | session[/agent][:line]>"
	show.Short = "Show local files on the thread page, a fiber, or a session transcript"
	show.Long += `

Given one or more local file paths (or --caption / --session), show records a
file_sent event with "show": true so the thread page displays the files as
pills and auto-advances when idle. It accepts the same --session and --caption
flags as send-file.`
	show.Example += `
  shuttle show report.html --caption "Latest calibration"
  shuttle show fig1.png fig2.png`
	show.Args = cobra.MinimumNArgs(1)
	show.Flags().String("session", "", "files: native session ID (otherwise detected from environment or tmux ledger)")
	show.Flags().String("caption", "", "files: why these files are shown")
	show.RunE = func(cmd *cobra.Command, args []string) error {
		hasFileFlags := cmd.Flags().Changed("session") || cmd.Flags().Changed("caption")
		hasViewFlags := a.json ||
			cmd.Flags().Changed("store") || cmd.Flags().Changed("fiber-path") ||
			cmd.Flags().Changed("exact") || cmd.Flags().Changed("path-hint") ||
			cmd.Flags().Changed("body") || cmd.Flags().Changed("detail") ||
			cmd.Flags().Changed("citations") || cmd.Flags().Changed("consumers") ||
			cmd.Flags().Changed("field") || cmd.Flags().Changed("around")
		if hasFileFlags || (!hasViewFlags && (len(args) > 1 || a.isRegularFileArg(args[0]))) {
			session, _ := cmd.Flags().GetString("session")
			caption, _ := cmd.Flags().GetString("caption")
			files, err := a.recordSentFiles(args, session, caption, true)
			if err != nil {
				return err
			}
			for _, path := range files {
				fmt.Fprintln(a.env.Stdout, "Recorded file:", path)
			}
			return nil
		}
		if len(args) != 1 {
			return fmt.Errorf("accepts 1 arg(s), received %d", len(args))
		}
		return prevRun(cmd, args)
	}
	return show
}

func (a *app) isRegularFileArg(arg string) bool {
	if strings.TrimSpace(arg) == "" {
		return false
	}
	abs, err := a.env.Abs(arg)
	if err != nil {
		return false
	}
	info, err := os.Stat(abs)
	return err == nil && info.Mode().IsRegular()
}

func (a *app) sendFiles(paths []string, session, caption string) ([]string, error) {
	return a.recordSentFiles(paths, session, caption, false)
}

func (a *app) recordSentFiles(paths []string, session, caption string, show bool) ([]string, error) {
	files := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			return nil, fmt.Errorf("empty file path")
		}
		abs, err := a.env.Abs(path)
		if err != nil {
			return nil, err
		}
		if !seen[abs] {
			files = append(files, abs)
			seen[abs] = true
		}
	}
	tmux := a.currentTmuxSession()
	session = strings.TrimSpace(session)
	if session == "" {
		_, session = a.currentSession()
	}
	if session == "" {
		session = a.sendFileLedgerSession(tmux)
	}
	if session == "" {
		return nil, fmt.Errorf("no session identity; supply --session or run inside a harness session")
	}
	origin, err := a.resolveOwnHost("")
	if err != nil {
		return nil, err
	}
	cwd, err := a.env.Getwd()
	if err != nil {
		return nil, err
	}
	sink, enabled := a.eventsSink()
	if !enabled {
		return nil, fmt.Errorf("Shuttle event recording is disabled or its state directory is missing")
	}
	timestamp := a.eventNow().UnixMilli()
	line := eventLine{
		ID:        session + "-" + strconv.FormatInt(timestamp, 10) + "-" + strconv.Itoa(a.eventRand()),
		Timestamp: timestamp, SessionID: session,
		CWD: cwd, TmuxSession: tmux, OriginName: origin,
	}
	if err := a.appendFileSent(sink, line, files, strings.TrimSpace(caption), show); err != nil {
		return nil, err
	}
	return files, nil
}

// appendFileSent records a send of files, which are absolute paths: it copies
// each into the copy store beside sink, then appends the file_sent event that
// names the files and their copies. Nothing is recorded unless every file was
// read, and nothing is copied for a send whose line would be too long.
func (a *app) appendFileSent(sink string, line eventLine, files []string, caption string, show bool) error {
	line.Type = "file_sent"
	encode := func(copies map[string]string) (string, error) {
		line.Copies = copies
		return encodeJSONLine(struct {
			eventLine
			Files   []string `json:"files"`
			Caption string   `json:"caption,omitempty"`
			Show    bool     `json:"show,omitempty"`
		}{eventLine: line, Files: files, Caption: caption, Show: show})
	}
	longest := map[string]string{}
	for _, file := range files {
		longest[file] = strings.Repeat("0", sentCopyNameMax)
	}
	if encoded, err := encode(longest); err != nil {
		return err
	} else if len(encoded) > eventMaxLineBytes {
		return fmt.Errorf("delivery exceeds %d bytes; send fewer files at once", eventMaxLineBytes)
	}
	copies, err := a.copySentFiles(sink, files)
	if err != nil {
		return err
	}
	encoded, err := encode(copies)
	if err != nil {
		return err
	}
	if err := a.appendEventLine(sink, encoded); err != nil {
		return fmt.Errorf("record delivery: %w", err)
	}
	return nil
}

// The newest session the ledger binds to this host's tmux session; cwd is not
// session identity.
func (a *app) sendFileLedgerSession(tmux string) string {
	session := ""
	if tmux == "" {
		return session
	}
	for _, row := range a.localMessageLedger() {
		if row.Tmux == tmux && row.Session != "" {
			session = row.Session
		}
	}
	return session
}
