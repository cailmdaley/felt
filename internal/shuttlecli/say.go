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
		Short: "Speak a line aloud on the human's speaker, in your role's voice",
		Long: `Queue one line on the spoken outbox. The daemon routes it to the host
with a speaker, renders it with pocket-tts in the voice of the calling worker's
role (the charter's voice: field, else dylan_thomas), and plays it after any
lines already queued. Playback holds while the human is talking.

Speak only inside a conversation the human is having with you by voice: one line,
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
				Held     bool   `json:"held"`
				Recorder string `json:"recorder"`
			}
			if err := json.Unmarshal(body, &answer); err != nil {
				return fmt.Errorf("decoding speak answer: %w", err)
			}
			when := "next"
			if answer.Held {
				when = "held until its card is in view"
			} else if answer.Ahead > 0 {
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

func (a *app) shuttleInboxCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "inbox [--play | --stop]",
		Short: "List spoken lines held for cards out of view, or play them",
		Long: `List the lines the speaker holds because their card is not in view: each
card's name, how many lines wait, and the first words of the oldest.

--play opens the inbox, as saying "play" does: every held line plays, oldest
first, each card's turn opening with its name, and live voice follows the card
whose line is playing. --stop closes it and leaves the rest held.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			play, _ := cmd.Flags().GetBool("play")
			stop, _ := cmd.Flags().GetBool("stop")
			var body []byte
			var err error
			switch {
			case play && stop:
				return fmt.Errorf("--play and --stop are exclusive")
			case play || stop:
				action := "play"
				if stop {
					action = "stop"
				}
				body, err = a.postMeeting("/api/v1/speak", map[string]any{"inbox": action})
			default:
				var endpoint string
				if endpoint, err = a.daemonEndpoint("/api/v1/speak"); err == nil {
					body, err = a.getDaemon(endpoint, daemonRoutedPostTimeout)
				}
			}
			if err != nil {
				return err
			}
			if a.json {
				a.printDaemonBody(body)
				return nil
			}
			var answer struct {
				Held []struct {
					Name  string `json:"name"`
					N     int    `json:"n"`
					First string `json:"first"`
				} `json:"held"`
				Inbox struct {
					Playing bool `json:"playing"`
				} `json:"inbox"`
			}
			if err := json.Unmarshal(body, &answer); err != nil {
				return fmt.Errorf("decoding speaker state: %w", err)
			}
			if answer.Inbox.Playing {
				fmt.Fprintln(a.env.Stdout, "Inbox playing")
			} else if len(answer.Held) == 0 {
				fmt.Fprintln(a.env.Stdout, "Nothing held")
			}
			for _, card := range answer.Held {
				fmt.Fprintf(a.env.Stdout, "%s (%d): %s\n", card.Name, card.N, firstWords(card.First, 8))
			}
			return nil
		},
	}
	cmd.Flags().Bool("play", false, "Play every held line, oldest first")
	cmd.Flags().Bool("stop", false, "Stop playing held lines and leave the rest held")
	return cmd
}

// firstWords is the first n words of text, marked when cut.
func firstWords(text string, n int) string {
	words := strings.Fields(text)
	if len(words) <= n {
		return strings.Join(words, " ")
	}
	return strings.Join(words[:n], " ") + " …"
}
