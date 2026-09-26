package cmd

// The receipt's host component: does the way this machine is actually running
// match the class it declares? A shared-multi-user or exposed host may keep
// its daemon on loopback TCP only when it reports uid gating; other fleet TCP
// listeners remain findings. It also avoids an unauthenticated mesh-VPN proxy
// and keeps its socket directory private. A single-user host must actually be
// single-user.
//
// Evidence is best effort and read-only: listeners come from `ss` (or /proc)
// on Linux and `lsof` on macOS, users from `who`. A missing tool makes the
// component partial where the evidence matters, never an error.

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
)

// ReceiptHost reports the declared class against the observed host.
type ReceiptHost struct {
	Status          receiptStatus           `json:"status"`
	Repair          string                  `json:"repair,omitempty"`
	Class           string                  `json:"class,omitempty"`
	ClassSource     string                  `json:"class_source,omitempty"`
	Listen          string                  `json:"listen,omitempty"`
	PeerGate        *ReceiptPeerGate        `json:"peer_gate,omitempty"`
	DaemonPortOwner *ReceiptDaemonPortOwner `json:"daemon_port_owner,omitempty"`
	// UsersLoggedIn is the count of distinct users `who` reports; absent when
	// `who` could not be read.
	UsersLoggedIn *int              `json:"users_logged_in,omitempty"`
	SocketDir     *ReceiptSocketDir `json:"socket_dir,omitempty"`
	// Listeners are the fleet processes listening on TCP; ListenersFrom names
	// the tool that enumerated them ("ss", "proc", "lsof"), empty when none
	// could.
	Listeners     []ReceiptListener `json:"listeners"`
	ListenersFrom string            `json:"listeners_from,omitempty"`
	HTTPSProxy    string            `json:"https_proxy,omitempty"`
	// Problems are the individual findings behind a non-healthy status, one
	// line each, for the human path.
	Problems []string `json:"problems,omitempty"`
}

// ReceiptDaemonPortOwner identifies the uid holding the daemon's TCP port.
type ReceiptDaemonPortOwner struct {
	UID      int  `json:"uid"`
	IsCaller bool `json:"is_caller"`
}

// ReceiptPeerGate explains the daemon's loopback TCP admission boundary.
type ReceiptPeerGate struct {
	Mode   string `json:"mode"`
	Reason string `json:"reason"`
}

// ReceiptSocketDir is the socket directory, inspected without following a
// symlink (the daemon lstats it too), plus its ancestors checked the way
// OpenSSH's StrictModes checks a key's: each owned by you or root, and not
// group- or other-writable unless sticky.
type ReceiptSocketDir struct {
	Path    string `json:"path"`
	Exists  bool   `json:"exists"`
	Symlink bool   `json:"symlink,omitempty"`
	Mode    string `json:"mode,omitempty"`
	OwnerOK bool   `json:"owner_ok"`
	// BadAncestor is the first ancestor, nearest first, that another user
	// could rename the socket directory out of; empty when every one is safe.
	BadAncestor string `json:"bad_ancestor,omitempty"`
}

type ReceiptListener struct {
	Process string `json:"process"`
	PID     int    `json:"pid,omitempty"`
	Command string `json:"command,omitempty"`
	Address string `json:"address"`
	Port    int    `json:"port"`
	// Role is why the listener counts as fleet: daemon, tunnel, or tailscaled.
	Role string `json:"role"`
}

// rawListener is one listening TCP socket before fleet classification.
type rawListener struct {
	Process string
	PID     int
	Address string
	Port    int
	// Command is the process's full command line, when it could be read.
	Command string
}

// hostEvidence is everything the status rules read, gathered separately so
// the rules can be tested with fake inputs.
type hostEvidence struct {
	settings    hostSettings
	settingsErr error
	users       *int
	socketDir   *ReceiptSocketDir
	listeners   []rawListener
	listenFrom  string
	daemonPorts []int
	tunnelPorts []int
	httpsProxy  string
	// daemonListen and daemonClass are what the running daemon reports on
	// /api/v1/version; empty when it was not reached.
	daemonListen   string
	daemonClass    string
	daemonPeerGate string
	// daemonPortOwner is the uid holding the resolved or reported TCP listener.
	daemonPortOwner  *ReceiptDaemonPortOwner
	daemonPortListen string
	// isDaemonCommand recognizes a shuttle daemon by its command line.
	isDaemonCommand func(string) bool
}

