package shuttlecli

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// defaultFollowNames are the words that address the agent, including common
// speech-recognition renderings of "Claude".
var defaultFollowNames = []string{"claude", "cloud", "clawed", "klaud"}

var shuttleFollowCmd = &cobra.Command{
	Use:   "follow <transcript>",
	Short: "Stream a live meeting transcript to an agent in batches",
	Long: `Watch a live transcript file and print its new lines in batches, each
followed by one blank line, so an agent reading stdout sees coherent chunks
rather than a trickle of single lines.

The file may not exist yet; follow waits for it. Everything already in the
file at the first read is printed at once as the first batch. After that, new
complete lines are held pending until one of these flushes them:

  - a line addressing the agent: a whole word from --names, case-insensitive,
    in the utterance text (after any leading HH:MM:SS timestamp or
    HH:MM:SS-HH:MM:SS range)
  - the pending utterance text reaching --words words
  - --seconds elapsing since the first pending line arrived
  - a line starting "# ended", which flushes and ends the follow (exit 0)

Lines starting "#" ride along with the batch without counting words or
triggering a flush. A partial trailing line waits for its newline. A file that
shrinks is read again from the start. The file is polled once per second.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		words, _ := cmd.Flags().GetInt("words")
		seconds, _ := cmd.Flags().GetFloat64("seconds")
		namesFlag, _ := cmd.Flags().GetString("names")
		var names []string
		for _, name := range strings.Split(namesFlag, ",") {
			if name = strings.TrimSpace(name); name != "" {
				names = append(names, name)
			}
		}
		if len(names) == 0 {
			return fmt.Errorf("--names must list at least one word")
		}
		path, err := expandUserPath(args[0])
		if err != nil {
			return err
		}
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			path = resolved
		}
		out := cmd.OutOrStdout()
		return followTranscript(path, newFollowBatcher(words, time.Duration(seconds*float64(time.Second)), names), followIO{
			poll:  time.Second,
			sleep: time.Sleep,
			clock: time.Now,
			emit:  func(line string) { fmt.Fprintln(out, line) },
		})
	},
}

func init() {
	shuttleFollowCmd.Flags().Int("words", 150, "Flush pending lines once their utterance text reaches this many words")
	shuttleFollowCmd.Flags().Float64("seconds", 15, "Flush pending lines this long after the first one arrived")
	shuttleFollowCmd.Flags().String("names", strings.Join(defaultFollowNames, ","), "Comma-separated words that address the agent (case-insensitive)")
	addShuttleCommand(shuttleFollowCmd)
}

// followTimestamp matches a leading HH:MM:SS stamp, or an HH:MM:SS-HH:MM:SS
// range, and captures the utterance after it.
var followTimestamp = regexp.MustCompile(`^\d{2}:\d{2}:\d{2}(?:-\d{2}:\d{2}:\d{2})?\s+(.*)$`)

// followBatcher holds transcript lines until a flush condition is met. It is
// pure: callers supply every line and clock reading.
type followBatcher struct {
	words        int
	seconds      time.Duration
	pattern      *regexp.Regexp
	pending      []string
	wordCount    int
	firstArrival time.Time
	ended        bool
}

func newFollowBatcher(words int, seconds time.Duration, names []string) *followBatcher {
	quoted := make([]string, len(names))
	for i, name := range names {
		quoted[i] = regexp.QuoteMeta(name)
	}
	return &followBatcher{
		words:   words,
		seconds: seconds,
		pattern: regexp.MustCompile(`(?i)\b(` + strings.Join(quoted, "|") + `)\b`),
	}
}

// Add records one line arriving at now and returns a batch to flush, or nil.
func (b *followBatcher) Add(line string, now time.Time) []string {
	if b.pending = append(b.pending, line); len(b.pending) == 1 {
		b.firstArrival = now
	}
	if strings.HasPrefix(line, "# ended") {
		b.ended = true
		return b.flush()
	}
	if strings.HasPrefix(line, "#") {
		return nil
	}
	text := line
	if match := followTimestamp.FindStringSubmatch(line); match != nil {
		text = match[1]
	}
	b.wordCount += len(strings.Fields(text))
	if b.pattern.MatchString(text) || b.wordCount >= b.words {
		return b.flush()
	}
	return nil
}

// Tick returns the pending batch once seconds have elapsed since its first line, or nil.
func (b *followBatcher) Tick(now time.Time) []string {
	if len(b.pending) > 0 && now.Sub(b.firstArrival) >= b.seconds {
		return b.flush()
	}
	return nil
}

// Ended reports whether a "# ended" line has been seen.
func (b *followBatcher) Ended() bool { return b.ended }

func (b *followBatcher) flush() []string {
	batch := b.pending
	b.pending, b.wordCount, b.firstArrival = nil, 0, time.Time{}
	return batch
}

// followIO is the follow loop's contact with time and output.
type followIO struct {
	poll  time.Duration
	sleep func(time.Duration)
	clock func() time.Time
	emit  func(string)
}

func (fio followIO) emitBatch(lines []string) {
	for _, line := range lines {
		fio.emit(line)
	}
	fio.emit("")
}

// followTranscript polls path for new complete lines and batches them through
// b until the transcript ends. It waits for the file to exist; everything
// present at the first read is emitted unconditionally as the startup batch;
// a file smaller than the consumed offset is read again from byte 0.
func followTranscript(path string, b *followBatcher, fio followIO) error {
	for {
		_, err := os.Stat(path)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return err
		}
		fio.sleep(fio.poll)
	}
	var offset int64
	started := false
	for {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if info.Size() < offset {
			offset = 0
		}
		data, err := readTranscriptFrom(path, offset)
		if err != nil {
			return err
		}
		if complete := bytes.LastIndexByte(data, '\n') + 1; complete > 0 {
			lines := transcriptLines(data[:complete])
			offset += int64(complete)
			if !started {
				started = true
				fio.emitBatch(lines)
				for _, line := range lines {
					if strings.HasPrefix(line, "# ended") {
						return nil
					}
				}
			} else {
				for _, line := range lines {
					if batch := b.Add(line, fio.clock()); batch != nil {
						fio.emitBatch(batch)
						if b.Ended() {
							return nil
						}
					}
				}
			}
		}
		if started {
			if batch := b.Tick(fio.clock()); batch != nil {
				fio.emitBatch(batch)
			}
		}
		fio.sleep(fio.poll)
	}
}

// readTranscriptFrom returns the file's bytes from offset onward.
func readTranscriptFrom(path string, offset int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(f)
}

// transcriptLines splits complete newline-terminated bytes into lines,
// dropping a trailing \r and replacing invalid UTF-8 with U+FFFD.
func transcriptLines(data []byte) []string {
	text := strings.ToValidUTF8(string(data[:len(data)-1]), "\uFFFD")
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	return lines
}
