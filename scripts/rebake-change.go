//go:build ignore

// Rebake a captured change's commits and story from this repository.
package main

import (
	"encoding/json"
	"fmt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv"
	"os"
)

func main() {
	if len(os.Args) != 4 {
		panic("usage: rebake-change source destination repo")
	}
	data, err := os.ReadFile(os.Args[1])
	must(err)
	var old shuttle.Change
	must(json.Unmarshal(data, &old))
	change, hunks, err := shuttle.BuildChange(sysenv.New(os.Args[3], os.Environ()), os.Args[3], old.Base, old.Head, old.Story)
	must(err)
	report := shuttle.ValidateChange(change, hunks)
	if !report.Valid {
		panic(report.Errors)
	}
	change.BaseRef, change.HeadRef, change.Title = old.BaseRef, old.HeadRef, old.Title
	change.Repo, change.Commits = old.Repo, old.Commits
	data, err = json.MarshalIndent(change, "", "  ")
	must(err)
	must(os.WriteFile(os.Args[2], append(data, '\n'), 0644))
	fmt.Printf("%s: %d bytes, %d changed lines\n", os.Args[2], len(data)+1, report.Total)
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