func collectHostReceipt(daemon ReceiptDaemon) ReceiptHost {
	ev := gatherHostEvidence()
	ev.daemonListen, ev.daemonClass, ev.daemonPeerGate = daemon.Listen, daemon.HostClass, daemon.PeerGate
	ev.daemonPortOwner, ev.daemonPortListen = observedDaemonPortOwner(ev, os.Geteuid())
	return evaluateHost(ev)
}

func gatherHostEvidence() hostEvidence {
	ev := hostEvidence{isDaemonCommand: func(cmd string) bool { return isShuttleDaemonCommand(cmd, fileExists) }}
	ev.settings, ev.settingsErr = resolveHostSettings()
	if _, err := exec.LookPath("who"); err == nil {
		if out, err := exec.Command("who").Output(); err == nil {
			n := countLoggedInUsers(string(out))
			ev.users = &n
		}
	}
	if ev.settingsErr == nil && ev.settings.listen.Network == "unix" {
		ev.socketDir = inspectSocketDir(filepath.Dir(ev.settings.listen.Address), os.Geteuid())
	}
	ev.listeners, ev.listenFrom = enumerateListeners()
	attachCommands(ev.listeners)

	// 4000 always: a daemon started from another shell, or by the
	// supervisor, need not share this shell's SHUTTLE_PORT.
	ev.daemonPorts = []int{defaultDaemonPort}
	if p, err := parsePort(strings.TrimSpace(os.Getenv("SHUTTLE_PORT"))); err == nil && p != defaultDaemonPort {
		ev.daemonPorts = append(ev.daemonPorts, p)
	}
	if ev.settingsErr == nil && ev.settings.listen.Network == "tcp" {
		if _, p, err := net.SplitHostPort(ev.settings.listen.Address); err == nil {
			if n, err := strconv.Atoi(p); err == nil && !slices.Contains(ev.daemonPorts, n) {
				ev.daemonPorts = append(ev.daemonPorts, n)
			}
		}
	}
	if doc, err := loadRemotesFileRaw(); err == nil {
		for _, r := range doc.Remotes {
			if r.Port != 0 {
				ev.tunnelPorts = append(ev.tunnelPorts, r.Port)
			}
		}
		if doc.Defaults != nil {
			ev.httpsProxy = strings.TrimSpace(doc.Defaults.HTTPSProxy)
		}
	}
	return ev
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// isShuttleDaemonCommand recognizes the shuttle release's VM by its command
// line: the release launcher's name, the checkout's bin/rel tree, or a
// `-root <dir>` whose release carries the bin/shuttled launcher. A bare
// beam.smp is not enough — every Erlang VM on the host has that name.
func isShuttleDaemonCommand(cmd string, exists func(string) bool) bool {
	if strings.Contains(cmd, "shuttled") || strings.Contains(cmd, "/bin/rel/") {
		return true
	}
	fields := strings.Fields(cmd)
	for i := 0; i+1 < len(fields); i++ {
		if fields[i] == "-root" && exists(filepath.Join(fields[i+1], "bin", "shuttled")) {
			return true
		}
	}
	return false
}

// attachCommands fills each listener's command line: /proc/<pid>/cmdline on
// Linux, one `ps` call elsewhere. Unreadable processes keep an empty command.
func attachCommands(ls []rawListener) {
	if len(ls) == 0 {
		return
	}
	var pids []string
	for _, l := range ls {
		if l.PID > 0 && !slices.Contains(pids, strconv.Itoa(l.PID)) {
			pids = append(pids, strconv.Itoa(l.PID))
		}
	}
	commands := map[int]string{}
	if runtime.GOOS == "linux" {
		for _, p := range pids {
			if raw, err := os.ReadFile(filepath.Join("/proc", p, "cmdline")); err == nil {
				pid, _ := strconv.Atoi(p)
				commands[pid] = strings.TrimSpace(strings.ReplaceAll(string(raw), "\x00", " "))
			}
		}
	} else if len(pids) > 0 {
		if out, err := exec.Command("ps", "-o", "pid=,command=", "-p", strings.Join(pids, ",")).Output(); err == nil {
			commands = parsePSCommands(string(out))
		}
	}
	for i := range ls {
		ls[i].Command = commands[ls[i].PID]
	}
}

// parsePSCommands reads `ps -o pid=,command=`: a pid, then the command line.
func parsePSCommands(out string) map[int]string {
	commands := map[int]string{}
	for _, line := range strings.Split(out, "\n") {
		pidText, cmd, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}
		if pid, err := strconv.Atoi(pidText); err == nil {
			commands[pid] = strings.TrimSpace(cmd)
		}
	}
	return commands
}

