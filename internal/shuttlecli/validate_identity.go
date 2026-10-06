package shuttlecli

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// validate-identity — the federated UID-readiness auditor. It queries each daemon's
// document surface (/api/v1/fibers?shuttle=true) across the local tunnel ports and
// checks the intrinsic-identity migration invariants: ULID uids present, document
// id == uid, no uid describing two slug addresses in one feed, and host ownership
// on open/active shuttle fibers. A multi-daemon HTTP auditor with no felt-internal
// analogue.

var (
	ulidPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)
)

type identityReport struct {
	GeneratedAt time.Time              `json:"generated_at"`
	Daemons     []identityDaemonReport `json:"daemons"`
	Summary     identitySummary        `json:"summary"`
}

type identitySummary struct {
	DaemonCount       int `json:"daemon_count"`
	FiberCount        int `json:"fiber_count"`
	MissingUIDCount   int `json:"missing_uid_count"`
	DocumentSkewCount int `json:"document_skew_count"`
	DuplicateUIDCount int `json:"duplicate_uid_count"`
	HostlessOpenCount int `json:"hostless_open_count"`
}

type identityDaemonReport struct {
	URL           string                 `json:"url"`
	Host          string                 `json:"host,omitempty"`
	FiberCount    int                    `json:"fiber_count"`
	MissingUID    []identityFiberFinding `json:"missing_uid,omitempty"`
	DocumentSkew  []identityFiberFinding `json:"document_skew,omitempty"`
	DuplicateUIDs []identityDuplicateUID `json:"duplicate_uids,omitempty"`
	HostlessOpen  []identityFiberFinding `json:"hostless_open,omitempty"`
	Error         string                 `json:"error,omitempty"`
}

type identityFiberFinding struct {
	Slug      string `json:"slug,omitempty"`
	ID        string `json:"id,omitempty"`
	UID       string `json:"uid,omitempty"`
	Status    string `json:"status,omitempty"`
	FeltStore string `json:"felt_store,omitempty"`
	Path      string `json:"path,omitempty"`
	Host      string `json:"host,omitempty"`
}

type identityDuplicateUID struct {
	UID   string                 `json:"uid"`
	Rows  []identityFiberFinding `json:"rows"`
	Count int                    `json:"count"`
}

type daemonFibersResponse struct {
	Host   string           `json:"host"`
	Fibers []daemonFiberRow `json:"fibers"`
}

type daemonFiberRow struct {
	Path      string         `json:"path"`
	FeltStore string         `json:"felt_store"`
	Fiber     map[string]any `json:"fiber"`
}

