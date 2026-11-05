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
	var check bool
	cmd := &cobra.Command{
		Use: "change <fiber> --base B", Short: "Bake a Git change and its reading story into a fiber companion",
		Long: `Snapshot the change since merge-base(base, head) into <name>.change.json beside
the fiber, like a pull request's three-dot diff. No common ancestor is an error.
Runs Git on this host; no daemon or model is needed.
With --story, validate every stop and flag and report hunk coverage. Flags do not
count as coverage. --check validates and reports without writing a companion.
--json emits the validation and coverage report, not the change bundle.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
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
			if block != nil {
				if block.Host != "" {
					own, err := a.resolveOwnHost("")
					if err != nil {
						return err
					}
					if own != block.Host {
						return fmt.Errorf("fiber belongs to host %q; run shuttle change there", block.Host)
					}
				}
				if repo == "" {
					repo = block.ProjectDir
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
			var story *shuttle.ChangeStory
			if storyPath != "" {
				path, err := a.env.Abs(storyPath)
				if err != nil {
					return err
				}
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
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
			change, hunks, err := shuttle.BuildChange(a.env, repo, base, head, story)
			if err != nil {
				return err
			}
			report := shuttle.ValidateChange(change, hunks)
			if name == "" {
				name = felt.Slugify(strings.ReplaceAll(change.HeadRef, "/", "-"))
				if change.HeadRef == "HEAD" || name == "" {
					name = filepath.Base(f.ID)
				}
			}
			if name == "." || name == ".." || strings.ContainsAny(name, "/\\") || strings.TrimSpace(name) == "" {
				return fmt.Errorf("--name must be a filename stem, got %q", name)
			}
			path := f.Path
			if path == "" {
				path = st.Path(f.ID)
			}
			path = filepath.Join(filepath.Dir(path), name+".change.json")
			if report.Valid && !check {
				data, err := json.MarshalIndent(change, "", "  ")
				if err != nil {
					return err
				}
				if err := atomicfile.Write(path, append(data, '\n'), 0644); err != nil {
					return fmt.Errorf("write change: %w", err)
				}
				// A fiber-addressed receipt needs no native session or worker attribution.
				// SentFiles resolves a raw sessionId equal to the fiber UID directly.
				if sink, enabled := a.eventsSink(); enabled {
					origin, err := a.resolveOwnHost("")
					if err != nil {
						return err
					}
					now := a.eventNow().UnixMilli()
					event := struct {
						eventLine
						Files []string `json:"files"`
					}{eventLine: eventLine{ID: f.UID + "-" + strconv.FormatInt(now, 10) + "-" + strconv.Itoa(a.eventRand()), Timestamp: now, Type: "file_sent", SessionID: f.UID, CWD: repo, OriginName: origin}, Files: []string{path}}
					line, err := encodeJSONLine(event)
					if err != nil {
						return err
					}
					if err := a.appendEventLine(sink, line); err != nil {
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
				fmt.Fprintf(a.env.Stdout, "Hunks covered: %d of %d\n", report.Covered, report.Total)
				for _, h := range report.Partial {
					fmt.Fprintf(a.env.Stdout, "Partial: %s:%d (widen one stop to show every changed line)\n", h.File, h.NewFrom)
				}
				for _, h := range report.Uncovered {
					line := h.NewFrom
					if h.NewLines == 0 {
						line = h.OldFrom
					}
					fmt.Fprintf(a.env.Stdout, "Remaining: %s:%d\n", h.File, line)
				}
				if report.Path != "" {
					fmt.Fprintf(a.env.Stdout, "Wrote %s\n", report.Path)
				}
			}
			if !report.Valid {
				return fmt.Errorf("invalid story:\n  %s", strings.Join(report.Errors, "\n  "))
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&base, "base", "", "Base commit or ref (required; comparison starts at its merge base with head)")
	cmd.Flags().StringVar(&head, "head", "HEAD", "Head commit or ref")
	cmd.Flags().StringVar(&repo, "repo", "", "Worktree directory (fiber's shuttle.project_dir, else cwd)")
	cmd.Flags().StringVar(&storyPath, "story", "", "JSON story with chapters, stops, flags and role overrides")
	cmd.Flags().StringVar(&name, "name", "", "Companion filename stem (head ref, else fiber slug)")
	cmd.Flags().BoolVar(&check, "check", false, "Validate and report without writing")
	_ = cmd.MarkFlagRequired("base")
	return cmd
}
