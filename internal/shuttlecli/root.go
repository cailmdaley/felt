package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"runtime"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/clistreams"
	"github.com/cailmdaley/felt/internal/feltcli"
	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

// Version is the release version main stamps with SetVersionInfo before any
// command runs; versionLine is the root's --version text built from it.
var (
	Version     = "dev"
	versionLine string
)

func SetVersionInfo(v, commit, date string) {
	Version = v
	if commit == "none" {
		commit = vcsRevision()
	}
	switch {
	case commit == "":
		versionLine = v
	case date == "unknown":
		versionLine = fmt.Sprintf("%s (%s)", v, commit)
	default:
		versionLine = fmt.Sprintf("%s (%s, built %s)", v, commit, date)
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

// app is one shuttle invocation: the process surface it runs against, the
// root's persistent flags, and the machine probes and clocks its commands
// call. Commands read env vars, the home and working directories,
// executables and the standard streams through a.env, never through package
// os; tests replace a probe on their own app.
type app struct {
	env  *sysenv.Env
	json bool   // --json
	dir  string // -C

	// osHostname is os.Hostname, the last tier of resolveOwnHost.
	osHostname func() (string, error)
	// hostGOOS is runtime.GOOS: the platform whose tunnel supervisor
	// tunnels install renders and places.
	hostGOOS string
	// tmuxSessionExists and killTmuxSession address one session by exact name.
	tmuxSessionExists func(sessionName string) bool
	killTmuxSession   func(session string) error
	// liveTmuxSessions is the set of live shuttle worker sessions.
	liveTmuxSessions func() map[string]bool
	// claimTmuxSession names the tmux session this terminal is in.
	claimTmuxSession func() (string, error)
	// detectTmuxOrigin reports which launchd coalition owns the tmux server.
	detectTmuxOrigin func() tmuxOriginReport
	// loginEnvCapture is the login-shell capture installDaemonSupervisor uses.
	loginEnvCapture func() loginEnv
	// daemonLifecycleOwnerCheck refuses a daemon port another process owns.
	daemonLifecycleOwnerCheck func(hostSettings) error
	// execDaemonRelease replaces this process with the daemon release;
	// runDaemonReleaseVersion runs its version command.
	execDaemonRelease       func(path string, args ...string) error
	runDaemonReleaseVersion func(path string) error
	// daemonFindPIDs, daemonSignalPID and daemonPause find, signal and wait
	// on daemon processes for daemon stop.
	daemonFindPIDs  func(pattern string) ([]int, error)
	daemonSignalPID func(pid int, signal syscall.Signal) error
	daemonPause     func(time.Duration)
	// daemonLifecycleTimeout bounds the lifecycle POST resume and accept send.
	daemonLifecycleTimeout time.Duration
	// eventNow and eventRand stamp and break ties between hook events.
	eventNow  func() time.Time
	eventRand func() int
	// httpProxy picks the proxy for a daemon request that is not the local
	// socket: net/http's ProxyFromEnvironment.
	httpProxy func(*http.Request) (*url.URL, error)
	// versionProbeTimeout bounds each `shuttle --version` the binary receipt
	// runs against a candidate executable.
	versionProbeTimeout time.Duration
}

func newApp(env *sysenv.Env) *app {
	a := &app{
		env:                       env,
		osHostname:                os.Hostname,
		hostGOOS:                  runtime.GOOS,
		daemonLifecycleOwnerCheck: checkResolvedDaemonPortOwner,
		daemonSignalPID:           signalDaemonPID,
		daemonPause:               time.Sleep,
		daemonLifecycleTimeout:    5 * time.Second,
		eventNow:                  time.Now,
		eventRand:                 func() int { return rand.Intn(32768) },
		httpProxy:                 http.ProxyFromEnvironment,
		versionProbeTimeout:       3 * time.Second,
	}
	a.tmuxSessionExists = a.tmuxHasSession
	a.killTmuxSession = a.tmuxKillSession
	a.liveTmuxSessions = a.tmuxLiveWorkerSessions
	a.claimTmuxSession = a.tmuxCurrentSession
	a.detectTmuxOrigin = a.probeTmuxOrigin
	a.loginEnvCapture = a.captureLoginEnv
	a.execDaemonRelease = a.execRelease
	a.runDaemonReleaseVersion = a.runReleaseVersion
	a.daemonFindPIDs = a.findDaemonPIDs
	return a
}

// NewRootCmd builds a fresh shuttle command tree bound to env.
func NewRootCmd(env *sysenv.Env) *cobra.Command { return newApp(env).rootCmd() }

func (a *app) rootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:     "shuttle",
		Short:   "Agent dispatch, orchestration, and host operations",
		Long:    rootLong,
		Version: versionLine,
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
	root.AddGroup(
		&cobra.Group{ID: groupOperations, Title: "Dispatch and sessions:"},
		&cobra.Group{ID: groupAgents, Title: "Agents and collaboration:"},
		&cobra.Group{ID: groupHosts, Title: "Hosts and connectivity:"},
	)
	root.SetHelpCommandGroupID(groupOperations)
	root.PersistentFlags().BoolVarP(&a.json, "json", "j", false, "Output in JSON format")
	root.PersistentFlags().StringVarP(&a.dir, "store", "C", "", "Felt store root (directory containing .felt/)")
	for _, command := range []*cobra.Command{
		a.shuttleAgentsCmd(),
		a.assignCmd(),
		a.shuttleCheckCmd(),
		a.claimCmd(),
		a.codexDesktopBridgeCmd(),
		a.shuttleContractCmd(),
		a.installCmd(),
		a.repeatCmd(),
		a.shuttleDaemonCmd(),
		a.shuttleVersionCmd(),
		a.shuttleSnapshotCmd(),
		a.shuttleDispatchCmd(),
		a.doctorCmd(),
		a.shuttleFollowCmd(),
		a.shuttleHandoffCmd(),
		a.hookCmd(),
		a.shuttleHostCmd(),
		a.pauseCmd(),
		a.restCmd(),
		a.resumeCmd(),
		a.closeCmd(),
		a.reopenCmd(),
		a.setOutcomeCmd(),
		a.acceptCmd(),
		a.setModelCmd(),
		a.setAgentCmd(),
		a.seatCmd(),
		a.reshapeCmd(),
		a.uninstallShuttleCmd(),
		a.markRuntimeCmd(),
		a.shuttleMessageCmd(),
		a.shuttleSessionsCmd(),
		a.shuttleTranscriptCmd(),
		a.remotesCmd(),
		a.resolveDirCmd(),
		a.shuttleSendFileCmd(),
		a.sessionNameCmd(),
		a.attachCmd(),
		a.statusCmd(),
		a.psCmd(),
		a.tunnelsCmd(),
		a.validateIdentityCmd(),
		feltcli.NewLsCmd(a.env, a.shuttleViewOptions()),
		feltcli.NewShowCmd(a.env, a.shuttleViewOptions()),
	} {
		addShuttleCommand(root, command)
	}
	clistreams.Bind(root, a.env.Stdin, a.env.Stdout, a.env.Stderr)
	return root
}

func addShuttleCommand(root, command *cobra.Command) {
	switch command.Name() {
	case "agents":
		command.GroupID = groupAgents
	case "daemon", "host", "remotes", "tunnels", "version":
		command.GroupID = groupHosts
	default:
		command.GroupID = groupOperations
	}
	root.AddCommand(command)
}

func Execute() { os.Exit(Run(sysenv.OS(), os.Args[1:])) }

// Run executes one shuttle invocation with args in env and returns its exit
// code, printing a failure to env's stderr.
func Run(env *sysenv.Env, args []string) int {
	root := NewRootCmd(env)
	if args == nil {
		args = []string{}
	}
	root.SetArgs(args)
	return exitCode(env, root.Execute())
}

func exitCode(env *sysenv.Env, err error) int {
	if err == nil {
		return 0
	}
	fmt.Fprintln(env.Stderr, err)
	var exitErr *cliExitError
	if errors.As(err, &exitErr) {
		return exitErr.code
	}
	return 1
}

type cliExitError struct {
	code int
	err  error
}

func (e *cliExitError) Error() string { return e.err.Error() }
func (e *cliExitError) Unwrap() error { return e.err }

func init() { cobra.EnableTraverseRunHooks = true }

func (a *app) outputJSON(data interface{}) error {
	enc := json.NewEncoder(a.env.Stdout)
	enc.SetIndent("", "  ")
	if v := reflect.ValueOf(data); v.Kind() == reflect.Slice && v.IsNil() {
		data = reflect.MakeSlice(v.Type(), 0, 0).Interface()
	}
	return enc.Encode(data)
}
