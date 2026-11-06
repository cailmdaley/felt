package shuttlecli

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

func (a *app) shuttleSayCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "say <text>",
		Short: "Speak a line aloud on Cail's speaker, in your role's voice",
		Long: `Queue one line on the spoken outbox. The daemon routes it to the host
with a speaker, renders it with pocket-tts in the voice of the calling worker's
role (the charter's voice: field, else dylan_thomas), and plays it after any
lines already queued. Playback holds while Cail is talking.

Speak only inside a conversation Cail is having with you by voice: one line,
the rest on the card. Never unprompted.

A worker is identified from its session; --fiber names the speaker from a
terminal, and --voice overrides the voice for this line.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			fiber, _ := cmd.Flags().GetString("fiber")
			voice, _ := cmd.Flags().GetString("voice")
			request := map[string]any{"text": args[0]}
			if fiber = strings.TrimSpace(fiber); fiber == "" {
				f, err := a.currentWorkerFiber()
				if err != nil {
					return fmt.Errorf("%w (or pass --fiber)", err)
				}
				fiber = f.UID
				if fiber == "" {
					fiber = f.ID
				}
			}
			request["fiber_id"] = fiber
			if voice = strings.TrimSpace(voice); voice != "" {
				request["voice"] = voice
			}
			body, err := a.postMeeting("/api/v1/speak", request)
			if err != nil {
				return err
			}
			if a.json {
				a.printDaemonBody(body)
				return nil
			}
			var answer struct {
				Voice    string `json:"voice"`
				Ahead    int    `json:"ahead"`
				Recorder string `json:"recorder"`
			}
			if err := json.Unmarshal(body, &answer); err != nil {
				return fmt.Errorf("decoding speak answer: %w", err)
			}
			when := "next"
			if answer.Ahead > 0 {
				when = fmt.Sprintf("after %d queued", answer.Ahead)
			}
			fmt.Fprintf(a.env.Stdout, "Speaking on %s as %s, %s\n", answer.Recorder, answer.Voice, when)
			return nil
		},
	}
	cmd.Flags().String("fiber", "", "Fiber whose role's voice speaks (default: the calling worker)")
	cmd.Flags().String("voice", "", "Voice for this line: a bank voice or a pocket-tts built-in")
	return cmd
}

func (a *app) shuttleVoicesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "voices",
		Short: "List the voices shuttle say can speak in, and the roles holding them",
		Long: `List the voice bank and pocket-tts built-ins on the host that speaks, each
with the role whose charter names it in voice:. Unclaimed voices carry no role.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			endpoint, err := a.daemonEndpoint("/api/v1/speak/voices")
			if err != nil {
				return err
			}
			body, err := a.getDaemon(endpoint, daemonRoutedPostTimeout)
			if err != nil {
				return err
			}
			if a.json {
				a.printDaemonBody(body)
				return nil
			}
			var answer struct {
				Voices []struct {
					Name string `json:"name"`
					Kind string `json:"kind"`
					Role string `json:"role"`
				} `json:"voices"`
			}
			if err := json.Unmarshal(body, &answer); err != nil {
				return fmt.Errorf("decoding voices: %w", err)
			}
			for _, v := range answer.Voices {
				line := fmt.Sprintf("%-16s %-8s", v.Name, v.Kind)
				if v.Role != "" {
					line += " roles/" + v.Role
				}
				fmt.Fprintln(a.env.Stdout, strings.TrimRight(line, " "))
			}
			return nil
		},
	}
}
