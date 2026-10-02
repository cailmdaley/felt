package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type receiptStatus string

const (
	receiptHealthy  receiptStatus = "healthy"
	receiptMissing  receiptStatus = "missing"
	receiptStale    receiptStatus = "stale"
	receiptMismatch receiptStatus = "mismatch"
	receiptPartial  receiptStatus = "partial"
	receiptBooting  receiptStatus = "booting"
)

type DoctorReceipt struct {
	Schema        int                  `json:"schema"`
	Status        receiptStatus        `json:"status"`
	Repair        string               `json:"repair,omitempty"`
	Daemon        ReceiptDaemon        `json:"daemon"`
	Host          ReceiptHost          `json:"host"`
	ShuttleBinary ReceiptShuttleBinary `json:"shuttle_binary"`
	TmuxServer    *ReceiptTmuxServer   `json:"tmux_server,omitempty"`
}

type ReceiptDaemon struct {
	URL               string              `json:"url"`
	Status            receiptStatus       `json:"status"`
	Repair            string              `json:"repair,omitempty"`
	Expected          any                 `json:"expected,omitempty"`
	Observed          any                 `json:"observed,omitempty"`
	Contract          bool                `json:"contract_ok"`
	Ready             *bool               `json:"ready,omitempty"`
	Listen            string              `json:"listen,omitempty"`
	HostClass         string              `json:"host_class,omitempty"`
	PeerGate          string              `json:"peer_gate,omitempty"`
	PeerGateUID       *int                `json:"peer_gate_uid,omitempty"`
	PeerGateUIDSource string              `json:"peer_gate_uid_source,omitempty"`
	TailnetDial       *ReceiptTailnetDial `json:"tailnet_dial,omitempty"`
	Discovery         *daemonDiscovery    `json:"discovery,omitempty"`
}

type ReceiptTailnetDial struct {
	Configured   bool                   `json:"configured"`
	Socket       string                 `json:"socket,omitempty"`
	SocketSource string                 `json:"socket_source,omitempty"`
	Bridges      []ReceiptTailnetBridge `json:"bridges"`
}

