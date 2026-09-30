package main

import "github.com/cailmdaley/felt/internal/shuttlecli"

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	shuttlecli.SetVersionInfo(version, commit, date)
	shuttlecli.Execute()
}
