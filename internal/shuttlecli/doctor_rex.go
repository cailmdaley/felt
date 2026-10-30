package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
)

// Rex health is read-only: every request disables autostart and no request
// selects a session, starts an app, or changes a privacy grant.
func (a *app) collectRexReceipt() *ReceiptRex {
	terminal, err := a.hostTerminal()
	if err != nil || terminal != "rex" {
		// Host configuration errors belong to the host receipt.
		return nil
	}
	rec := &ReceiptRex{Status: receiptHealthy, Privacy: map[string]string{}}
	r := &rexTerminal{a: a}
	out, err := r.command("", "whoami", "--json")
	if err != nil {
		rec.Status = receiptPartial
		if errors.Is(err, errRexAbsent) || errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			rec.Status = receiptMissing
		}
		rec.Repair = fmt.Sprintf("open Rex and check its server connection: %v", err)
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
	fmt.Fprintf(a.env.Stdout, "Rex: %s (reachable=%t, version=%s, app client=%t)\n", rec.Status, rec.Reachable, rec.Version, rec.AppClient)
	if len(rec.Privacy) > 0 {
		fmt.Fprintf(a.env.Stdout, "  Rex Server Full Disk Access: %s\n", rec.Privacy["full_disk_access"])
	}
	if rec.Warning != "" {
		fmt.Fprintf(a.env.Stdout, "warning: %s\n", rec.Warning)
	}
	if rec.Repair != "" {
		fmt.Fprintf(a.env.Stdout, "  Rex: %s\n", rec.Repair)
	}
}
