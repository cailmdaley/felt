package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

// Remote paths belong to the destination's environment and filesystem.
func (a *app) resolveThreadProjectDir(cmd *cobra.Command, args []string, host, raw string) (string, error) {
	own, err := a.resolveOwnHost("")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(host) == "" || strings.TrimSpace(host) == own {
		return a.resolveProjectDirFlag(raw)
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("--project-dir is required")
	}
	warn := func(reason error) (string, error) {
		fmt.Fprintf(a.env.Stderr, "warning: project_dir %q was not validated on %q (%v); kept verbatim. Validate it on the owner before dispatch.\n", raw, host, reason)
		return raw, nil
	}
	owner, err := a.routeOwnerForCommand(cmd, args, host)
	if err != nil {
		return warn(err)
	}
	endpoint, err := a.daemonEndpoint("/api/v1/project-dir/resolve")
	if err != nil {
		return warn(err)
	}
	payload, _ := json.Marshal(map[string]string{"origin": owner, "path": raw})
	body, err := a.postRouted(owner, endpoint, payload)
	if err != nil {
		var status daemonStatusError
		if errors.As(err, &status) && status.status >= 400 && status.status < 500 && status.status != 404 {
			return "", err
		}
		return warn(err)
	}
	var result struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.Path == "" {
		return "", fmt.Errorf("invalid project directory response from %q", owner)
	}
	return result.Path, nil
}