// observedDaemonPortOwner checks the running listener first, then the resolved
// listener. Linux /proc is the only source that exposes socket owners across
// uids; platforms without it leave this evidence absent.
func observedDaemonPortOwner(ev hostEvidence, callerUID int) (*ReceiptDaemonPortOwner, string) {
	if runtime.GOOS != "linux" ||
		!(hostClass(ev.settings.Class).usesSocket() || hostClass(ev.daemonClass).usesSocket()) {
		return nil, ""
	}
	candidates := []string{}
	for _, listen := range []string{ev.daemonListen, ev.settings.Listen} {
		if strings.HasPrefix(listen, "tcp://") && !slices.Contains(candidates, listen) {
			candidates = append(candidates, listen)
		}
	}
	if len(candidates) == 0 {
		return nil, ""
	}
	rows, err := readProcTCP("/proc")
	if err != nil {
		return nil, ""
	}
	var callerOwner *ReceiptDaemonPortOwner
	var callerListen string
	for _, listen := range candidates {
		address, portText, err := net.SplitHostPort(strings.TrimPrefix(listen, "tcp://"))
		if err != nil {
			continue
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			continue
		}
		for _, row := range rows {
			if row.Address != address || row.Port != port {
				continue
			}
			owner := &ReceiptDaemonPortOwner{UID: row.UID, IsCaller: row.UID == callerUID}
			if !owner.IsCaller {
				return owner, listen
			}
			if callerOwner == nil {
				callerOwner, callerListen = owner, listen
			}
		}
	}
	return callerOwner, callerListen
}

