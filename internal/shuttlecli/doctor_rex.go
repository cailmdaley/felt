package shuttlecli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// Rex health is read-only: every request disables autostart and no request
// selects a session, starts an app, or changes a privacy grant.
const (
	rexTitleHelperGranted    = "granted"
	rexTitleHelperNotGranted = "not_granted"
	rexTitleHelperMissing    = "missing"
	rexTitleHelperFailed     = "failed"
)

func (a *app) collectRexReceipt() *ReceiptRex {
	terminal, err := a.hostTerminal()
	if err != nil || terminal != "rex" {
		// Host configuration errors belong to the host receipt.
		return nil
	}
	rec := &ReceiptRex{Status: receiptHealthy, Privacy: map[string]string{}}
	if a.hostGOOS != "darwin" {
		up := a.rexTailnetListener()
		rec.TailnetListener = &up
	}
	r := &rexTerminal{a: a}
	out, err := r.command("", "whoami", "--json")
	if err != nil {
		rec.Status = receiptPartial
		if errors.Is(err, errRexAbsent) || errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			rec.Status = receiptMissing
		}
		if a.hostGOOS == "darwin" {
			rec.Repair = fmt.Sprintf("open Rex and check its server connection: %v", err)
		} else {
			rec.Repair = fmt.Sprintf("check the Rex installation and daemon log; Shuttle starts a missing server when launching workers: %v", err)
		}
		return rec
	}
	var server struct {
		Version string `json:"rex_version"`
	}
	if err := json.Unmarshal(out, &server); err != nil || server.Version == "" {
		rec.Status, rec.Repair = receiptPartial, "Rex returned an invalid server identity; check the Rex installation"
		return rec
	}
	rec.Reachable, rec.Version = true, server.Version

	if a.hostGOOS != "darwin" {
		return rec
	}

	var privacy struct {
		Services *[]struct {
			Service string `json:"service"`
			Status  string `json:"status"`
		} `json:"services"`
		ResponsiblePath string `json:"responsible_path"`
	}
	out, err = r.command("{}", "api", "call", "server.apple.privacy_status", "-")
	if err == nil {
		err = json.Unmarshal(out, &privacy)
	}
	if err != nil || privacy.Services == nil {
		rec.Status, rec.Repair = receiptPartial, "cannot read Rex Server privacy services; check the Rex installation and server connection"
	} else {
		rec.ResponsiblePath = privacy.ResponsiblePath
		for _, service := range *privacy.Services {
			if service.Service != "" && service.Status != "" {
				rec.Privacy[service.Service] = service.Status
			}
		}
		if rec.Privacy["full_disk_access"] == "" {
			rec.Status, rec.Repair = receiptPartial, "Rex returned no Full Disk Access status; check the Rex installation"
		}
	}
	if rec.Privacy["full_disk_access"] != "granted" {
		rec.Warning = "grant Rex Server Full Disk Access in macOS System Settings; its workers inherit Rex Server's privacy grants"
	}
	rec.TitleHelper = a.rexTitleHelper()
	if warning := rexTitleHelperWarning(rec.TitleHelper); warning != "" {
		rec.Warning = strings.TrimPrefix(rec.Warning+"; "+warning, "; ")
	}

	var clients struct {
		Clients *[]struct {
			Info struct {
				Kind string `json:"kind"`
			} `json:"info"`
		} `json:"clients"`
	}
	out, err = r.command("", "client", "ls", "--json")
	if err == nil {
		err = json.Unmarshal(out, &clients)
	}
	if err != nil || clients.Clients == nil {
		rec.Status = receiptPartial
		if rec.Repair != "" {
			rec.Repair += "; "
		}
		rec.Repair += "cannot read Rex clients; check the Rex server connection"
	} else {
		for _, client := range *clients.Clients {
			if client.Info.Kind == "app" {
				rec.AppClient = true
			}
		}
	}
	return rec
}

func (a *app) printRexReceipt(rec *ReceiptRex) {
	if rec == nil {
		return
	}
	if rec.TailnetListener != nil {
		fmt.Fprintf(a.env.Stdout, "Rex: %s (reachable=%t, version=%s, tailnet listener :7297=%t)\n", rec.Status, rec.Reachable, rec.Version, *rec.TailnetListener)
	} else {
		fmt.Fprintf(a.env.Stdout, "Rex: %s (reachable=%t, version=%s, app client=%t)\n", rec.Status, rec.Reachable, rec.Version, rec.AppClient)
	}
	if len(rec.Privacy) > 0 {
		fmt.Fprintf(a.env.Stdout, "  Rex Server Full Disk Access: %s\n", rec.Privacy["full_disk_access"])
	}
	if rec.TitleHelper != "" {
		fmt.Fprintf(a.env.Stdout, "  Rex session following: %s\n", rec.TitleHelper)
	}
	if rec.Warning != "" {
		fmt.Fprintf(a.env.Stdout, "warning: %s\n", rec.Warning)
	}
	if rec.Repair != "" {
		fmt.Fprintf(a.env.Stdout, "  Rex: %s\n", rec.Repair)
	}
}

// The helper disclaims responsibility for itself, so its exit status reports its
// own Accessibility grant from any caller.
func probeRexTitleHelper(env *sysenv.Env) string {
	home, err := env.UserHomeDir()
	if err != nil {
		return rexTitleHelperMissing
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = env.CommandContext(ctx, filepath.Join(home, ".local", "bin", "shuttle-rex-title")).Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return rexTitleHelperGranted
	case errors.Is(err, os.ErrNotExist):
		return rexTitleHelperMissing
	case errors.As(err, &exit) && exit.ExitCode() == 3:
		return rexTitleHelperNotGranted
	default:
		return rexTitleHelperFailed
	}
}

func rexTitleHelperWarning(state string) string {
	switch state {
	case rexTitleHelperMissing:
		return "Rex session following needs ~/.local/bin/shuttle-rex-title; run make cli-install in a felt checkout"
	case rexTitleHelperNotGranted:
		return "run ~/.local/bin/shuttle-rex-title --prompt and allow it so voice follows the Rex session in view"
	case rexTitleHelperFailed:
		return "~/.local/bin/shuttle-rex-title failed; voice follows Rex tab changes only"
	}
	return ""
}

// A direct loopback request has no Tailscale identity. Rex's tailnet listener
// refuses it with this response; a successful probe does not prove remote reachability.
func probeRexTailnetListener(endpoint string) bool {
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	resp, err := client.Get(endpoint)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct {
		Error string `json:"error"`
	}
	return resp.StatusCode == http.StatusForbidden && json.NewDecoder(resp.Body).Decode(&body) == nil && body.Error == "connection was not classified by its listener"
}
