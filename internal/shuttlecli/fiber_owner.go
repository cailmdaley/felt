package shuttlecli

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// ownedFiber is a fiber and the host whose daemon answers for it: its
// shuttle.host, else this host.
type ownedFiber struct {
	*felt.Felt
	Host string
	// Remote is true when Host is another machine, so the document read here
	// (if any) is a Git copy rather than the owner's. Path names that document
	// on this machine and is empty when there is none.
	Remote bool
}

// resolveOwnedFiber resolves one exact fiber from any directory, as attach
// does, asking the fleet's owners when no store here holds it.
func (a *app) resolveOwnedFiber(query string) (ownedFiber, error) {
	f, err := a.shuttleAddressFiber(query)
	var missing *felt.NoFiberMatchError
	if errors.As(err, &missing) {
		remote, _, remoteErr := a.remoteFiber(query, false)
		if remoteErr == nil {
			remote.Path = "" // the owner's filesystem, not this one
			f, err = remote, nil
		} else if !errors.Is(remoteErr, errNoRemoteFiber) {
			err = fmt.Errorf("%v; owner lookup: %w", err, remoteErr)
		}
	}
	if err != nil {
		return ownedFiber{}, err
	}
	if f.UID == "" {
		return ownedFiber{}, fmt.Errorf("fiber %s has no intrinsic id; run `felt backfill-ids`", f.ID)
	}
	own, err := a.resolveOwnHost("")
	if err != nil {
		return ownedFiber{}, err
	}
	block, ok, err := shuttle.BlockOf(f)
	if err != nil {
		return ownedFiber{}, err
	}
	host := own
	if ok && strings.TrimSpace(block.Host) != "" {
		host = strings.TrimSpace(block.Host)
	}
	return ownedFiber{Felt: f, Host: host, Remote: host != own}, nil
}

// browserURL is the local daemon's base URL as a browser opens it. A daemon
// on a unix socket has none.
func (a *app) browserURL() (string, error) {
	base, err := a.daemonURL()
	if err != nil {
		return "", err
	}
	base = strings.TrimRight(base, "/")
	if base == "http://"+shuttle.DaemonSocketHost {
		return "", errors.New("the daemon listens on a unix socket, which no URL reaches")
	}
	return base, nil
}

// fileURL is where the daemon at base serves host's file at path.
func fileURL(base, path, host string) string {
	return base + "/api/v1/file?" + url.Values{"path": {path}, "origin": {host}}.Encode()
}
