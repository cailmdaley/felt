package shuttlecli

import "github.com/cailmdaley/felt/internal/feltcli"

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
	addShuttleCommand(feltcli.NewLsCmd(shuttleViewOptions()))
	addShuttleCommand(feltcli.NewShowCmd(shuttleViewOptions()))
}
