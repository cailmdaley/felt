package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) changeCmd() *cobra.Command {
	var base, head, repo, storyPath, name string
	var check, cache, list bool
	var prNumber int
	cmd := &cobra.Command{
		Use: "change <fiber> [--pr N | --base B | --list]", Short: "Bake a Git change and its reading story into a fiber companion",
		Long: `Snapshot the change since merge-base(base, head) into <name>.change.json beside
the fiber, like a pull request's three-dot diff. No common ancestor is an error.
Runs Git on this host; no daemon or model is needed.
Without --pr or --base, the fiber's shuttle.change names the change: its first PR,
else the checked-out branch as it stands, uncommitted work included, against
shuttle.change.base or the remote's default branch.
With --story, validate every stop and flag and report changed-line coverage. Flags do not
count as coverage. --check validates and reports without writing a companion.
--cache writes the bundle to this host's cache instead of beside the fiber.
--list reads the PRs in shuttle.change.prs from GitHub and bakes nothing.
--json emits the validation and coverage report, not the change bundle; with --list,
the list of PRs.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if list {
				for _, flag := range []string{"pr", "base", "head", "story", "cache", "check", "name"} {
					if cmd.Flags().Changed(flag) {
						return fmt.Errorf("--list cannot be combined with --%s", flag)
					}
				}
			}
			if cmd.Flags().Changed("pr") && (cmd.Flags().Changed("head") || cmd.Flags().Changed("base")) {
				return fmt.Errorf("--pr cannot be combined with --base or --head")
			}
			if cmd.Flags().Changed("pr") && prNumber < 1 {
				return fmt.Errorf("supply a positive --pr N")
			}
			f, st, err := a.shuttleResolveFiber(args[0], true)
			if err != nil {
				return err
			}
			if st == nil {
				return fmt.Errorf("run shuttle change on the host holding the fiber and worktree")
			}
			block, _, err := shuttle.BlockOf(f)
			if err != nil {
				return err
			}
			var spec shuttle.ChangeSpec
			if block != nil {
				if block.Change != nil {
					spec = *block.Change
				}
				if block.Host != "" {
					own, err := a.resolveOwnHost("")
					if err != nil {
						return err
					}
					if own != block.Host {
						return fmt.Errorf("fiber belongs to host %q; run shuttle change there", block.Host)
					}
				}
				if repo == "" && block.ProjectDir != "" {
					repo = filepath.Join(block.ProjectDir, spec.Repo)
				}
			}
			if repo == "" {
				repo, err = a.env.Getwd()
				if err != nil {
					return err
				}
			}
			repo, err = a.resolveProjectDirFlag(repo)
			if err != nil {
				return err
			}
			if list {
				return a.listChangePRs(repo, spec.PRs)
			}
			// Neither --pr nor --base: the fiber names its change.
			branchView := prNumber == 0 && base == ""
			if branchView && len(spec.PRs) > 0 && !cmd.Flags().Changed("head") {
				prNumber, branchView = spec.PRs[0], false
			}
			var pr *shuttle.ChangePR
			if prNumber != 0 {
				pr, base, head, err = shuttle.ResolveChangePR(a.env, repo, prNumber)
				if err != nil {
					return err
				}
				if name == "" {
					name = fmt.Sprintf("pr-%d", prNumber)
				}
			}
			ref := head
			if head == "HEAD" {
				out, err := a.env.Command("git", "-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD").Output()
				if err == nil {
					ref = strings.TrimSpace(string(out))
				}
			}
			// The branch view compares the worktree as it stands.
			revision := head
			if branchView {
				if base = spec.Base; base == "" {
					if base, err = shuttle.DefaultChangeBase(a.env, repo); err != nil {
						return err
					}
				}
				if !cmd.Flags().Changed("head") {
					if revision, err = shuttle.SnapshotWorktree(a.env, repo); err != nil {
						return err
					}
				}
			}
			if name == "" {
				name = felt.Slugify(strings.ReplaceAll(ref, "/", "-"))
				if ref == "HEAD" || name == "" {
					name = filepath.Base(f.ID)
				}
			}
			if name == "." || name == ".." || strings.ContainsAny(name, "/\\") || strings.TrimSpace(name) == "" {
				return fmt.Errorf("--name must be a filename stem, got %q", name)
			}
			fiberPath := f.Path
			if fiberPath == "" {
				fiberPath = st.Path(f.ID)
			}
			sidecar := filepath.Join(filepath.Dir(fiberPath), name+".story.json")
			path := filepath.Join(filepath.Dir(fiberPath), name+".change.json")
			if cache {
				dir, err := a.env.CacheDir()
				if err != nil {
					return err
				}
				path = filepath.Join(dir, "felt", "changes", f.UID, name+".change.json")
			}
			explicitStory := storyPath != ""
			writeStory := explicitStory && !cache
			var story *shuttle.ChangeStory
			var storyData []byte
			if !explicitStory {
				if _, err := os.Stat(sidecar); err == nil {
					storyPath = sidecar
				} else if !os.IsNotExist(err) {
					return err
				} else if !cache {
					data, err := os.ReadFile(path)
					if err == nil {
						var previous shuttle.Change
						if err := json.Unmarshal(data, &previous); err != nil {
							return fmt.Errorf("read existing bundle: %w", err)
						}
						story = previous.Story
						if story != nil {
							storyData, err = json.MarshalIndent(story, "", "  ")
							if err != nil {
								return err
							}
							writeStory = true
						}
					} else if !os.IsNotExist(err) {
						return err
					}
				}
			}
			if storyPath != "" {
				path, err := a.env.Abs(storyPath)
				if err != nil {
					return err
				}
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				storyData = data
				decoder := json.NewDecoder(bytes.NewReader(data))
				decoder.DisallowUnknownFields()
				if err := decoder.Decode(&story); err != nil {
					return fmt.Errorf("read story %s: %w", path, err)
				}
				if err := decoder.Decode(new(any)); err != io.EOF {
					return fmt.Errorf("story %s must contain one JSON object", path)
				}
				if story == nil {
					return fmt.Errorf("story %s must be a JSON object", path)
				}
			}
			change, hunks, err := shuttle.BuildChange(a.env, repo, base, revision, story)
			if err != nil {
				return err
			}
			if revision != head {
				// The snapshot commit stands for the branch; its last real commit names it.
				change.HeadRef = ref
				if n := len(change.Commits); n > 1 && (story == nil || story.Title == "") {
					change.Title = change.Commits[n-2].Subject
				}
			}
			if pr != nil {
				change.PR = pr
				if pr.Body != "" {
					change.Description = pr.Body
				}
				change.Title = pr.Title
				change.HeadRef = pr.HeadBranch
				change.BaseRef = pr.BaseBranch
			}
			var report shuttle.ChangeReport
			if explicitStory {
				report = shuttle.ValidateChange(change, hunks)
			} else {
				report = shuttle.ReapplyChange(change, hunks)
			}
			if report.Valid && !check {
				if writeStory {
					if err := atomicfile.Write(sidecar, storyData, 0644); err != nil {
						return err
					}
				}
				data, err := json.MarshalIndent(change, "", "  ")
				if err != nil {
					return err
				}
				if cache {
					if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
						return err
					}
				}
				if err := atomicfile.Write(path, append(data, '\n'), 0644); err != nil {
					return fmt.Errorf("write change: %w", err)
				}
				// A fiber-addressed receipt needs no native session or worker attribution.
				// SentFiles resolves a raw sessionId equal to the fiber UID directly.
				// A cached bake is the board's own read, not a send.
				if sink, enabled := a.eventsSink(); enabled && !cache {
					origin, err := a.resolveOwnHost("")
					if err != nil {
						return err
					}
					now := a.eventNow().UnixMilli()
					line := eventLine{ID: f.UID + "-" + strconv.FormatInt(now, 10) + "-" + strconv.Itoa(a.eventRand()), Timestamp: now, SessionID: f.UID, CWD: repo, OriginName: origin}
					if err := a.appendFileSent(sink, line, []string{path}, "", false); err != nil {
						return fmt.Errorf("bundle saved but delivery receipt failed: %w", err)
					}
				}
				report.Path = path
			}
			if a.json {
				enc := json.NewEncoder(a.env.Stdout)
				enc.SetIndent("", "  ")
				if err := enc.Encode(report); err != nil {
					return err
				}
			} else {
				fmt.Fprintf(a.env.Stdout, "Changed lines shown: %d of %d\n", report.Covered, report.Total)
				for _, h := range report.Uncovered {
					line := h.NewFrom
					if h.NewLines == 0 {
						line = h.OldFrom
					}
					fmt.Fprintf(a.env.Stdout, "Remaining: %s:%d\n", h.File, line)
				}
				for _, reason := range report.Stale {
					fmt.Fprintf(a.env.Stdout, "Stale: %s\n", reason)
				}
				for _, reason := range report.Dropped {
					fmt.Fprintf(a.env.Stdout, "Dropped: %s\n", reason)
				}
				if report.Path != "" {
					fmt.Fprintf(a.env.Stdout, "Wrote %s\n", report.Path)
				}
			}
			if check && len(report.Stale) > 0 {
				return fmt.Errorf("stale story references:\n  %s", strings.Join(report.Stale, "\n  "))
			}
			if !report.Valid {
				return fmt.Errorf("invalid story:\n  %s", strings.Join(report.Errors, "\n  "))
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&base, "base", "", "Base commit or ref (alternative to --pr; comparison starts at its merge base with head; default shuttle.change)")
	cmd.Flags().StringVar(&head, "head", "HEAD", "Head commit or ref")
	cmd.Flags().StringVar(&repo, "repo", "", "Worktree directory (fiber's shuttle.project_dir with shuttle.change.repo, else cwd)")
	cmd.Flags().StringVar(&storyPath, "story", "", "JSON story with chapters, stops, flags and role overrides")
	cmd.Flags().StringVar(&name, "name", "", "Companion filename stem (head ref, else fiber slug)")
	cmd.Flags().BoolVar(&check, "check", false, "Validate and report without writing")
	cmd.Flags().IntVar(&prNumber, "pr", 0, "GitHub PR number (alternative to --base and --head)")
	cmd.Flags().BoolVar(&cache, "cache", false, "Write the bundle to this host's cache, not beside the fiber")
	cmd.Flags().BoolVar(&list, "list", false, "List the PRs in shuttle.change.prs from GitHub without baking")
	return cmd
}

// listChangePRs prints the PRs a fiber follows, in the order named.
func (a *app) listChangePRs(repo string, numbers []int) error {
	listings := shuttle.ListChangePRs(a.env, repo, numbers)
	if a.json {
		enc := json.NewEncoder(a.env.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(listings)
	}
	for _, pr := range listings {
		if pr.Error != "" {
			fmt.Fprintf(a.env.Stdout, "#%d\t%s\n", pr.Number, pr.Error)
			continue
		}
		state := pr.State
		if pr.Draft {
			state = "DRAFT"
		}
		fmt.Fprintf(a.env.Stdout, "#%d\t%s\t%s → %s\t%s\tchecks %d/%d\t+%d −%d\n", pr.Number, pr.Title, pr.HeadBranch, pr.BaseBranch, state, pr.Checks.Passed, pr.Checks.Total, pr.Additions, pr.Deletions)
	}
	return nil
}