// evaluateHost applies the status rules to gathered evidence.
func evaluateHost(ev hostEvidence) ReceiptHost {
	h := ReceiptHost{Status: receiptHealthy, Listeners: []ReceiptListener{}}
	if ev.settingsErr != nil {
		h.Status = receiptMismatch
		h.Repair = hostFileRepair(ev.settingsErr)
		h.Problems = []string{ev.settingsErr.Error()}
		return h
	}
	h.Class, h.ClassSource, h.Listen = ev.settings.Class, ev.settings.ClassSource, ev.settings.Listen
	h.UsersLoggedIn, h.SocketDir, h.ListenersFrom, h.HTTPSProxy = ev.users, ev.socketDir, ev.listenFrom, ev.httpsProxy
	h.Listeners = classifyFleetListeners(ev.listeners, ev.daemonPorts, ev.tunnelPorts, ev.isDaemonCommand)

	var repairs []string
	mismatch := func(problem, repair string) {
		h.Status = receiptMismatch
		h.Problems = append(h.Problems, problem)
		if !slices.Contains(repairs, repair) {
			repairs = append(repairs, repair)
		}
	}

	const restartRepair = "restart onto a daemon that gates TCP peers by uid, or remove the TCP override and use the class's unix socket"
	socketClass := hostClass(h.Class).usesSocket() || hostClass(ev.daemonClass).usesSocket()
	portOwnerMismatch := ev.daemonPortOwner != nil && !ev.daemonPortOwner.IsCaller
	if ev.daemonPortOwner != nil {
		h.DaemonPortOwner = ev.daemonPortOwner
	}
	if portOwnerMismatch {
		mismatch(fmt.Sprintf("%s is held by uid %d, not you", ev.daemonPortListen, ev.daemonPortOwner.UID),
			"stop trusting this port: stop the foreign listener and restart Shuttle, or use the protected Unix socket")
	}
	gatedDaemonTCP := hostClass(h.Class).usesSocket() && hostClass(ev.daemonClass).usesSocket() &&
		strings.HasPrefix(ev.daemonListen, "tcp://") && ev.daemonPeerGate == "uid" && !portOwnerMismatch
	if gatedDaemonTCP {
		h.PeerGate = &ReceiptPeerGate{
			Mode:   "uid",
			Reason: "the daemon uses /proc/net/tcp{,6} to admit loopback peers owned by its uid or root",
		}
	}
	if ev.daemonClass != "" && ev.daemonClass != h.Class {
		mismatch(fmt.Sprintf("the running daemon booted as %s; this host declares %s", ev.daemonClass, h.Class),
			"restart the daemon so it takes the declared class")
	}
	if ev.daemonListen != "" && ev.daemonListen != h.Listen {
		mismatch(fmt.Sprintf("the running daemon listens on %s; this host resolves %s", ev.daemonListen, h.Listen),
			"restart the daemon so it binds the resolved listener")
	}
	if socketClass && strings.HasPrefix(ev.daemonListen, "tcp://") && !gatedDaemonTCP {
		mismatch(fmt.Sprintf("the running daemon reports a TCP listener %s on a %s host", ev.daemonListen, h.Class), restartRepair)
	}

	if hostClass(h.Class).usesSocket() {
		if ev.settings.listen.Network == "tcp" && !gatedDaemonTCP {
			mismatch(fmt.Sprintf("class %s declares a TCP listener %s", h.Class, h.Listen),
				fmt.Sprintf("drop the tcp:// listen from %s so the daemon takes the class's unix socket, then restart it; retarget `tailscale serve` and tunnels at the socket",
					describeHostSource(ev.settings.ListenSource, ev.settings.File)))
		}
		for _, l := range h.Listeners {
			if gatedDaemonTCP && l.Role == "daemon" && daemonTCPListenerMatches(l, ev.daemonListen) {
				continue
			}
			mismatch(fmt.Sprintf("%s (%s) listens on TCP %s", l.Process, l.Role, net.JoinHostPort(l.Address, strconv.Itoa(l.Port))), listenerRepair(l.Role))
		}
		if h.HTTPSProxy != "" {
			mismatch(fmt.Sprintf("the fleet file routes https:// remotes through proxy %s, which every local user can reach", h.HTTPSProxy),
				"remove defaults.https_proxy from the fleet file (`felt shuttle remotes path`) and reach remotes without a local proxy")
		}
		if d := h.SocketDir; d != nil {
			switch {
			case d.Symlink:
				mismatch(fmt.Sprintf("socket directory %s is a symlink", d.Path),
					fmt.Sprintf("replace the symlink %s with a real directory (mode 0700), then restart the daemon", d.Path))
			case d.Exists && (d.Mode != "0700" || !d.OwnerOK):
				mismatch(fmt.Sprintf("socket directory %s is mode %s, owner_ok=%v", d.Path, d.Mode, d.OwnerOK),
					fmt.Sprintf("chmod 700 %s and make sure you own it, then restart the daemon", d.Path))
			}
			if d.BadAncestor != "" {
				mismatch(fmt.Sprintf("socket directory ancestor %s", d.BadAncestor),
					"move the daemon's socket under a path whose every directory is owned by you or root and not group- or other-writable (set SHUTTLE_DATA_DIR or host.json \"listen\")")
			}
		}
		if h.Status == receiptHealthy {
			var missing []string
			if h.ListenersFrom == "" {
				missing = append(missing, "no tool could enumerate TCP listeners")
				repairs = append(repairs, "install ss (iproute2) or lsof so the receipt can verify no fleet process listens on TCP")
			}
			if h.UsersLoggedIn == nil {
				missing = append(missing, "`who` could not report logged-in users")
				repairs = append(repairs, "install `who` (coreutils) so the receipt can see who shares this host")
			}
			if len(missing) > 0 {
				h.Status = receiptPartial
				h.Problems = append(h.Problems, missing...)
			}
		}
	} else if h.UsersLoggedIn != nil && *h.UsersLoggedIn > 1 {
		mismatch(fmt.Sprintf("%d distinct users are logged in", *h.UsersLoggedIn),
			fmt.Sprintf("%d distinct users are logged in; declare shared-multi-user: `felt shuttle host class shared-multi-user`, then restart the daemon", *h.UsersLoggedIn))
	}
	h.Repair = strings.Join(repairs, "; ")
	return h
}

// daemonTCPListenerMatches identifies the live listener named by /version.
func daemonTCPListenerMatches(listener ReceiptListener, listen string) bool {
	if !strings.HasPrefix(listen, "tcp://") {
		return false
	}

	address, portText, err := net.SplitHostPort(strings.TrimPrefix(listen, "tcp://"))
	if err != nil {
		return false
	}
	port, err := strconv.Atoi(portText)
	return err == nil && listener.Address == address && listener.Port == port
}

