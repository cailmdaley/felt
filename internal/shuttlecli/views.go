package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/feltcli"
	"github.com/cailmdaley/felt/internal/sysenv"
)

func shuttleViewOptions() feltcli.ViewOptions {
	return feltcli.ViewOptions{
		Binary: "shuttle",
		Directory: func() string {
			return changeDir
		},
		IsJSON: func() bool {
			return jsonOutput
		},
		Decorate: resolveShuttleJSON,
	}
}

func init() {
	addShuttleCommand(feltcli.NewLsCmd(sysenv.OS(), shuttleViewOptions()))
	addShuttleCommand(feltcli.NewShowCmd(sysenv.OS(), shuttleViewOptions()))
}