type ReceiptTailnetBridge struct {
	Name       string `json:"name"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Socket     string `json:"socket"`
	Status     string `json:"status"`
	ErrorStage string `json:"error_stage,omitempty"`
	Error      string `json:"error,omitempty"`
}

type ReceiptTmuxServer struct {
	Status    receiptStatus `json:"status"`
	Repair    string        `json:"repair,omitempty"`
	Warning   string        `json:"warning,omitempty"`
	Origin    string        `json:"origin"`
	ServerPID string        `json:"server_pid,omitempty"`
	Coalition string        `json:"coalition,omitempty"`
	RootedBy  string        `json:"rooted_by,omitempty"`
}

var doctorCmd = &cobra.Command{
	Use:   "doctor",
	Short: "Check Shuttle's binary, daemon, host, and runtime health",
	Long:  "Reports the running shuttle binary and hook resolution alongside the daemon contract and host configuration, including listener and socket evidence. Use felt setup receipt for plugin installation health.",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		receipt := collectDoctorReceipt()
		if jsonOutput {
			if err := outputJSON(receipt); err != nil {
				return err
			}
		} else {
			fmt.Printf("shuttle %s\ndaemon: %s\n", receipt.Status, receipt.Daemon.Status)
			printShuttleBinaryReceipt(receipt.ShuttleBinary)
			printHostReceipt(receipt.Host)
			printTailnetDialReceipt(receipt.Daemon.TailnetDial)
			printDiscoveryReceipt(receipt.Daemon.Discovery)
			printTmuxServerReceipt(receipt.TmuxServer)
			if receipt.Repair != "" {
				fmt.Printf("repair: %s\n", receipt.Repair)
			}
		}
		if receipt.Status != receiptHealthy {
			return fmt.Errorf("Shuttle doctor is %s", receipt.Status)
		}
		return nil
	},
}

func init() { addShuttleCommand(doctorCmd) }

func printShuttleBinaryReceipt(binary ReceiptShuttleBinary) {
	fmt.Printf("shuttle binary: %s (build %s)\n", binary.ResolvedPath, binary.Build)
	for _, executable := range binary.Executables {
		label := "other"
		if executable.Shadowing {
			label = "shadowing"
		}
		if executable.Error != "" {
			fmt.Printf("  %s shuttle: %s (%s)\n", label, executable.Path, executable.Error)
			continue
		}
		fmt.Printf("  %s shuttle: %s (build %s)\n", label, executable.Path, executable.Build)
	}
	if binary.HookResolution == "" {
		fmt.Println("hooks/shuttle-bin.sh: no shuttle executable found")
		return
	}
	fmt.Printf("hooks/shuttle-bin.sh: selects %s (this binary: %t)\n", binary.HookResolution, binary.HooksWouldPickIt)
}

func collectDoctorReceipt() DoctorReceipt {
	receipt := DoctorReceipt{Schema: 1}
	receipt.ShuttleBinary = collectShuttleBinaryReceipt()
	receipt.Daemon = collectDaemonReceipt()
	receipt.Host = collectHostReceiptWhenReady(receipt.Daemon)
	receipt.TmuxServer = collectTmuxServerReceipt()
	statuses := []receiptStatus{receipt.Daemon.Status, receipt.Host.Status}
	if receipt.TmuxServer != nil {
		statuses = append(statuses, receipt.TmuxServer.Status)
	}
	receipt.Status, receipt.Repair = combineDoctorReceiptStatus(statuses...)
	if receipt.Daemon.Status != receiptHealthy && receipt.Daemon.Status == receipt.Status && receipt.Daemon.Repair != "" {
		receipt.Repair = receipt.Daemon.Repair
	}
	foldDoctorRepair(&receipt, receipt.Host.Status, receipt.Host.Repair)
	if receipt.TmuxServer != nil {
		foldDoctorRepair(&receipt, receipt.TmuxServer.Status, receipt.TmuxServer.Repair)
	}
	return receipt
}

func combineDoctorReceiptStatus(statuses ...receiptStatus) (receiptStatus, string) {
	for _, status := range statuses {
		if status == receiptBooting {
			return receiptBooting, "Shuttle daemon is still booting; retry when /api/v1/version reports ready:true"
		}
	}
	for _, status := range []receiptStatus{receiptMismatch, receiptStale} {
		for _, got := range statuses {
			if got == status {
				return status, "repair the Shuttle daemon or host configuration, then rerun `shuttle doctor`"
			}
		}
	}
	for _, status := range statuses {
		if status == receiptPartial {
			return receiptPartial, "complete Shuttle host configuration, then rerun `shuttle doctor`"
		}
	}
	for _, status := range statuses {
		if status == receiptMissing {
			return receiptMissing, "start Shuttle and rerun `shuttle doctor`"
		}
	}
	return receiptHealthy, ""
}

func foldDoctorRepair(receipt *DoctorReceipt, status receiptStatus, repair string) {
	if status == receiptHealthy || status != receipt.Status || repair == "" {
		return
	}
	switch {
	case receipt.Repair == "" || receipt.Repair == doctorReceiptRepair(receipt.Status):
		receipt.Repair = repair
	case strings.Contains(receipt.Repair, repair):
	default:
		receipt.Repair += "; also: " + repair
	}
}

func doctorReceiptRepair(status receiptStatus) string {
	switch status {
	case receiptBooting:
		return "Shuttle daemon is still booting; retry when /api/v1/version reports ready:true"
	case receiptMissing:
		return "start Shuttle and rerun `shuttle doctor`"
	case receiptPartial:
		return "complete Shuttle host configuration, then rerun `shuttle doctor`"
	default:
		return "repair the Shuttle daemon or host configuration, then rerun `shuttle doctor`"
	}
}

func printHostReceipt(host ReceiptHost) {
	if host.Class != "" {
		fmt.Printf("host %s (%s)\n", host.Class, host.Listen)
	}
	if host.TailscaleSocket != "" {
		fmt.Printf("tailscale LocalAPI socket: %s (%s)", host.TailscaleSocket, host.TailscaleSocketSource)
		if host.TailnetSocketEvidence != nil {
			evidence := host.TailnetSocketEvidence
			fmt.Printf(" (unix=%t, owner_ok=%t, private=%t", evidence.Socket, evidence.OwnerOK, evidence.Private)
			if evidence.Mode != "" {
				fmt.Printf(", mode=%s", evidence.Mode)
			}
			fmt.Print(")")
		}
		fmt.Println()
	}
	for _, problem := range host.Problems {
		fmt.Printf("  host: %s\n", problem)
	}
}

func printTailnetDialReceipt(dial *ReceiptTailnetDial) {
	if dial == nil || !dial.Configured {
		return
	}
	ready := 0
	for _, bridge := range dial.Bridges {
		if bridge.Status == "ready" {
			ready++
		}
	}
	fmt.Printf("tailnet dial: %d/%d remote bridges ready\n", ready, len(dial.Bridges))
	for _, bridge := range dial.Bridges {
		if bridge.Status == "ready" {
			continue
		}
		fmt.Printf("  remote %s (%s:%d): %s", bridge.Name, bridge.Host, bridge.Port, bridge.Status)
		if bridge.ErrorStage != "" {
			fmt.Printf(" at %s", bridge.ErrorStage)
		}
		if bridge.Error != "" {
			fmt.Printf(": %s", bridge.Error)
		}
		fmt.Println()
	}
}

// printDiscoveryReceipt reports the daemon's tailnet peer discovery. A failed
// or unavailable discovery is a warning, not a doctor failure: the daemon
// still serves the fleet file's remotes, and a host off the tailnet is a
// correct host.
func printDiscoveryReceipt(discovery *daemonDiscovery) {
	if discovery == nil {
		return
	}
	switch discovery.State {
	case "ok":
		names := make([]string, 0, len(discovery.Peers))
		for _, peer := range discovery.Peers {
			names = append(names, peer.Name)
		}
		fmt.Printf("tailnet discovery via %s: %d peer(s)", discovery.Via, len(names))
		if len(names) > 0 {
			fmt.Printf(" (%s)", strings.Join(names, ", "))
		}
		fmt.Println()
	case "pending":
		fmt.Println("tailnet discovery: first round still running")
	case "disabled":
		fmt.Printf("tailnet discovery: off (%s)\n", discovery.Error)
	default:
		fmt.Printf("warning: tailnet discovery unavailable (%s); this host is running on remotes.json alone\n", discovery.Error)
	}
}

func collectHostReceiptWhenReady(daemon ReceiptDaemon) ReceiptHost {
	if daemon.Ready != nil && !*daemon.Ready {
		return ReceiptHost{Status: receiptBooting, Repair: daemon.Repair}
	}
	return collectHostReceipt(daemon)
}

func collectDaemonReceipt() ReceiptDaemon {
	base, err := daemonURL()
	if err != nil {
		return ReceiptDaemon{Status: receiptMismatch, Repair: hostFileRepair(err)}
	}
	d := ReceiptDaemon{URL: base, Status: receiptMissing, Repair: "start the Shuttle daemon, then rerun `shuttle doctor --json`"}
	data, err := getDaemon(strings.TrimRight(base, "/")+"/api/v1/version", daemonReadTimeout)
	if err != nil {
		return daemonReceiptOnTransportError(d, err)
	}
	var response struct {
		Listen            string              `json:"listen"`
		HostClass         string              `json:"host_class"`
		PeerGate          string              `json:"peer_gate"`
		PeerGateUID       *int                `json:"peer_gate_uid"`
		PeerGateUIDSource string              `json:"peer_gate_uid_source"`
		TailnetDial       *ReceiptTailnetDial `json:"tailnet_dial"`
		Discovery         *daemonDiscovery    `json:"discovery"`
		Ready             *bool               `json:"ready"`
		Contract          struct {
			Expected json.RawMessage `json:"expected"`
			Observed json.RawMessage `json:"observed"`
			OK       *bool           `json:"ok"`
		} `json:"contract"`
	}
	decodeErr := json.Unmarshal(data, &response)
	d.Listen, d.HostClass, d.PeerGate = response.Listen, response.HostClass, response.PeerGate
	d.PeerGateUID, d.PeerGateUIDSource = response.PeerGateUID, response.PeerGateUIDSource
	d.TailnetDial, d.Ready = response.TailnetDial, response.Ready
	d.Discovery = response.Discovery
	if decodeErr != nil {
		d.Status, d.Repair = receiptMismatch, "upgrade or restart Shuttle so /api/v1/version exposes the contract receipt"
		return d
	}
	if response.Ready != nil && !*response.Ready {
		d.Status, d.Repair = receiptBooting, doctorReceiptRepair(receiptBooting)
		return d
	}
	if len(response.Contract.Expected) == 0 || len(response.Contract.Observed) == 0 {
		d.Status, d.Repair = receiptMismatch, "upgrade or restart Shuttle so /api/v1/version exposes the contract receipt"
		return d
	}
	d.Expected, d.Observed = receiptJSONValue(response.Contract.Expected), receiptJSONValue(response.Contract.Observed)
	if response.Contract.OK != nil {
		d.Contract = *response.Contract.OK
	}
	if d.Contract && fmt.Sprint(d.Expected) == fmt.Sprint(d.Observed) {
		d.Status, d.Repair = receiptHealthy, ""
	} else {
		d.Status, d.Repair = receiptMismatch, "restart or upgrade the daemon and shuttle together so their contract levels match"
	}
	return d
}

func daemonReceiptOnTransportError(daemon ReceiptDaemon, err error) ReceiptDaemon {
	var ownerErr *daemonTCPOwnerCheckError
	if errors.As(err, &ownerErr) {
		switch {
		case ownerErr.foreign:
			daemon.Repair = fmt.Sprintf("stop the process holding %s (uid %d), then restart the daemon", ownerErr.address, ownerErr.uid)
		case ownerErr.pending:
			daemon.Repair = fmt.Sprintf("the listener did not accept within %d s; retry, and if it persists inspect what holds %s", int(acceptWait/time.Second), ownerErr.address)
		default:
			daemon.Repair = ownerErr.Error()
		}
		daemon.Status = receiptMismatch
	}
	return daemon
}

func receiptJSONValue(raw json.RawMessage) any {
	var value any
	if json.Unmarshal(raw, &value) == nil {
		if number, ok := value.(float64); ok && number == float64(int(number)) {
			return int(number)
		}
		return value
	}
	return string(raw)
}

func collectTmuxServerReceipt() *ReceiptTmuxServer {
	if runtime.GOOS != "darwin" {
		return nil
	}
	report := detectTmuxOrigin()
	receipt := &ReceiptTmuxServer{
		Status: receiptHealthy, Origin: report.Origin,
		ServerPID: report.ServerPID, Coalition: report.Coalition, RootedBy: report.RootedBy,
		Warning: tmuxOriginWarning(report),
	}
	if report.Origin == tmuxOriginDaemonBorn {
		receipt.Status, receipt.Repair = receiptMismatch, tmuxOriginRepair
	}
	return receipt
}

// printTmuxServerReceipt names the app the running tmux server is charged to,
// then the remedy when that app is the daemon or the advisory when it is
// neither the daemon nor kitty.
func printTmuxServerReceipt(rec *ReceiptTmuxServer) {
	if rec == nil {
		return
	}
	switch rec.Origin {
	case tmuxOriginAbsent:
		fmt.Println("tmux server: not running")
	case tmuxOriginUnknown:
		fmt.Printf("tmux server: pid %s, rooting app unknown\n", rec.ServerPID)
	case tmuxOriginDaemonBorn:
		fmt.Printf("tmux server: pid %s, rooted by %s — %s\n", rec.ServerPID, rec.RootedBy, rec.Repair)
	default:
		fmt.Printf("tmux server: pid %s, rooted by %s\n", rec.ServerPID, rec.RootedBy)
	}
	if rec.Warning != "" {
		fmt.Printf("warning: %s\n", rec.Warning)
	}
}
