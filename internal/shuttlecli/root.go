package shuttlecli

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"runtime/debug"

	"github.com/spf13/cobra"
)

var (
	jsonOutput bool
	changeDir  string
)

var Version = "dev"

func SetVersionInfo(v, commit, date string) {
	Version = v
	if commit == "none" {
		commit = vcsRevision()
	}
	switch {
	case commit == "":
		rootCmd.Version = v
	case date == "unknown":
		rootCmd.Version = fmt.Sprintf("%s (%s)", v, commit)
	default:
		rootCmd.Version = fmt.Sprintf("%s (%s, built %s)", v, commit, date)
	}
}

func vcsRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	revision, dirty := "", false
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			dirty = setting.Value == "true"
		}
	}
	if len(revision) > 12 {
		revision = revision[:12]
	}
	if revision != "" && dirty {
		revision += "-dirty"
	}
	return revision
}

const (
	groupOperations = "operations"
	groupAgents     = "agents"
	groupHosts      = "hosts"
)

const rootLong = `Shuttle dispatches agent work from fibers stored by felt. A fiber with a
shuttle: block is work the daemon can dispatch; without one it is a note.
Local write verbs validate before touching disk and work offline. When
shuttle.host names a configured remote, lifecycle writes, reopen, and dispatch
route through the local daemon to the owner instead of writing this host's Git
mirror. Snapshot, dispatch, sessions, transcript, message, validate-identity,
and status --all talk to the local daemon.

Common paths:
  shuttle install <fiber> --project-dir "$PWD"   dispatch a fiber once
  shuttle status <fiber>                         its block and dispatch eligibility
  shuttle attach <fiber>                         the worker's live tmux session
  shuttle sessions                               addressable sessions across the fleet
  shuttle message <address> "text"               deliver to a session and wake it
  shuttle send-file <path>                       offer a file on Shuttle's board
  shuttle handoff <fiber>                        a worker's last call: exit cleanly`

var rootCmd = &cobra.Command{
	Use:   "shuttle",
	Short: "Agent dispatch, orchestration, and host operations",
	Long:  rootLong,
	CompletionOptions: cobra.CompletionOptions{
		HiddenDefaultCmd: true,
	},
	SilenceErrors: true,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		if err := cmd.ValidateRequiredFlags(); err != nil {
			return err
		}
		if err := cmd.ValidateFlagGroups(); err != nil {
			return err
		}
		cmd.SilenceUsage = true
		return nil
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	cobra.EnableTraverseRunHooks = true
	rootCmd.AddGroup(
		&cobra.Group{ID: groupOperations, Title: "Dispatch and sessions:"},
		&cobra.Group{ID: groupAgents, Title: "Agents and collaboration:"},
		&cobra.Group{ID: groupHosts, Title: "Hosts and connectivity:"},
	)
	rootCmd.SetHelpCommandGroupID(groupOperations)
	rootCmd.PersistentFlags().BoolVarP(&jsonOutput, "json", "j", false, "Output in JSON format")
	rootCmd.PersistentFlags().StringVarP(&changeDir, "store", "C", "", "Felt store root (directory containing .felt/)")
}

func outputJSON(data interface{}) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if v := reflect.ValueOf(data); v.Kind() == reflect.Slice && v.IsNil() {
		data = reflect.MakeSlice(v.Type(), 0, 0).Interface()
	}
	return enc.Encode(data)
}