func (a *app) validateIdentityCmd() *cobra.Command {
	var identityDaemonURLs []string
	validateIdentityCmd := &cobra.Command{
		Use:   "validate-identity",
		Short: "Validate fiber UID invariants across daemon feeds",
		Long: `Queries the shuttle daemon document surface and checks the
intrinsic-identity invariants:

  - /api/v1/fibers rows carry ULID uid values
  - document id equals uid when uid is present
  - uid values do not describe multiple slug addresses in one daemon feed
  - open/active shuttle fibers have shuttle.host ownership

By default it checks the local daemon (its listener per 'shuttle host')
plus every configured remote's URL (see 'shuttle remotes list').
Pass --daemon-url repeatedly to validate another set of daemon base URLs.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			urls := identityDaemonURLs
			if len(urls) == 0 {
				var err error
				urls, err = a.defaultIdentityDaemonURLs()
				if err != nil {
					return err
				}
			}

			report := a.validateIdentity(urls)
			hasGaps := report.Summary.MissingUIDCount > 0 ||
				report.Summary.DocumentSkewCount > 0 ||
				report.Summary.DuplicateUIDCount > 0 ||
				report.Summary.HostlessOpenCount > 0

			if a.json {
				if err := a.outputJSON(report); err != nil {
					return err
				}
				if hasGaps {
					return fmt.Errorf("identity validation found gaps")
				}
				return nil
			}

			a.printIdentityReport(report)
			if hasGaps {
				return fmt.Errorf("identity validation found gaps")
			}
			return nil
		},
	}
	validateIdentityCmd.Flags().StringArrayVar(&identityDaemonURLs, "daemon-url", nil, "Daemon base URL to validate; repeat for multiple hosts")
	return validateIdentityCmd
}

// defaultIdentityDaemonURLs is the local daemon plus every resolved remote's
// URL: the fleet file's entries and the local daemon's discovered peers, the
// same fleet the daemon polls.
func (a *app) defaultIdentityDaemonURLs() ([]string, error) {
	local, err := a.daemonURL()
	if err != nil {
		return nil, err
	}
	urls := []string{local}
	remotes, err := a.resolvedRemotes()
	if err != nil {
		return nil, err
	}
	for _, r := range remotes {
		urls = append(urls, r.URL)
	}
	return urls, nil
}

func (a *app) validateIdentity(urls []string) identityReport {
	report := identityReport{GeneratedAt: time.Now().UTC()}
	for _, url := range urls {
		daemon := a.validateIdentityDaemon(strings.TrimRight(url, "/"))
		report.Daemons = append(report.Daemons, daemon)
		report.Summary.DaemonCount++
		report.Summary.FiberCount += daemon.FiberCount
		report.Summary.MissingUIDCount += len(daemon.MissingUID)
		report.Summary.DocumentSkewCount += len(daemon.DocumentSkew)
		report.Summary.DuplicateUIDCount += len(daemon.DuplicateUIDs)
		report.Summary.HostlessOpenCount += len(daemon.HostlessOpen)
	}
	return report
}

func (a *app) validateIdentityDaemon(baseURL string) identityDaemonReport {
	report := identityDaemonReport{URL: baseURL}

	fibersURL := baseURL + "/api/v1/fibers?shuttle=true"
	fibers, err := getDaemonJSON[daemonFibersResponse](a, fibersURL, fmt.Sprintf("decoding %s", fibersURL))
	if err != nil {
		report.Error = err.Error()
		return report
	}
	report.Host = fibers.Host
	report.FiberCount = len(fibers.Fibers)

	byUID := map[string][]identityFiberFinding{}
	for _, row := range fibers.Fibers {
		finding := identityFindingFromRow(row)
		if finding.UID == "" || !ulidPattern.MatchString(finding.UID) {
			report.MissingUID = append(report.MissingUID, finding)
		} else {
			byUID[finding.UID] = append(byUID[finding.UID], finding)
		}
		if finding.UID != "" && finding.ID != finding.UID {
			report.DocumentSkew = append(report.DocumentSkew, finding)
		}
		if isOpenStatus(finding.Status) && finding.Host == "" {
			report.HostlessOpen = append(report.HostlessOpen, finding)
		}
	}

	for uid, rows := range byUID {
		if duplicateIdentityRows(rows) {
			report.DuplicateUIDs = append(report.DuplicateUIDs, identityDuplicateUID{
				UID:   uid,
				Rows:  rows,
				Count: len(rows),
			})
		}
	}
	sortIdentityDaemonReport(&report)

	return report
}

func identityFindingFromRow(row daemonFiberRow) identityFiberFinding {
	shuttle, _ := row.Fiber["shuttle"].(map[string]any)
	id := stringField(row.Fiber, "id")
	slug := stringField(row.Fiber, "slug")
	if slug == "" && !ulidPattern.MatchString(id) {
		slug = id
	}
	return identityFiberFinding{
		Slug:      slug,
		ID:        id,
		UID:       stringField(row.Fiber, "uid"),
		Status:    stringField(row.Fiber, "status"),
		FeltStore: row.FeltStore,
		Path:      row.Path,
		Host:      stringField(shuttle, "host"),
	}
}

func duplicateIdentityRows(rows []identityFiberFinding) bool {
	if len(rows) < 2 {
		return false
	}
	first := rows[0].Slug
	for _, row := range rows[1:] {
		if row.Slug != first {
			return true
		}
	}
	return false
}

func sortIdentityDaemonReport(report *identityDaemonReport) {
	sortFindings(report.MissingUID)
	sortFindings(report.DocumentSkew)
	sortFindings(report.HostlessOpen)
	sort.Slice(report.DuplicateUIDs, func(i, j int) bool {
		return report.DuplicateUIDs[i].UID < report.DuplicateUIDs[j].UID
	})
}

func sortFindings(rows []identityFiberFinding) {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Slug != rows[j].Slug {
			return rows[i].Slug < rows[j].Slug
		}
		return rows[i].FeltStore < rows[j].FeltStore
	})
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	value, _ := m[key].(string)
	return value
}

func isOpenStatus(status string) bool {
	return status == "open" || status == "active"
}

func (a *app) printIdentityReport(report identityReport) {
	fmt.Fprintf(a.env.Stdout, "Federated identity validation (%s)\n", report.GeneratedAt.Format(time.RFC3339))
	fmt.Fprintf(a.env.Stdout, "Daemons: %d  Fibers: %d  Missing UID: %d  Document skew: %d  Duplicate UID: %d  Hostless open: %d\n\n",
		report.Summary.DaemonCount,
		report.Summary.FiberCount,
		report.Summary.MissingUIDCount,
		report.Summary.DocumentSkewCount,
		report.Summary.DuplicateUIDCount,
		report.Summary.HostlessOpenCount,
	)

	for _, daemon := range report.Daemons {
		host := daemon.Host
		if host == "" {
			host = "(unknown)"
		}
		fmt.Fprintf(a.env.Stdout, "%s (%s): %d fibers\n", daemon.URL, host, daemon.FiberCount)
		if daemon.Error != "" {
			fmt.Fprintf(a.env.Stdout, "  error: %s\n\n", daemon.Error)
			continue
		}
		a.printFindingGroup("missing uid", daemon.MissingUID)
		a.printFindingGroup("document id != uid", daemon.DocumentSkew)
		a.printFindingGroup("hostless open/active", daemon.HostlessOpen)
		a.printDuplicateGroup(daemon.DuplicateUIDs)
		fmt.Fprintln(a.env.Stdout)
	}
}

func (a *app) printFindingGroup(label string, rows []identityFiberFinding) {
	if len(rows) == 0 {
		return
	}
	const cap = 12
	shown := rows
	if len(shown) > cap {
		shown = shown[:cap]
	}
	fmt.Fprintf(a.env.Stdout, "  %s (%d):\n", label, len(rows))
	for _, row := range shown {
		fmt.Fprintf(a.env.Stdout, "    - %s [status=%s id=%s uid=%s host=%s]\n", row.Slug, row.Status, row.ID, row.UID, row.Host)
	}
	if len(rows) > cap {
		fmt.Fprintf(a.env.Stdout, "    ... %d more\n", len(rows)-cap)
	}
}

func (a *app) printDuplicateGroup(rows []identityDuplicateUID) {
	if len(rows) == 0 {
		return
	}
	fmt.Fprintf(a.env.Stdout, "  duplicate uid (%d):\n", len(rows))
	for _, row := range rows {
		fmt.Fprintf(a.env.Stdout, "    - %s (%d rows)\n", row.UID, row.Count)
	}
}
