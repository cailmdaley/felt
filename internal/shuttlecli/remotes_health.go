package shuttlecli

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// remoteListingRow keeps observed state out of the configuration writer.
// RawMessage preserves fields added by newer daemons, including recovery.
type remoteListingRow struct {
	remoteSpec
	Health json.RawMessage `json:"health"`
	Build  json.RawMessage `json:"build"`
}

func (a *app) fetchRemoteReach() (map[string]remoteListingRow, error) {
	endpoint, err := a.daemonEndpoint("/api/v1/fleet")
	if err != nil {
		return nil, err
	}
	body, err := a.getDaemon(endpoint, discoveryReadTimeout)
	if err != nil {
		return nil, err
	}
	var fleet struct {
		Remotes []remoteListingRow `json:"remotes"`
	}
	if err := json.Unmarshal(body, &fleet); err != nil {
		return nil, fmt.Errorf("decoding %s: %w", endpoint, err)
	}
	rows := make(map[string]remoteListingRow, len(fleet.Remotes))
	for _, row := range fleet.Remotes {
		rows[row.Name] = row
	}
	return rows, nil
}

func (r remoteListingRow) reach(now time.Time) string {
	var health struct {
		Polled    bool   `json:"polled"`
		Stale     bool   `json:"stale"`
		LastError string `json:"last_error"`
	}
	if len(r.Health) == 0 || string(r.Health) == "null" || json.Unmarshal(r.Health, &health) != nil {
		return "?"
	}
	if !health.Polled {
		return "unpolled"
	}
	if health.Stale {
		message := strings.Join(strings.Fields(health.LastError), " ")
		text := []rune(message)
		if len(text) > 80 {
			message = string(text[:79]) + "…"
		}
		if message == "" {
			return "stale"
		}
		return "stale " + message
	}
	var build struct {
		SHA      string `json:"git_short_sha"`
		BootedAt string `json:"booted_at"`
	}
	_ = json.Unmarshal(r.Build, &build)
	if build.SHA == "" {
		build.SHA = "?"
	}
	uptime := "?"
	if booted, err := time.Parse(time.RFC3339, build.BootedAt); err == nil {
		duration := now.Sub(booted)
		if duration < 0 {
			duration = 0
		}
		uptime = duration.Round(time.Second).String()
	}
	return fmt.Sprintf("healthy %s up %s", build.SHA, uptime)
}
