package shuttlecli

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

// meetingAnswer is the part of a /meeting/start or /meeting/stop answer the
// readable output names.
type meetingAnswer struct {
	Recorder   string `json:"recorder"`
	Origin     string `json:"origin"`
	Transcript string `json:"transcript"`
	Meeting    *struct {
		State  string `json:"state"`
		Title  string `json:"title"`
		Launch string `json:"launch"`
	} `json:"meeting"`
}

func (a *app) shuttleMeetingCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "meeting",
		Short: "Record a meeting with hark without launching an agent",
	}
	cmd.AddCommand(a.shuttleMeetingStartCmd(), a.shuttleMeetingStopCmd())
	return cmd
}

func (a *app) shuttleMeetingStartCmd() *cobra.Command {
	start := &cobra.Command{
		Use:   "start [--recorder <host>] [--mode call|phone] [--note <text>]",
		Short: "Start a recording and print its transcript path on this host",
		Long: `Ask the local daemon to start hark on the recorder (this host when
--recorder is omitted, or for --mode phone the recorder the daemon selects) and
mirror the transcript to this host. No agent is launched and no fiber is told:
the caller follows the transcript itself, with shuttle follow <path>.

The recording is named after the note's first line, else "Meeting". Stdout is
the transcript's path on this host, so the two verbs compose:

  shuttle follow "$(shuttle meeting start --recorder mac)"

The recorder and launch id go to stderr, for shuttle meeting stop. --json
prints the daemon's whole answer. A start the recorder did not confirm fails
with recording_unknown: inspect that recorder before starting another.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			recorder, _ := cmd.Flags().GetString("recorder")
			mode, _ := cmd.Flags().GetString("mode")
			note, _ := cmd.Flags().GetString("note")
			if mode != "call" && mode != "phone" {
				return fmt.Errorf("--mode must be call or phone")
			}
			request := map[string]any{"meeting": map[string]string{"mode": mode}}
			if recorder = strings.TrimSpace(recorder); recorder != "" {
				request["recorder"] = recorder
			}
			if note != "" {
				request["note"] = note
			}
			body, err := a.postMeeting("/api/v1/meeting/start", request)
			if err != nil {
				return err
			}
			if a.json {
				a.printDaemonBody(body)
				return nil
			}
			var answer meetingAnswer
			if err := json.Unmarshal(body, &answer); err != nil {
				return fmt.Errorf("decoding meeting start: %w", err)
			}
			if answer.Transcript == "" {
				return fmt.Errorf("daemon answered without a transcript path: %s", strings.TrimSpace(string(body)))
			}
			fmt.Fprintln(a.env.Stdout, answer.Transcript)
			if row := answer.Meeting; row != nil {
				fmt.Fprintf(a.env.Stderr, "Recording %q on %s (%s); stop with: shuttle meeting stop --recorder %s --launch %s\n",
					row.Title, answer.Recorder, row.State, answer.Recorder, row.Launch)
			}
			return nil
		},
	}
	start.Flags().String("recorder", "", "Host whose daemon records (default: this host; for phone, the daemon selects one)")
	start.Flags().String("mode", "call", "Audio input: call (the recorder's mic and system audio) or phone (a phone's mic)")
	start.Flags().String("note", "", "Note whose first line names the recording")
	return start
}

func (a *app) shuttleMeetingStopCmd() *cobra.Command {
	stop := &cobra.Command{
		Use:   "stop [--recorder <host> --launch <id>]",
		Short: "Stop a recording, or dismiss its failed tmux pane",
		Long: `Ask the local daemon to stop the recording on --recorder, or on this
host when it is omitted. An addressed stop needs the recording's --launch id,
which shuttle meeting start printed, so it never stops a newer recording.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			recorder, _ := cmd.Flags().GetString("recorder")
			launch, _ := cmd.Flags().GetString("launch")
			request := map[string]any{}
			if recorder = strings.TrimSpace(recorder); recorder != "" {
				if launch == "" {
					return fmt.Errorf("--launch is required with --recorder")
				}
				request["recorder"] = recorder
			}
			if launch != "" {
				request["launch"] = launch
			}
			body, err := a.postMeeting("/api/v1/meeting/stop", request)
			if err != nil {
				return err
			}
			if a.json {
				a.printDaemonBody(body)
				return nil
			}
			var answer meetingAnswer
			if err := json.Unmarshal(body, &answer); err != nil {
				return fmt.Errorf("decoding meeting stop: %w", err)
			}
			if row := answer.Meeting; row != nil {
				fmt.Fprintf(a.env.Stdout, "Meeting %q on %s: %s\n", row.Title, answer.Recorder, row.State)
			} else {
				fmt.Fprintf(a.env.Stdout, "No meeting is recording on %s\n", answer.Recorder)
			}
			return nil
		},
	}
	stop.Flags().String("recorder", "", "Host whose daemon is recording (default: this host)")
	stop.Flags().String("launch", "", "Launch id of the recording to stop")
	return stop
}

// postMeeting sends a meeting request to the local daemon, which records or
// forwards it to the recorder. The routed budget covers that forward.
func (a *app) postMeeting(path string, request map[string]any) ([]byte, error) {
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encoding meeting request: %w", err)
	}
	endpoint, err := a.daemonEndpoint(path)
	if err != nil {
		return nil, err
	}
	return a.postDaemon(endpoint, payload, daemonRoutedPostTimeout)
}
