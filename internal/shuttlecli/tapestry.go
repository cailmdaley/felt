package shuttlecli

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// tapestry is a fiber's tapestry.html and the addresses that show it.
type tapestry struct {
	Fiber  string `json:"fiber"`
	UID    string `json:"uid"`
	Host   string `json:"host"`
	Exists bool   `json:"exists"`
	// Path is the copy on this machine; for a fiber another host owns it is
	// the Git copy.
	Path      string `json:"path"`
	FileURL   string `json:"file_url"`
	ThreadURL string `json:"thread_url"`
	// Source is local (this host owns the fiber), owner, or local_fallback: a
	// Git copy here, answering for an owner that could not be reached.
	Source string `json:"source"`

	// noURL is why a URL is missing.
	noURL error
}

func (a *app) tapestryCmd() *cobra.Command {
	var path, link, open bool
	cmd := &cobra.Command{
		Use:   "tapestry <fiber>",
		Short: "Find, print or open a fiber's tapestry",
		Long: `Report whether a fiber has a tapestry.html, its path on this machine, the URL
the local daemon serves it at, and the fiber's thread page. The fiber resolves
from any directory and must match exactly.

A fiber another host owns is read from its owner, so a tapestry that was never
synced here still has a URL. When the owner cannot be reached, a Git copy here
answers with a warning. URLs are empty when the local daemon is unreachable or
listens on a unix socket.

  --path   print only the local path; fails when there is no copy here
  --url    print only the tapestry's URL, or the thread page's when the fiber
           has no tapestry; fails when no URL reaches it
  --open   open it with the OS opener: the local file, or the owner's URL for
           a fiber another host owns
  --json   {fiber, uid, host, exists, path, file_url, thread_url, source};
           source is local, owner, or local_fallback for that Git copy`,
		Example: `  shuttle tapestry bao-analysis
  shuttle tapestry bao-analysis --open`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.json && (path || link || open) {
				return errors.New("--json cannot be combined with --path, --url or --open")
			}
			fiber, err := a.resolveOwnedFiber(args[0])
			if err != nil {
				return err
			}
			t, err := a.findTapestry(fiber, !path && !open)
			if err != nil {
				return err
			}
			switch {
			case a.json:
				return a.outputJSON(t)
			case path:
				if t.Path != "" {
					fmt.Fprintln(a.env.Stdout, t.Path)
					return nil
				}
				if t.Exists {
					return fmt.Errorf("%s's tapestry is on %s, with no copy here; use --url", t.Fiber, t.Host)
				}
				return t.missing()
			case link:
				address := t.FileURL
				if !t.Exists {
					address = t.ThreadURL
				}
				if address == "" {
					return fmt.Errorf("no URL for %s: %w", t.Fiber, t.noURL)
				}
				fmt.Fprintln(a.env.Stdout, address)
				return nil
			case open:
				return a.openTapestry(t, fiber.Remote)
			}
			a.printTapestry(t)
			return nil
		},
	}
	cmd.Flags().BoolVar(&path, "path", false, "Print only the local path")
	cmd.Flags().BoolVar(&link, "url", false, "Print only the URL")
	cmd.Flags().BoolVar(&open, "open", false, "Open it with the OS opener")
	cmd.MarkFlagsMutuallyExclusive("path", "url", "open")
	return cmd
}

func (t tapestry) missing() error {
	return fmt.Errorf("%s has no %s on %s", t.Fiber, felt.CompanionNames[0], t.Host)
}

