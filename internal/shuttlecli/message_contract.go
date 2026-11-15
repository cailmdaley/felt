package shuttlecli

import (
	"encoding/json"
	"net/url"
	"time"
)

// inboxVersionTimeout bounds each /version probe. A probe that does not
// answer in time picks the older wire, which every 42 owner still accepts.
const inboxVersionTimeout = 5 * time.Second

// inbox42 reports whether every daemon on a fiber message's path speaks
// contract 42: this host's daemon, which routes the request and forwards only
// the fields it knows (an older one drops session and attachments), and the
// owner, which consumes it. Otherwise the message keeps the session-send wire
// and the forced-fresh launch envelope. Each send asks live: a CLI process
// sends one message, and a level cached across processes would outlive the
// deploy or rollback this check exists for.
func (a *app) inbox42(owner string) bool {
	local, ok := a.daemonContractLevel("")
	if !ok || local.Level < 42 {
		return false
	}
	if local.Host == owner {
		return true
	}
	remote, ok := a.daemonContractLevel(owner)
	return ok && remote.Host == owner && remote.Level >= 42
}

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
	body, err := a.getDaemon(endpoint, inboxVersionTimeout)
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
