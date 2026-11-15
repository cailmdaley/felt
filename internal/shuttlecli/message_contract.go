package shuttlecli

import (
	"encoding/json"
	"net/url"
)

// ownerInbox42 checks the owner, not the routing hub. Older owners keep the
// session-send wire and the forced-fresh launch envelope.
func (a *app) ownerInbox42(owner string) bool {
	endpoint, err := a.daemonEndpoint("/api/v1/version")
	if err != nil {
		return false
	}
	body, err := a.getDaemon(endpoint+"?origin="+url.QueryEscape(owner), daemonPostTimeout)
	if err != nil {
		return false
	}
	var v struct {
		Host     string `json:"host"`
		Level    int    `json:"contract_level"`
		Contract struct {
			Expected int `json:"expected"`
		} `json:"contract"`
	}
	if json.Unmarshal(body, &v) != nil {
		return false
	}
	if v.Level == 0 {
		v.Level = v.Contract.Expected
	}
	return v.Host == owner && v.Level >= 42
}