// listenerRepair is the remedy for a fleet TCP listener on a host whose
// class already requires a unix socket.
func listenerRepair(role string) string {
	switch role {
	case "tunnel":
		return "stop the tunnel's TCP local end: disable that remote or set its tunnel.manager to none, then rerun `felt shuttle tunnels install`"
	case "tailscaled":
		return "run tailscaled without a local TCP listener (no --outbound-http-proxy-listen or --socks5-server), and point `tailscale serve` at the daemon's socket"
	}
	return "restart onto a daemon that gates TCP peers by uid, or remove the TCP override and use the class's unix socket"
}

// hostFileRepair words the repair for a host file or listener setting that
// does not resolve; err already names its source.
func hostFileRepair(err error) string {
	return fmt.Sprintf("fix the daemon listener setting: %v", err)
}

// classifyFleetListeners keeps the listeners that belong to the fleet: the
// daemon (recognized by command line, anything on a daemon port, or a process
// named shuttle), a tunnel
// (autossh anywhere, or anything on a fleet-file tunnel port), and
// tailscaled. Duplicates — one socket per address family — collapse.
func classifyFleetListeners(raw []rawListener, daemonPorts, tunnelPorts []int, isDaemonCommand func(string) bool) []ReceiptListener {
	out := []ReceiptListener{}
	seen := map[string]bool{}
	for _, l := range raw {
		role := ""
		switch {
		// A bare beam.smp name is not evidence: every Erlang VM on the host
		// (a language server, a test run) has it, and the listener check
		// would flag a colleague's editor as the daemon. The daemon's port is.
		case l.Process == "shuttle" || slices.Contains(daemonPorts, l.Port) ||
			(isDaemonCommand != nil && l.Command != "" && isDaemonCommand(l.Command)):
			role = "daemon"
		case l.Process == "autossh" || slices.Contains(tunnelPorts, l.Port):
			role = "tunnel"
		case l.Process == "tailscaled":
			role = "tailscaled"
		default:
			continue
		}
		key := fmt.Sprintf("%s/%d/%s/%d", l.Process, l.PID, l.Address, l.Port)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ReceiptListener{Process: l.Process, PID: l.PID, Command: l.Command, Address: l.Address, Port: l.Port, Role: role})
	}
	return out
}

// enumerateListeners lists this user's listening TCP sockets with the tool
// the platform has, returning the tool's name, or "" when none worked.
func enumerateListeners() ([]rawListener, string) {
	uid := os.Getuid()
	switch runtime.GOOS {
	case "linux":
		if _, err := exec.LookPath("ss"); err == nil {
			if out, err := exec.Command("ss", "-ltnpH").Output(); err == nil {
				return parseSSListeners(string(out)), "ss"
			}
		}
		if ls, err := procListeners("/proc", uid); err == nil {
			return ls, "proc"
		}
	case "darwin":
		if _, err := exec.LookPath("lsof"); err == nil {
			out, err := exec.Command("lsof", "+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-u", strconv.Itoa(uid), "-F", "pcn").Output()
			// lsof exits 1 when nothing matched; empty output is an empty list.
			if err == nil || (len(out) == 0 && isExitCode(err, 1)) {
				return parseLsofListeners(string(out)), "lsof"
			}
		}
	}
	return nil, ""
}

func isExitCode(err error, code int) bool {
	exit, ok := err.(*exec.ExitError)
	return ok && exit.ExitCode() == code
}

// parseSSListeners reads `ss -ltnpH`: state, recv-q, send-q, local, peer,
// then an optional users:(("name",pid=N,fd=M),...) process column. ss only
// names processes the caller may inspect, so on a shared host the rows
// without one belong to someone else and are skipped.
func parseSSListeners(out string) []rawListener {
	var ls []rawListener
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || fields[0] != "LISTEN" {
			continue
		}
		addr, port, ok := splitListenAddr(fields[3])
		if !ok {
			continue
		}
		users := strings.Join(fields[5:], " ")
		for _, proc := range strings.Split(users, "),(") {
			name, pid, ok := parseSSUser(proc)
			if ok {
				ls = append(ls, rawListener{Process: name, PID: pid, Address: addr, Port: port})
			}
		}
	}
	return ls
}

