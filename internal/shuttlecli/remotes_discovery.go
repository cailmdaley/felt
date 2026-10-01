package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Tailnet peer discovery, as the CLI sees it.
//
// The daemon is the one discoverer: `Shuttle.TailnetPeers` reads the tailnet
// status, probes each same-user peer at /api/v1/version, names each Shuttle
// daemon by the host id it reports, and publishes the result as `discovery` in
// its own /api/v1/version. The CLI never probes the tailnet itself. It reads
// that report from the local daemon and merges it with the fleet file through
// resolveRemotes, the Go mirror of `Shuttle.Remotes.resolve/2`.
// daemon/test/fixtures/tailnet_peers/*.json drives both.

const (
	sourceConfigured = "configured"
	sourceDiscovered = "discovered"

	// discoveryReadTimeout bounds the one local-daemon read a resolved fleet
	// costs. The daemon answers /api/v1/version from memory.
	discoveryReadTimeout = 3 * time.Second
)

// discoveredPeer is one daemon the local daemon found on the tailnet.
type discoveredPeer struct {
	Name       string `json:"name"`
	URL        string `json:"url"`
	DNSName    string `json:"dns_name,omitempty"`
	LastSeenAt string `json:"last_seen_at,omitempty"`
}

// discoveryRejection is a tailnet node discovery considered and left out.
type discoveryRejection struct {
	DNSName string `json:"dns_name"`
	Reason  string `json:"reason"`
}

// daemonDiscovery is the `discovery` report in the daemon's /api/v1/version.
// State is pending, ok, unavailable or disabled; Via is localapi or cli.
type daemonDiscovery struct {
	Enabled   bool                 `json:"enabled"`
	State     string               `json:"state"`
	Via       string               `json:"via,omitempty"`
	Error     string               `json:"error,omitempty"`
	LastRunAt string               `json:"last_run_at,omitempty"`
	Peers     []discoveredPeer     `json:"peers"`
	Rejected  []discoveryRejection `json:"rejected,omitempty"`
}

// discoverEnabled reports whether the document lets this host use discovered
// peers: true unless defaults.discover is false.
func (doc remotesFile) discoverEnabled() bool {
	return doc.Defaults == nil || doc.Defaults.Discover == nil || *doc.Defaults.Discover
}

// resolveRemotes merges a normalized fleet document with discovered peers:
// the document's enabled entries in file order, then the admitted peers by
// name. Each carries its Source. Pure; see admitDiscovered for the rule.
func resolveRemotes(doc remotesFile, discovered []discoveredPeer) []remoteSpec {
	out := make([]remoteSpec, 0, len(doc.Remotes)+len(discovered))
	for _, r := range doc.Remotes {
		if r.enabledOr() {
			r.Source = sourceConfigured
			out = append(out, r)
		}
	}
	return append(out, admitDiscovered(doc, discovered)...)
}

// admitDiscovered is the discovered half of the merge. A configured entry wins
// wholesale: a peer is dropped when any document entry, enabled or not, has
// its name or already reaches the same https authority, so a disabled entry
// suppresses a discovered host. defaults.discover false admits none. An
// admitted peer is a portless URL remote with the document's polling
// defaults, no tunnel and no ssh path.
func admitDiscovered(doc remotesFile, discovered []discoveredPeer) []remoteSpec {
	if !doc.discoverEnabled() {
		return nil
	}
	names, authorities := map[string]bool{}, map[string]bool{}
	for _, r := range doc.Remotes {
		names[r.Name] = true
		if authority := privateHTTPSAuthority(r.URL); authority != "" {
			authorities[authority] = true
		}
	}

	peers := append([]discoveredPeer(nil), discovered...)
	sort.SliceStable(peers, func(i, j int) bool { return peers[i].Name < peers[j].Name })

	var out []remoteSpec
	for _, peer := range peers {
		name := strings.TrimSpace(peer.Name)
		authority := privateHTTPSAuthority(peer.URL)
		if name == "" || authority == "" || names[name] || authorities[authority] {
			continue
		}
		one := remotesFile{Defaults: doc.Defaults, Remotes: []remoteSpec{{Name: name, URL: peer.URL}}}
		if err := normalizeRemotes(&one); err != nil {
			continue
		}
		spec := one.Remotes[0]
		spec.Source = sourceDiscovered
		names[name] = true
		out = append(out, spec)
	}
	return out
}

// resolvedFleet is the fleet file plus what the local daemon discovered.
// Discovery is nil, with DiscoveryErr saying why, when the daemon could not
// be asked; Remotes is then the configured entries alone.
type resolvedFleet struct {
	Doc          remotesFile
	Remotes      []remoteSpec
	Discovery    *daemonDiscovery
	DiscoveryErr error
}

// loadResolvedFleet reads and validates the fleet file, then asks the local
// daemon for its discovered peers. A malformed file is an error; an
// unreachable daemon is not.
func loadResolvedFleet() (resolvedFleet, error) {
	doc, err := loadRemotesFile()
	if err != nil {
		return resolvedFleet{}, err
	}
	fleet := resolvedFleet{Doc: doc}
	if doc.discoverEnabled() {
		fleet.Discovery, fleet.DiscoveryErr = fetchDaemonDiscovery()
	}
	var peers []discoveredPeer
	if fleet.Discovery != nil {
		peers = fleet.Discovery.Peers
	}
	fleet.Remotes = resolveRemotes(doc, peers)
	return fleet, nil
}

// resolvedRemotes is the enabled fleet every caller that routes by remote name
// uses: configured entries and discovered peers alike.
func resolvedRemotes() ([]remoteSpec, error) {
	fleet, err := loadResolvedFleet()
	if err != nil {
		return nil, err
	}
	return fleet.Remotes, nil
}

// fetchDaemonDiscovery reads the local daemon's discovery report.
func fetchDaemonDiscovery() (*daemonDiscovery, error) {
	endpoint, err := daemonEndpoint("/api/v1/version")
	if err != nil {
		return nil, err
	}
	body, err := getDaemon(endpoint, discoveryReadTimeout)
	if err != nil {
		return nil, err
	}
	var version struct {
		Discovery *daemonDiscovery `json:"discovery"`
	}
	if err := json.Unmarshal(body, &version); err != nil {
		return nil, fmt.Errorf("decoding %s: %w", endpoint, err)
	}
	if version.Discovery == nil {
		return nil, errors.New("the daemon does not report tailnet discovery; upgrade or restart it")
	}
	return version.Discovery, nil
}

// discoverySummary is the one-line account of discovery `remotes list`
// prints above its table, or "" when there is nothing to say.
func (f resolvedFleet) discoverySummary() string {
	switch {
	case !f.Doc.discoverEnabled():
		return "tailnet discovery is off (defaults.discover is false)"
	case f.DiscoveryErr != nil:
		return fmt.Sprintf("no discovered peers from the daemon (%v): showing configured remotes only", f.DiscoveryErr)
	}
	d := f.Discovery
	switch d.State {
	case "ok":
		return fmt.Sprintf("tailnet discovery via %s: %d peer(s)%s", d.Via, len(d.Peers), sinceSuffix(d.LastRunAt))
	case "pending":
		return "tailnet discovery has not finished its first round"
	case "disabled":
		return "tailnet discovery is disabled: " + d.Error
	default:
		return fmt.Sprintf("tailnet discovery unavailable (%s): this host runs on remotes.json alone", d.Error)
	}
}

func sinceSuffix(stamp string) string {
	at, err := time.Parse(time.RFC3339, stamp)
	if err != nil {
		return ""
	}
	return fmt.Sprintf(", %s ago", time.Since(at).Round(time.Second))
}
