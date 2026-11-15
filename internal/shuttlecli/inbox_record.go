package shuttlecli

import (
	"encoding/json"
	"io"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

// recordInboxVerbs record the lines the daemon transports itself (typed human
// input, an agent's fresh session request). The text comes on stdin, so a
// line beginning with "-" is never read as a flag and a long paste is not
// bounded by the argument list.
func (a *app) recordInboxVerbs() []*cobra.Command {
	var from, fiber, ask string
	begin := &cobra.Command{Use: "record-begin <fiber-key> <message-id> < text", Short: "Record a line, read from stdin, before the daemon transports it", Args: cobra.ExactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		text, err := io.ReadAll(a.env.Stdin)
		if err != nil {
			return err
		}
		created, disposition, err := messaging.BeginRecord(a.env, args[0], args[1], from, string(text))
		if err != nil {
			return err
		}
		if created && from == "human" && fiber != "" {
			a.recordHumanLine(args[1], fiber, ask, string(text))
		}
		return json.NewEncoder(a.env.Stdout).Encode(map[string]any{"created": created, "disposition": disposition})
	}}
	begin.Flags().StringVar(&from, "from", "human", "who the line is from")
	begin.Flags().StringVar(&fiber, "fiber", "", "the fiber's uid, for the human line's family-board row")
	begin.Flags().StringVar(&ask, "ask", "", "the question the human line answers, for its board row")
	settle := &cobra.Command{Use: "record-settle <fiber-key> <message-id> delivered|unknown|undeliverable", Short: "Record the outcome of a recorded line's transport", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		return messaging.SettleRecord(a.env, args[0], args[1], args[2])
	}}
	return []*cobra.Command{begin, settle}
}

// recordHumanLine writes the family-board row for a human line the daemon
// transports, under the record's identity: a repeated id replaces it, and the
// worker's prompt hook, when the line is typed into its session, writes its
// own row under the same identity (HumanRecordFor). A line that answers the
// fiber's question is that question's one answered row.
func (a *app) recordHumanLine(id, fiber, ask, text string) {
	r := boardRecord{ID: "brd-" + id, Kind: "human", Fiber: fiber, By: &boardParty{Label: a.humanLabel()}, Text: text}
	if ask != "" {
		r.Kind, r.Text = "answered", "Q: "+ask+" — A: "+text
	}
	a.recordBoard(r)
}
