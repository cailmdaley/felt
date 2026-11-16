package shuttlecli

import (
	"encoding/json"
	"net/url"
	"time"
)

// daemonVersionTimeout bounds each /version probe.
const daemonVersionTimeout = 5 * time.Second

type daemonLevel struct {
	Host  string
	Level int
}

// daemonContractLevel reads a daemon's /version: this host's, or with origin
// the named owner's through it.
func (a *app) daemonContractLevel(origin string) (daemonLevel, bool) {
	endpoint, err := a.daemonEndpoint("/api/v1/version")
	if err != nil {
		return daemonLevel{}, false
	}
	if origin != "" {
		endpoint += "?origin=" + url.QueryEscape(origin)
	}
	body, err := a.getDaemon(endpoint, daemonVersionTimeout)
	if err != nil {
		return daemonLevel{}, false
	}
	var v struct {
		Host     string `json:"host"`
		Level    int    `json:"contract_level"`
		Contract struct {
			Expected int `json:"expected"`
		} `json:"contract"`
	}
	if json.Unmarshal(body, &v) != nil {
		return daemonLevel{}, false
	}
	if v.Level == 0 {
		v.Level = v.Contract.Expected
	}
	return daemonLevel{Host: v.Host, Level: v.Level}, true
}
