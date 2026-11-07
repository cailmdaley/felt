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
			body, err := a.postSpeech("/api/v1/speak", request)
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
		Use:   "inbox [--play | --next | --stop]",
		Short: "List spoken lines held for cards out of view, or play them",
		Long: `List the lines the speaker holds because their card is not in view: each
card's name, how many lines wait, and the first words of the oldest.

--play opens the inbox on the card whose held line is oldest, as saying "play"
does: live voice is routed to it and Rex shows it, its lines play, the first
opening with its name, and then it waits for an answer. --next moves to the
next card the same way; --stop closes the inbox and leaves the rest held.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var actions []string
			for _, action := range []string{"play", "next", "stop"} {
				if on, _ := cmd.Flags().GetBool(action); on {
					actions = append(actions, action)
				}
			}
			var body []byte
			var err error
			switch len(actions) {
			case 0:
				var endpoint string
				if endpoint, err = a.daemonEndpoint("/api/v1/speak"); err == nil {
					body, err = a.getDaemon(endpoint, daemonRoutedPostTimeout)
				}
			case 1:
				body, err = a.postSpeech("/api/v1/speak", map[string]any{"inbox": actions[0]})
			default:
				return fmt.Errorf("--play, --next and --stop are exclusive")
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
					Card    *struct {
						Name string `json:"name"`
					} `json:"card"`
				} `json:"inbox"`
			}
			if err := json.Unmarshal(body, &answer); err != nil {
				return fmt.Errorf("decoding speaker state: %w", err)
			}
			if answer.Inbox.Playing && answer.Inbox.Card != nil {
				fmt.Fprintf(a.env.Stdout, "Inbox on %s\n", answer.Inbox.Card.Name)
			} else if len(answer.Held) == 0 {
				fmt.Fprintln(a.env.Stdout, "Nothing held")
			}
			for _, card := range answer.Held {
				fmt.Fprintf(a.env.Stdout, "%s (%d): %s\n", card.Name, card.N, firstWords(card.First, 8))
			}
			return nil
		},
	}
	cmd.Flags().Bool("play", false, "Play the held lines of the card waiting longest")
	cmd.Flags().Bool("next", false, "Play the next card's held lines")
	cmd.Flags().Bool("stop", false, "Close the inbox and leave the rest held")
	return cmd
}

// postSpeech sends a spoken-output request through the local daemon.
func (a *app) postSpeech(path string, request map[string]any) ([]byte, error) {
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encoding spoken-output request: %w", err)
	}
	endpoint, err := a.daemonEndpoint(path)
	if err != nil {
		return nil, err
	}
	return a.postDaemon(endpoint, payload, daemonRoutedPostTimeout)
}

// firstWords is the first n words of text, marked when cut.
func firstWords(text string, n int) string {
	words := strings.Fields(text)
	if len(words) <= n {
		return strings.Join(words, " ")
	}
	return strings.Join(words[:n], " ") + " …"
}
