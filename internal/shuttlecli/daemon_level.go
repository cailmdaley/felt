package shuttlecli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// A daemon delivers through the CLI beside it: it shells `felt` and `shuttle`
// for every inbox write and delivery. A daemon built for another CLI contract
// level shells verbs this CLI does not have, or misreads requests this CLI
// sends: a fiber message it accepts waits in the fiber's inbox, undelivered,
// until a daemon at this level runs. These checks
// compare the daemon's build level (contract_level in /api/v1/version, the
// level its Contract module expects) with ShuttleContractLevel.

// daemonBuild is what a daemon's /api/v1/version says it was built as, and
// its receipt of the CLIs it shells.
type daemonBuild struct {
	Host     string `json:"host"`
	Version  string `json:"mix_vsn"`
	Level    int    `json:"contract_level"`
	Contract *struct {
		OK     *bool  `json:"ok"`
		Reason string `json:"reason"`
	} `json:"contract"`
}

// skewed reports whether the daemon's own receipt says the CLIs beside it are
// at another contract level than it was built for.
func (b daemonBuild) skewed() bool {
	return b.Contract != nil && b.Contract.OK != nil && !*b.Contract.OK
}

// matches reports whether the daemon shells this CLI's contract.
func (b daemonBuild) matches() bool { return b.Level == ShuttleContractLevel }

func (b daemonBuild) describe() string {
	version := b.Version
	if version == "" {
		version = "an unknown version"
	}
	if b.Level == 0 {
		return version + ", which reports no CLI contract level"
	}
	return fmt.Sprintf("%s (CLI contract %d)", version, b.Level)
}

// daemonBuildAt reads the local daemon's build, or with an origin the build
// of the daemon the local one routes that host to.
func (a *app) daemonBuildAt(origin string) (daemonBuild, error) {
	endpoint, err := a.daemonEndpoint("/api/v1/version")
	if err != nil {
		return daemonBuild{}, err
	}
	if origin != "" {
		endpoint += "?origin=" + url.QueryEscape(origin)
	}
	body, err := a.getDaemon(endpoint, daemonReadTimeout)
	if err != nil {
		return daemonBuild{}, err
	}
	var build daemonBuild
	if err := json.Unmarshal(body, &build); err != nil {
		return daemonBuild{}, fmt.Errorf("reading the daemon's version from %s: %w", endpoint, err)
	}
	return build, nil
}

// cliDescription names this CLI the way describe names a daemon.
func (a *app) cliDescription() string {
	return fmt.Sprintf("%s (CLI contract %d)", a.version, ShuttleContractLevel)
}

// levelCommand is what brings this host's daemon level with these CLIs: the
// upgrade verb for a fetched release, a deploy for one built from a checkout.
func (a *app) levelCommand() string {
	if release, err := a.findDaemonRelease(); err == nil && !fetchedRelease(release.Dir) {
		return "bin/shuttle-deploy --hosts local, from the checkout that built " + release.Dir
	}
	return "shuttle daemon upgrade"
}

// fetchedRelease reports whether dir is a release the installer or
// `shuttle daemon upgrade` unpacked, rather than one a checkout built: a
// checkout builds its releases inside its own bin/ directory.
func fetchedRelease(dir string) bool {
	return filepath.Base(filepath.Dir(dir)) != "bin"
}

// requireDeliveringDaemon refuses a fiber message the daemons on its path
// would queue and not deliver: the local daemon, which takes the request and
// must be built for this CLI's contract, and the owner it routes to, which
// delivers through its own CLIs and is refused only when its receipt says
// they are skewed. A daemon that cannot be reached, or an owner whose answer
// carries no receipt, is left for the request itself to report.
func (a *app) requireDeliveringDaemon(owner string) error {
	local, err := a.daemonBuildAt("")
	if err != nil {
		return nil
	}
	if !local.matches() {
		fix := "Bring the daemon level with `" + a.levelCommand() + "`, then send again"
		if release, err := a.findDaemonRelease(); err == nil && !fetchedRelease(release.Dir) {
			fix = "A deploy in progress brings it level when it finishes, so send again then; with none running, deploy it: " + a.levelCommand()
		}
		return fmt.Errorf("the Shuttle daemon on this host runs %s and this shuttle is %s: it would queue this message without delivering it. %s", local.describe(), a.cliDescription(), fix)
	}
	if owner == "" || owner == local.Host {
		return nil
	}
	remote, err := a.daemonBuildAt(owner)
	if err != nil || !remote.skewed() {
		return nil
	}
	return fmt.Errorf("%s's Shuttle daemon runs %s and reports its CLIs skewed (%s): it would queue this message without delivering it. Bring %s's daemon level with its CLIs, then send again", owner, remote.describe(), remote.Contract.Reason, owner)
}

// daemonLevelNotice says how this host's daemon differs from these CLIs, or
// returns "" when it matches or none is installed. A running daemon is
// judged by what it reports; a stopped one by the release it would start.
func (a *app) daemonLevelNotice() string {
	if running, err := a.daemonBuildAt(""); err == nil {
		versionDiffers := a.version != "dev" && running.Version != a.version
		if running.matches() && !versionDiffers {
			return ""
		}
		notice := fmt.Sprintf("The Shuttle daemon running on this host is %s; these CLIs are %s.", running.describe(), a.cliDescription())
		if !running.matches() {
			notice += " Until they match, messages to live workers are queued and not delivered."
		}
		return notice + "\nBring it level: " + a.levelCommand() + "\n"
	}
	release, err := a.findDaemonRelease()
	if err != nil || a.version == "dev" {
		return ""
	}
	installed := a.releaseVersion(release)
	if installed == a.version {
		return ""
	}
	if installed == "" {
		installed = "an unknown version"
	}
	return fmt.Sprintf("The Shuttle daemon release installed at %s is %s; these CLIs are %s.\nBring it level before starting it: %s\n", release.Dir, installed, a.version, a.levelCommand())
}

// releaseVersion is the version a release's launcher reports, "" when it
// cannot say. The launcher's version verb reads a file and starts no VM.
func (a *app) releaseVersion(release daemonRelease) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := a.env.CommandContext(ctx, release.Launcher, "version").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return ""
	}
	return fields[len(fields)-1]
}

func (a *app) daemonCheckCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "check",
		Short: "Say whether this host's daemon matches these CLIs, and what brings it level",
		Long: `Compares the daemon on this host with these CLIs. A running daemon is
judged by its /api/v1/version: the CLI contract level it was built to shell and
its release version. A stopped one is judged by the version of the release it
would start. When they differ, prints both and the command that brings the
daemon level; prints nothing when they match or no daemon is installed. Always
exits 0. felt update runs it after replacing the CLIs.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			_, err := fmt.Fprint(a.env.Stdout, a.daemonLevelNotice())
			return err
		},
	}
}
