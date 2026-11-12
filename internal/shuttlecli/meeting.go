package shuttlecli

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) shuttleMeetingCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "meeting",
		Short: "Record a meeting to a card: Listen pinned there, with the computer's audio",
		Long: `A meeting is Listen on, pinned to one card, transcribing the computer's
audio (the call) as well as the microphone. Start one when the human says a
meeting is starting, and end it when they say it is over.

The meeting ends itself when Listen stops, when Listen follows the view again,
or after twenty minutes in which nothing was heard.`,
	}
	start := &cobra.Command{
		Use:   "start",
		Short: "Start a meeting pinned to the calling worker's card",
		Long: `Turn Listen on, unmuted, pinned to the calling worker's card, with the
computer's audio transcribed too. --fiber names the card from a terminal.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			fiber, _ := cmd.Flags().GetString("fiber")
			target := map[string]any{}
			if fiber = strings.TrimSpace(fiber); fiber != "" {
				target["fiber_id"] = fiber
			} else {
				f, err := a.currentWorkerFiber()
				if err != nil {
					return fmt.Errorf("%w (or pass --fiber)", err)
				}
				target["fiber_id"] = f.UID
				if f.UID == "" {
					target["fiber_id"] = f.ID
				}
				if block, ok, _ := shuttle.BlockOf(f); ok && block.Host != "" {
					target["origin"] = block.Host
				}
			}
			return a.postMeeting(map[string]any{"meeting": true, "target": target})
		},
	}
	start.Flags().String("fiber", "", "Card the meeting is pinned to (default: the calling worker)")
	end := &cobra.Command{
		Use:   "end",
		Short: "End the meeting: stop the computer's audio and follow the view again",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.postMeeting(map[string]any{"meeting": false})
		},
	}
	cmd.AddCommand(start, end)
	return cmd
}

func (a *app) postMeeting(request map[string]any) error {
	body, err := a.postLocal("/api/v1/voice", request)
	if err != nil {
		return err
	}
	if a.json {
		a.printDaemonBody(body)
		return nil
	}
	var answer struct {
		Mode   string `json:"mode"`
		Target *struct {
			FiberID string `json:"fiber_id"`
			Name    string `json:"name"`
		} `json:"target"`
		Recorder string `json:"recorder"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		return fmt.Errorf("decoding voice state: %w", err)
	}
	switch {
	case answer.Mode == "meeting" && answer.Target != nil:
		name := answer.Target.Name
		if name == "" {
			name = answer.Target.FiberID
		}
		fmt.Fprintf(a.env.Stdout, "Meeting on %s, recording on %s\n", name, answer.Recorder)
	case answer.Mode == "off":
		fmt.Fprintln(a.env.Stdout, "No meeting; Listen is off")
	default:
		fmt.Fprintf(a.env.Stdout, "No meeting; Listen is %s\n", answer.Mode)
	}
	return nil
}
