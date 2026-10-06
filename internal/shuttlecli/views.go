package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/feltcli"
)

func (a *app) shuttleViewOptions() feltcli.ViewOptions {
	return feltcli.ViewOptions{
		Binary: "shuttle",
		Directory: func() string {
			return a.dir
		},
		IsJSON: func() bool {
			return a.json
		},
		Decorate: a.resolveShuttleJSON,
	}
}
