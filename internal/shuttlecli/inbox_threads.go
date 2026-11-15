package shuttlecli

import (
	"encoding/json"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

func (a *app) threadInboxVerbs() []*cobra.Command {
	state := &cobra.Command{Use: "thread-state", Short: "Import thread publications and read durable capture cutoffs", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		state, err := messaging.BootThreadInbox(a.env)
		if err != nil {
			return err
		}
		return json.NewEncoder(a.env.Stdout).Encode(state)
	}}
	capture := &cobra.Command{Use: "thread-put <id> <record-json>", Short: "Enqueue a derived thread publication and report whether it was created", Args: cobra.ExactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		var record map[string]any
		if err := json.Unmarshal([]byte(args[1]), &record); err != nil {
			return err
		}
		entry, err := messaging.ThreadEntry(args[0], record)
		if err != nil {
			return err
		}
		created := false
		entry.Created = &created
		if err = messaging.Enqueue(a.env, entry); err != nil {
			return err
		}
		return json.NewEncoder(a.env.Stdout).Encode(map[string]bool{"created": created})
	}}
	routes := &cobra.Command{Use: "routes <owner>", Short: "List pending thread publications and their routing on this host", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		entries, err := messaging.RoutedEntries(a.env, args[0])
		if err != nil {
			return err
		}
		return json.NewEncoder(a.env.Stdout).Encode(entries)
	}}
	settle := &cobra.Command{Use: "settle <address> <id> <disposition>", Short: "Finalize a confirmed forward or session outcome", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		return messaging.SettleRoute(a.env, args[0], args[1], args[2])
	}}
	return []*cobra.Command{state, capture, routes, settle}
}
