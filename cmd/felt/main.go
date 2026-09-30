package main

import "github.com/cailmdaley/felt/internal/feltcli"

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	feltcli.SetVersionInfo(version, commit, date)
	feltcli.Execute()
}