// parseSSUser reads one `"name",pid=N,fd=M` entry.
func parseSSUser(entry string) (string, int, bool) {
	start := strings.Index(entry, `"`)
	if start < 0 {
		return "", 0, false
	}
	end := strings.Index(entry[start+1:], `"`)
	if end < 0 {
		return "", 0, false
	}
	name := entry[start+1 : start+1+end]
	pid := 0
	if i := strings.Index(entry, "pid="); i >= 0 {
		digits := entry[i+len("pid="):]
		if j := strings.IndexFunc(digits, func(r rune) bool { return r < '0' || r > '9' }); j >= 0 {
			digits = digits[:j]
		}
		pid, _ = strconv.Atoi(digits)
	}
	return name, pid, true
}

// parseLsofListeners reads `lsof -F pcn`: a "p<pid>" line opens a process,
// "c<command>" names it, and each "n<addr:port>" is one listening socket.
func parseLsofListeners(out string) []rawListener {
	var ls []rawListener
	pid, name := 0, ""
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
			name = ""
		case 'c':
			name = line[1:]
		case 'n':
			if addr, port, ok := splitListenAddr(line[1:]); ok {
				ls = append(ls, rawListener{Process: name, PID: pid, Address: addr, Port: port})
			}
		}
	}
	return ls
}

// splitListenAddr splits "127.0.0.1:4000", "[::1]:4000", "*:4000" or
// "0.0.0.0:*"-style local addresses; a "%iface" zone is dropped.
func splitListenAddr(s string) (string, int, bool) {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return "", 0, false
	}
	port, err := strconv.Atoi(s[i+1:])
	if err != nil {
		return "", 0, false
	}
	addr := strings.TrimSuffix(strings.TrimPrefix(s[:i], "["), "]")
	if j := strings.Index(addr, "%"); j >= 0 {
		addr = addr[:j]
	}
	return addr, port, true
}

// procListeners is the ss-less Linux path: LISTEN rows of /proc/net/tcp{,6}
// owned by uid, joined to their process through /proc/<pid>/fd socket inodes.
func procListeners(procRoot string, uid int) ([]rawListener, error) {
	rows, err := readProcTCP(procRoot)
	if err != nil {
		return nil, err
	}
	owners := procSocketOwners(procRoot)
	var ls []rawListener
	for _, r := range rows {
		if r.UID != uid {
			continue
		}
		l := rawListener{Address: r.Address, Port: r.Port}
		if o, ok := owners[r.Inode]; ok {
			l.Process, l.PID = o.name, o.pid
		}
		ls = append(ls, l)
	}
	return ls, nil
}

// procListenerOwners reads LISTEN rows for one exact address and port without
// filtering by uid. An absent row is not an error: the daemon may be down.
func procListenerOwners(procRoot, address string, port int) ([]int, error) {
	rows, err := readProcTCP(procRoot)
	if err != nil {
		return nil, err
	}
	var uids []int
	for _, row := range rows {
		if row.Address == address && row.Port == port {
			uids = append(uids, row.UID)
		}
	}
	return uids, nil
}

// refuseForeignDaemonPortOwner blocks a local daemon dial when /proc names a
// listener owned by another uid. No row or unreadable /proc leaves the daemon
// availability check to the request itself.
func refuseForeignDaemonPortOwner(procRoot, listen string, callerUID int) error {
	if !strings.HasPrefix(listen, "tcp://") {
		return nil
	}
	address, portText, err := net.SplitHostPort(strings.TrimPrefix(listen, "tcp://"))
	if err != nil {
		return nil
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return nil
	}
	uids, err := procListenerOwners(procRoot, address, port)
	if err != nil {
		return nil
	}
	for _, uid := range uids {
		if uid != callerUID {
			return fmt.Errorf("refusing to talk to %s: held by uid %d, not you", net.JoinHostPort(address, portText), uid)
		}
	}
	return nil
}

func readProcTCP(procRoot string) ([]procTCPRow, error) {
	var rows []procTCPRow
	read := false
	for _, name := range []string{"tcp", "tcp6"} {
		data, err := os.ReadFile(filepath.Join(procRoot, "net", name))
		if err != nil {
			continue
		}
		read = true
		rows = append(rows, parseProcNetTCP(string(data))...)
	}
	if !read {
		return nil, fmt.Errorf("no %s/net/tcp", procRoot)
	}
	return rows, nil
}

type procTCPRow struct {
	Address string
	Port    int
	UID     int
	Inode   string
}

