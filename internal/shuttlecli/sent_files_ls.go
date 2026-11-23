package shuttlecli

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// sentFile is one entry of GET /api/v1/sent-files, plus the URL that serves it.
type sentFile struct {
	FullPath  string  `json:"fullPath"`
	Basename  string  `json:"basename"`
	Timestamp *int64  `json:"timestamp"`
	SessionID *string `json:"sessionId"`
	Caption   string  `json:"caption,omitempty"`
	Show      bool    `json:"show"`
	URL       string  `json:"url,omitempty"`
}

func (a *app) sentFilesListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "ls <fiber>",
		Short: "List the files a fiber's workers sent, newest first",
		Long: `List a fiber's sent files from its owner, through the local daemon: when each
was sent, its path on the owning host, its caption, and the URL that serves it.
Each path appears once, at its newest send. The fiber resolves from any
directory and must match exactly.

With the daemon unreachable, a fiber this host owns is read from the host's
event stream, without URLs.

--json gives {fiber, uid, host, source, files}; source is daemon or events.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			fiber, err := a.resolveOwnedFiber(args[0])
			if err != nil {
				return err
			}
			files, source, err := a.sentFilesFor(fiber)
			if err != nil {
				return err
			}
			if a.json {
				return a.outputJSON(map[string]any{
					"fiber": fiber.ID, "uid": fiber.UID, "host": fiber.Host, "source": source, "files": files,
				})
			}
			if source == sentFilesFromEvents {
				fmt.Fprintln(a.env.Stderr, "daemon unreachable; read from this host's event stream")
			}
			if len(files) == 0 {
				fmt.Fprintf(a.env.Stdout, "no sent files for %s\n", fiber.ID)
			}
			for _, file := range files {
				when := "(no time)"
				if file.Timestamp != nil {
					when = time.UnixMilli(*file.Timestamp).Local().Format("2006-01-02 15:04")
				}
				fmt.Fprintf(a.env.Stdout, "%s  %s\n", when, file.FullPath)
				if file.Caption != "" {
					fmt.Fprintf(a.env.Stdout, "    %s\n", file.Caption)
				}
				if file.URL != "" {
					fmt.Fprintf(a.env.Stdout, "    %s\n", file.URL)
				}
			}
			return nil
		},
	}
}

const (
	sentFilesFromDaemon = "daemon"
	sentFilesFromEvents = "events"
)

// sentFilesFor reads fiber's trail from its owner, or from this host's event
// stream when the daemon is unreachable and this host owns the fiber.
func (a *app) sentFilesFor(fiber ownedFiber) (files []sentFile, source string, err error) {
	endpoint, err := a.daemonEndpoint("/api/v1/sent-files")
	if err != nil {
		return nil, "", err
	}
	endpoint += "?" + url.Values{"uid": {fiber.UID}, "origin": {fiber.Host}}.Encode()
	response, err := getDaemonJSON[struct {
		Files []sentFile `json:"files"`
	}](a, endpoint, "parsing sent files")
	if !fiber.Remote && isLifecycleTransportError(err) {
		files, err = a.sentFilesFromStream(fiber.UID)
		return files, sentFilesFromEvents, err
	}
	if err != nil {
		return nil, "", err
	}
	if base, err := a.browserURL(); err == nil {
		for i := range response.Files {
			response.Files[i].URL = fileURL(base, response.Files[i].FullPath, fiber.Host)
		}
	}
	if response.Files == nil {
		response.Files = []sentFile{}
	}
	return response.Files, sentFilesFromDaemon, nil
}

// sentFilesCap is how many sends a trail holds, as Shuttle.SentFiles caps it.
const sentFilesCap = 50

// sentFileEvent is the part of an event-stream line a trail reads.
type sentFileEvent struct {
	Type        string   `json:"type"`
	Tool        string   `json:"tool"`
	UID         string   `json:"uid"`
	Path        *string  `json:"path"`
	Files       []string `json:"files"`
	Caption     string   `json:"caption"`
	Show        bool     `json:"show"`
	CWD         string   `json:"cwd"`
	SessionID   *string  `json:"sessionId"`
	TmuxSession string   `json:"tmuxSession"`
	Timestamp   *int64   `json:"timestamp"`
	ToolInput   struct {
		Files   []string `json:"files"`
		Caption string   `json:"caption"`
	} `json:"toolInput"`
}

// sentFilesFromStream is uid's trail read from this host's event stream, by
// the rules of the daemon's Shuttle.SentFiles.for_uid/2: a send belongs to the
// fiber its terminal session names, else the one the session ledger records,
// and to the one it names as its session; a clear hides sends at or before it;
// and each path keeps its newest send.
func (a *app) sentFilesFromStream(uid string) ([]sentFile, error) {
	owners := map[string]string{}
	for _, row := range a.localMessageLedger() {
		if row.Session != "" && row.UID != "" {
			owners[row.Session] = row.UID
		}
	}
	newest := map[string]sentFile{}
	cleared := map[string]int64{} // by path; "" is the whole fiber
	read := func(event sentFileEvent) {
		if event.Type == "sent_files_cleared" {
			if event.UID != uid || event.Timestamp == nil {
				return
			}
			path := ""
			if event.Path != nil {
				path = *event.Path
				if !filepath.IsAbs(path) {
					return
				}
			}
			cleared[path] = max(cleared[path], *event.Timestamp)
			return
		}
		paths, caption := event.Files, event.Caption
		if event.Type != "file_sent" {
			if event.Tool != "SendUserFile" {
				return
			}
			paths, caption = event.ToolInput.Files, event.ToolInput.Caption
		}
		owner := fiberUIDFromTmuxSession(event.TmuxSession)
		session := ""
		if event.SessionID != nil {
			session = *event.SessionID
		}
		if owner == "" {
			owner = owners[session]
		}
		if owner != uid && session != uid {
			return
		}
		if strings.TrimSpace(caption) == "" {
			caption = ""
		}
		for _, path := range paths {
			if !filepath.IsAbs(path) && event.CWD != "" {
				path = filepath.Join(event.CWD, path)
			}
			if old, seen := newest[path]; seen && sentAfter(old, event.Timestamp) {
				continue
			}
			newest[path] = sentFile{
				FullPath: path, Basename: filepath.Base(path), Timestamp: event.Timestamp,
				SessionID: event.SessionID, Caption: caption, Show: event.Show,
			}
		}
	}
	live, _ := shuttle.EventsFile(a.env)
	for _, path := range []string{live + eventsRotatedSuffix, live} {
		if err := readSentFileEvents(path, read); err != nil {
			return nil, err
		}
	}

	files := []sentFile{}
	for path, file := range newest {
		if file.Timestamp == nil || *file.Timestamp > max(cleared[""], cleared[path]) {
			files = append(files, file)
		}
	}
	sort.Slice(files, func(i, j int) bool {
		if sentAfter(files[i], files[j].Timestamp) != sentAfter(files[j], files[i].Timestamp) {
			return sentAfter(files[i], files[j].Timestamp)
		}
		return files[i].FullPath < files[j].FullPath
	})
	return files[:min(len(files), sentFilesCap)], nil
}

// sentAfter reports whether file was sent strictly after at. A send without a
// time sorts as newest, as the daemon orders it.
func sentAfter(file sentFile, at *int64) bool {
	if file.Timestamp == nil || at == nil {
		return file.Timestamp == nil && at != nil
	}
	return *file.Timestamp > *at
}

// readSentFileEvents hands read each sent-file event in the stream at path; an
// absent stream holds none.
func readSentFileEvents(path string, read func(sentFileEvent)) error {
	stream, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer stream.Close()
	lines := bufio.NewReader(stream)
	for {
		line, err := lines.ReadBytes('\n')
		var event sentFileEvent
		// A line of another shape, or one still being written, is no event.
		if json.Unmarshal(line, &event) == nil {
			read(event)
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
