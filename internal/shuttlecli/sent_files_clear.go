package shuttlecli

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) shuttleSentFilesCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "sent-files", Short: "Manage the sent-files trail"}
	clear := &cobra.Command{
		Use: "clear <fiber> [--path <file>]", Short: "Hide a fiber's sent files without deleting them",
		Long: `Record a sent_files_cleared event for the fiber's canonical UID on this host.
Sends at or before this clear are hidden; newer sends appear normally.
With --path, only that exact absolute fullPath is hidden; the path is not expanded.
Files on disk and embeds in the fiber body are untouched. Recording works offline.
A fiber assigned to another host must be cleared there, or through the board.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			raw, _ := cmd.Flags().GetBool("uid")
			local, _ := cmd.Flags().GetBool("local")
			path, _ := cmd.Flags().GetString("path")
			if cmd.Flags().Changed("path") && !filepath.IsAbs(path) {
				return fmt.Errorf("path must be a nonempty absolute path")
			}
			uid := args[0]
			if raw {
				if !local {
					return fmt.Errorf("--uid requires --local; it addresses this host's stream directly")
				}
			} else {
				fiber, _, err := a.shuttleResolveFiber(args[0], false)
				if err != nil {
					return err
				}
				uid = fiber.UID
				block, ok, err := shuttle.BlockOf(fiber)
				if err != nil {
					return err
				}
				if ok && strings.TrimSpace(block.Host) != "" {
					own, err := a.resolveOwnHost("")
					if err != nil {
						return err
					}
					if block.Host != own {
						return fmt.Errorf("fiber %q belongs to host %q; run shuttle sent-files clear there, or use Clear in the board gallery", args[0], block.Host)
					}
				}
			}
			if err := a.clearSentFiles(uid, path); err != nil {
				return err
			}
			if path != "" {
				fmt.Fprintf(a.env.Stdout, "Cleared sent file %s for %s (file on disk is untouched)\n", path, uid)
			} else {
				fmt.Fprintf(a.env.Stdout, "Cleared sent files for %s (files on disk are untouched)\n", uid)
			}
			return nil
		},
	}
	clear.Flags().Bool("uid", false, "Treat the argument as a raw fiber UID (daemon only; requires --local)")
	_ = clear.Flags().MarkHidden("uid")
	clear.Flags().String("path", "", "Clear only this exact absolute fullPath (not expanded)")
	clear.Flags().Bool("local", false, "Address the local stream (does not bypass fiber host checks)")
	cmd.AddCommand(clear)
	return cmd
}

func (a *app) clearSentFiles(uid, path string) error {
	if path != "" && !filepath.IsAbs(path) {
		return fmt.Errorf("path must be an absolute path")
	}
	if !felt.LooksLikeUID(uid) || uid != strings.ToUpper(uid) {
		return fmt.Errorf("uid must be a canonical fiber ULID")
	}
	origin, err := a.resolveOwnHost("")
	if err != nil {
		return err
	}
	timestamp := a.eventNow().UnixMilli()
	event := struct {
		eventLine
		UID  string `json:"uid"`
		Path string `json:"path,omitempty"`
	}{eventLine: eventLine{
		ID:        "sent-files-cleared-" + strconv.FormatInt(timestamp, 10) + "-" + strconv.Itoa(a.eventRand()),
		Timestamp: timestamp, Type: "sent_files_cleared", OriginName: origin,
	}, UID: uid, Path: path}
	line, err := encodeJSONLine(event)
	if err != nil {
		return err
	}
	sink, enabled := a.eventsSink()
	if !enabled {
		return fmt.Errorf("Shuttle event recording is disabled or its state directory is missing")
	}
	if err := a.appendEventLine(sink, line); err != nil {
		return fmt.Errorf("record sent-files clear: %w", err)
	}
	return nil
}