// parseProcNetTCP reads the LISTEN (st 0A) rows of /proc/net/tcp or tcp6:
//
//	sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
//
// The local address is hex in host byte order, one 32-bit word at a time.
func parseProcNetTCP(data string) []procTCPRow {
	var rows []procTCPRow
	sc := bufio.NewScanner(strings.NewReader(data))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 10 || f[3] != "0A" {
			continue
		}
		hexAddr, hexPort, ok := strings.Cut(f[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseInt(hexPort, 16, 32)
		if err != nil {
			continue
		}
		uid, err := strconv.Atoi(f[7])
		if err != nil {
			continue
		}
		rows = append(rows, procTCPRow{Address: decodeProcAddr(hexAddr), Port: int(port), UID: uid, Inode: f[9]})
	}
	return rows
}

func decodeProcAddr(h string) string {
	raw, err := hex.DecodeString(h)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return h
	}
	// Each 4-byte word is little-endian on every architecture Linux reports
	// this way for; reverse within words.
	ip := make(net.IP, len(raw))
	for w := 0; w < len(raw); w += 4 {
		for b := 0; b < 4; b++ {
			ip[w+b] = raw[w+3-b]
		}
	}
	return ip.String()
}

type procOwner struct {
	pid  int
	name string
}

// procSocketOwners maps socket inode → owning process. Unreadable processes
// (another user's) are skipped; their sockets stay unnamed.
func procSocketOwners(procRoot string) map[string]procOwner {
	owners := map[string]procOwner{}
	entries, _ := os.ReadDir(procRoot)
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		fdDir := filepath.Join(procRoot, e.Name(), "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		comm, _ := os.ReadFile(filepath.Join(procRoot, e.Name(), "comm"))
		name := strings.TrimSpace(string(comm))
		for _, fd := range fds {
			target, err := os.Readlink(filepath.Join(fdDir, fd.Name()))
			if err != nil || !strings.HasPrefix(target, "socket:[") {
				continue
			}
			owners[strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")] = procOwner{pid: pid, name: name}
		}
	}
	return owners
}

// countLoggedInUsers counts the distinct user names in `who` output.
func countLoggedInUsers(out string) int {
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		if f := strings.Fields(line); len(f) > 0 {
			seen[f[0]] = true
		}
	}
	return len(seen)
}

func inspectSocketDir(dir string, euid int) *ReceiptSocketDir {
	d := &ReceiptSocketDir{Path: dir}
	if info, err := os.Lstat(dir); err == nil {
		d.Exists = true
		d.Symlink = info.Mode()&os.ModeSymlink != 0
		d.Mode = fmt.Sprintf("%04o", info.Mode().Perm())
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			d.OwnerOK = int(st.Uid) == euid
		}
	}
	d.BadAncestor = firstUnsafeAncestor(filepath.Dir(dir), euid)
	return d
}

// firstUnsafeAncestor walks from dir up to "/" — through the real path, as
// OpenSSH does, so a symlinked ancestor is judged by its target — and names
// the first directory another user could rename the tree out of: owned by
// neither euid nor root, or group/other-writable without the sticky bit. A
// directory that does not exist yet is skipped; its nearest existing ancestor
// is what decides who can create it.
func firstUnsafeAncestor(dir string, euid int) string {
	for {
		if _, err := os.Lstat(dir); err == nil {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return fmt.Sprintf("%s (unresolvable: %v)", dir, err)
	}
	for p := real; ; p = filepath.Dir(p) {
		info, err := os.Stat(p)
		if err != nil {
			return fmt.Sprintf("%s (unreadable: %v)", p, err)
		}
		if reason := unsafeDirReason(info, euid); reason != "" {
			return fmt.Sprintf("%s (%s)", p, reason)
		}
		if parent := filepath.Dir(p); parent == p {
			return ""
		}
	}
}

// unsafeDirReason is StrictModes' test for one directory.
func unsafeDirReason(info os.FileInfo, euid int) string {
	st, ok := info.Sys().(*syscall.Stat_t)
	if ok && int(st.Uid) != euid && st.Uid != 0 {
		return fmt.Sprintf("owned by uid %d", st.Uid)
	}
	mode := info.Mode()
	if mode.Perm()&0o022 != 0 && mode&os.ModeSticky == 0 {
		return fmt.Sprintf("mode %04o is group- or other-writable without the sticky bit", mode.Perm())
	}
	return ""
}