// findTapestry looks for fiber's tapestry on its owner. Without urls, a fiber
// this host owns is answered from disk and the daemon is not asked.
func (a *app) findTapestry(fiber ownedFiber, urls bool) (tapestry, error) {
	t := tapestry{Fiber: fiber.ID, UID: fiber.UID, Host: fiber.Host, Source: "local"}
	if fiber.Path != "" {
		path := filepath.Join(filepath.Dir(fiber.Path), felt.CompanionNames[0])
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			t.Path = path
		}
	}

	ownerPath, reachable, err := t.Path, true, error(nil)
	if fiber.Remote {
		t.Source = "owner"
		ownerPath, err = a.ownerTapestryPath(fiber)
		// The local daemon still serves pages when its owner read fails.
		var refused daemonStatusError
		reachable = err == nil || errors.As(err, &refused)
	} else if urls {
		var endpoint string
		if endpoint, err = a.daemonEndpoint("/api/v1/version"); err == nil {
			_, err = a.getDaemon(endpoint, daemonReadTimeout)
		}
		reachable = err == nil
	}
	t.Exists = ownerPath != ""
	if fiber.Remote && err != nil {
		// Only silence lets a copy speak for the owner; a refusal is its answer.
		if t.Path == "" || !ownerReadUnavailable(err, t.Host) {
			return t, fmt.Errorf("reading %s from its owner %q: %w", t.Fiber, t.Host, err)
		}
		fmt.Fprintf(a.env.Stderr, "warning: owner %q did not answer (%v); showing this host's Git copy, which may be stale\n", t.Host, err)
		t.Exists, t.Source = true, "local_fallback"
	} else if fiber.Remote && ownerPath == "" {
		// The owner holds none, so a copy here is a leftover.
		t.Path = ""
	}
	if !fiber.Remote && !urls {
		return t, nil
	}

	base, baseErr := a.browserURL()
	switch {
	case baseErr != nil:
		t.noURL = baseErr
	case !reachable:
		t.noURL = err
	default:
		t.ThreadURL = base + "/thread?f=" + url.QueryEscape(t.UID) + "@" + url.QueryEscape(t.Host)
		if ownerPath != "" {
			t.FileURL = fileURL(base, ownerPath, t.Host)
		}
		t.noURL = err
	}
	return t, nil
}

// ownerTapestryPath is the tapestry's path on the host that owns fiber, or ""
// when the owner holds none.
func (a *app) ownerTapestryPath(fiber ownedFiber) (string, error) {
	endpoint, err := a.daemonEndpoint("/api/v1/fibers/" + url.PathEscape(fiber.UID))
	if err != nil {
		return "", err
	}
	endpoint += "?" + url.Values{"origin": {fiber.Host}}.Encode()
	response, err := getDaemonJSON[struct {
		Fibers []struct {
			ReportPath string `json:"report_path"`
		} `json:"fibers"`
	}](a, endpoint, "parsing owner fiber")
	if err != nil {
		return "", err
	}
	if len(response.Fibers) != 1 {
		return "", fmt.Errorf("owner %q returned %d fibers for %s", fiber.Host, len(response.Fibers), fiber.UID)
	}
	// The report path names the first companion present, and a tapestry is
	// first among companions.
	if report := response.Fibers[0].ReportPath; filepath.Base(report) == felt.CompanionNames[0] {
		return report, nil
	}
	return "", nil
}

func (a *app) printTapestry(t tapestry) {
	row := func(label, value string) {
		if value != "" {
			fmt.Fprintf(a.env.Stdout, "%-9s%s\n", label, value)
		}
	}
	state := "none"
	if t.Exists {
		state = "exists"
	}
	row("tapestry", fmt.Sprintf("%s (%s on %s)", state, t.Fiber, t.Host))
	row("path", t.Path)
	row("file", t.FileURL)
	row("thread", t.ThreadURL)
	if t.ThreadURL == "" {
		row("url", "none: "+t.noURL.Error())
	}
}

// openTapestry opens the owner's tapestry: the file here when this host owns
// the fiber, else its URL, else this host's Git copy.
func (a *app) openTapestry(t tapestry, remote bool) error {
	if !t.Exists {
		return t.missing()
	}
	target := t.Path
	if remote && t.FileURL != "" {
		target = t.FileURL
	}
	if target == "" {
		return fmt.Errorf("no URL for %s: %w", t.Fiber, t.noURL)
	}
	if a.hostGOOS == "darwin" {
		if out, err := a.env.Command("open", target).CombinedOutput(); err != nil {
			if detail := strings.TrimSpace(string(out)); detail != "" {
				err = fmt.Errorf("%w: %s", err, detail)
			}
			return fmt.Errorf("open %s: %w", target, err)
		}
	} else if err := a.env.Command("xdg-open", target).Start(); err != nil {
		// xdg-open can stay in the foreground as long as the browser it starts,
		// so it runs on, without this process's streams.
		return fmt.Errorf("xdg-open %s: %w", target, err)
	}
	fmt.Fprintln(a.env.Stdout, "opening", target)
	return nil
}
