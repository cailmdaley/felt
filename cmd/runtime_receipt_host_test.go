package cmd

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseSSListeners(t *testing.T) {
	out := `LISTEN 0      4096       127.0.0.1:4000       0.0.0.0:*    users:(("beam.smp",pid=1234,fd=20))
LISTEN 0      128            [::1]:4001          [::]:*    users:(("ssh",pid=55,fd=5),("autossh",pid=54,fd=3))
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      511   [fe80::1%eth0]:8080          [::]:*    users:(("node",pid=77,fd=9))
garbage line
`
	got := parseSSListeners(out)
	want := []rawListener{
		{Process: "beam.smp", PID: 1234, Address: "127.0.0.1", Port: 4000},
		{Process: "ssh", PID: 55, Address: "::1", Port: 4001},
		{Process: "autossh", PID: 54, Address: "::1", Port: 4001},
		{Process: "node", PID: 77, Address: "fe80::1", Port: 8080},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseLsofListeners(t *testing.T) {
	out := "p1234\ncbeam.smp\nf20\nn127.0.0.1:4000\nf21\nn[::1]:4000\np88\nctailscaled\nf9\nn*:1055\np90\ncsome app\nf3\nn*:7000\n"
	got := parseLsofListeners(out)
	want := []rawListener{
		{Process: "beam.smp", PID: 1234, Address: "127.0.0.1", Port: 4000},
		{Process: "beam.smp", PID: 1234, Address: "::1", Port: 4000},
		{Process: "tailscaled", PID: 88, Address: "*", Port: 1055},
		{Process: "some app", PID: 90, Address: "*", Port: 7000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseProcNetTCP(t *testing.T) {
	// 0100007F:0FA0 is 127.0.0.1:4000 (LISTEN, uid 1000); the ESTABLISHED row
	// (01) and the header are skipped.
	v4 := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0FA1 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1 0000000000000000 100 0 0 10 0
`
	// ::1 port 4001, uid 0.
	v6 := `   0: 00000000000000000000000001000000:0FA1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5151 1 0000000000000000 100 0 0 10 0
`
	got := append(parseProcNetTCP(v4), parseProcNetTCP(v6)...)
	want := []procTCPRow{
		{Address: "127.0.0.1", Port: 4000, UID: 1000, Inode: "4242"},
		{Address: "::1", Port: 4001, UID: 0, Inode: "5151"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

// TestProcListeners — the ss-less path joins rows to processes through a
// fake /proc and keeps only the caller's uid.
func TestProcListeners(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "net"), 0o755))
	must(os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(
		"  sl  local_address rem_address   st\n"+
			"   0: 0100007F:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1\n"+
			"   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9999 1\n"), 0o644))
	must(os.MkdirAll(filepath.Join(root, "1234", "fd"), 0o755))
	must(os.WriteFile(filepath.Join(root, "1234", "comm"), []byte("beam.smp\n"), 0o644))
	must(os.Symlink("socket:[4242]", filepath.Join(root, "1234", "fd", "20")))

	got, err := procListeners(root, 1000)
	if err != nil {
		t.Fatal(err)
	}
	want := []rawListener{{Process: "beam.smp", PID: 1234, Address: "127.0.0.1", Port: 4000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	if _, err := procListeners(filepath.Join(root, "absent"), 1000); err == nil {
		t.Error("a missing /proc must be an error so the caller reports partial")
	}
}

func TestCountLoggedInUsers(t *testing.T) {
	out := "alice    pts/0  2026-09-01 10:00 (10.0.0.2)\nalice    pts/1  2026-09-01 10:05\nbob      pts/2  2026-09-01 11:00\n\n"
	if got := countLoggedInUsers(out); got != 2 {
		t.Errorf("got %d, want 2", got)
	}
	if got := countLoggedInUsers(""); got != 0 {
		t.Errorf("empty: got %d", got)
	}
}

func TestClassifyFleetListeners(t *testing.T) {
	raw := []rawListener{
		{Process: "beam.smp", PID: 1, Address: "127.0.0.1", Port: 4000},
		{Process: "beam.smp", PID: 1, Address: "127.0.0.1", Port: 4000}, // v4/v6 duplicate
		{Process: "node", PID: 2, Address: "127.0.0.1", Port: 4100},     // on the daemon's port
		{Process: "ssh", PID: 3, Address: "127.0.0.1", Port: 4001},      // on a tunnel port
		{Process: "ssh", PID: 4, Address: "127.0.0.1", Port: 9000},      // an ad-hoc forward: not fleet
		{Process: "autossh", PID: 5, Address: "127.0.0.1", Port: 20000},
		{Process: "tailscaled", PID: 6, Address: "127.0.0.1", Port: 1055},
		{Process: "postgres", PID: 7, Address: "127.0.0.1", Port: 5432},
		{Process: "beam.smp", PID: 8, Address: "127.0.0.1", Port: 50990}, // another Erlang VM
	}
	got := classifyFleetListeners(raw, []int{4000, 4100}, []int{4001}, nil)
	roles := map[int]string{}
	for _, l := range got {
		roles[l.PID] = l.Role
	}
	want := map[int]string{1: "daemon", 2: "daemon", 3: "tunnel", 5: "tunnel", 6: "tailscaled"}
	if !reflect.DeepEqual(roles, want) || len(got) != 5 {
		t.Fatalf("got %+v", got)
	}
}

func TestEvaluateHost(t *testing.T) {
	one, three := 1, 3
	tcpSettings := func(class string) hostSettings {
		return hostSettings{Class: class, ClassSource: "file", Listen: "tcp://127.0.0.1:4000", listen: listenAddr{"tcp", "127.0.0.1:4000"}}
	}
	unixSettings := func(class string) hostSettings {
		return hostSettings{Class: class, ClassSource: "file", Listen: "unix:///srv/s/sock/daemon.sock", listen: listenAddr{"unix", "/srv/s/sock/daemon.sock"}}
	}
	goodDir := &ReceiptSocketDir{Path: "/srv/s/sock", Exists: true, Mode: "0700", OwnerOK: true}
	daemonTCP := []rawListener{{Process: "beam.smp", PID: 1, Address: "127.0.0.1", Port: 4000}}

	cases := []struct {
		name       string
		ev         hostEvidence
		status     receiptStatus
		repairHas  string
		problemHas string
	}{
		{"single-user alone", hostEvidence{settings: tcpSettings("single-user"), users: &one, listeners: daemonTCP, listenFrom: "lsof", daemonPorts: []int{4000}},
			receiptHealthy, "", ""},
		{"single-user, no who", hostEvidence{settings: tcpSettings("single-user"), daemonPorts: []int{4000}},
			receiptHealthy, "", ""},
		{"single-user, many users", hostEvidence{settings: tcpSettings("single-user"), users: &three, listenFrom: "ss"},
			receiptMismatch, "3 distinct users are logged in; declare shared-multi-user", "3 distinct users"},
		{"single-user ignores missing tools", hostEvidence{settings: tcpSettings("single-user"), users: &one},
			receiptHealthy, "", ""},
		{"shared, clean", hostEvidence{settings: unixSettings("shared-multi-user"), users: &three, socketDir: goodDir, listenFrom: "ss", daemonPorts: []int{4000},
			listeners:       []rawListener{{Process: "beam.smp", PID: 8, Address: "127.0.0.1", Port: 50990, Command: "/usr/lib/erlang/erts/bin/beam.smp -- -root /usr/lib/erlang -progname erl -- -s elixir_ls"}},
			isDaemonCommand: func(cmd string) bool { return isShuttleDaemonCommand(cmd, func(string) bool { return false }) }},
			receiptHealthy, "", ""},
		{"shared, daemon on tcp", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, listeners: daemonTCP, listenFrom: "ss", daemonPorts: []int{4000}},
			receiptMismatch, "restart the daemon so it binds the unix socket; retarget `tailscale serve` and tunnels at it", "beam.smp (daemon) listens on TCP 127.0.0.1:4000"},
		{"exposed, tunnel on tcp", hostEvidence{settings: unixSettings("exposed"), socketDir: goodDir,
			listeners: []rawListener{{Process: "ssh", PID: 2, Address: "::1", Port: 4001}}, listenFrom: "lsof", tunnelPorts: []int{4001}},
			receiptMismatch, "stop the tunnel's TCP local end", "ssh (tunnel) listens on TCP [::1]:4001"},
		{"shared, declared tcp", hostEvidence{settings: tcpSettings("shared-multi-user"), listenFrom: "ss"},
			receiptMismatch, "drop the tcp:// listen from", "declares a TCP listener"},
		{"shared, https proxy", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, listenFrom: "ss", httpsProxy: "localhost:1055"},
			receiptMismatch, "remove defaults.https_proxy", "proxy localhost:1055"},
		{"shared, open socket dir", hostEvidence{settings: unixSettings("shared-multi-user"), listenFrom: "ss",
			socketDir: &ReceiptSocketDir{Path: "/srv/s/sock", Exists: true, Mode: "0755", OwnerOK: true}},
			receiptMismatch, "chmod 700 /srv/s/sock", "mode 0755"},
		{"shared, foreign socket dir", hostEvidence{settings: unixSettings("shared-multi-user"), listenFrom: "ss",
			socketDir: &ReceiptSocketDir{Path: "/srv/s/sock", Exists: true, Mode: "0700", OwnerOK: false}},
			receiptMismatch, "make sure you own it", "owner_ok=false"},
		{"shared, socket dir not yet created", hostEvidence{settings: unixSettings("shared-multi-user"), listenFrom: "ss", users: &one,
			socketDir: &ReceiptSocketDir{Path: "/srv/s/sock"}},
			receiptHealthy, "", ""},
		{"shared, no listener tool", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, users: &one},
			receiptPartial, "install ss", "no tool"},
		{"shared, no who", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, listenFrom: "ss"},
			receiptPartial, "install `who`", "`who` could not"},
		{"shared, symlinked socket dir", hostEvidence{settings: unixSettings("shared-multi-user"), listenFrom: "ss", users: &one,
			socketDir: &ReceiptSocketDir{Path: "/srv/s/sock", Exists: true, Symlink: true, Mode: "0777", OwnerOK: true}},
			receiptMismatch, "replace the symlink", "is a symlink"},
		{"shared, unsafe ancestor", hostEvidence{settings: unixSettings("shared-multi-user"), listenFrom: "ss", users: &one,
			socketDir: &ReceiptSocketDir{Path: "/srv/s/sock", Exists: true, Mode: "0700", OwnerOK: true, BadAncestor: "/srv/s (mode 0777 is group- or other-writable without the sticky bit)"}},
			receiptMismatch, "owned by you or root", "ancestor /srv/s"},
		// The daemon's own report catches what enumeration misses: a live
		// daemon on a port this shell does not know about.
		{"shared, daemon reports tcp", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, listenFrom: "ss", users: &one,
			daemonClass: "shared-multi-user", daemonListen: "tcp://127.0.0.1:4999"},
			receiptMismatch, "restart the daemon so it binds the unix socket", "reports a TCP listener tcp://127.0.0.1:4999"},
		{"daemon booted under another class", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, listenFrom: "ss", users: &one,
			daemonClass: "single-user", daemonListen: "tcp://127.0.0.1:4000"},
			receiptMismatch, "takes the declared class", "booted as single-user"},
		{"single-user daemon agrees", hostEvidence{settings: tcpSettings("single-user"), users: &one,
			daemonClass: "single-user", daemonListen: "tcp://127.0.0.1:4000"},
			receiptHealthy, "", ""},
		{"shared daemon agrees", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, listenFrom: "ss", users: &one,
			daemonClass: "shared-multi-user", daemonListen: "unix:///srv/s/sock/daemon.sock"},
			receiptHealthy, "", ""},
		{"daemon on a port this shell does not use", hostEvidence{settings: unixSettings("exposed"), socketDir: goodDir, listenFrom: "lsof", users: &one,
			listeners: []rawListener{{Process: "beam.smp", PID: 9, Address: "127.0.0.1", Port: 4999, Command: "/opt/shuttle/erts-16/bin/beam.smp -- -root /opt/shuttle -progname erl"}},
			isDaemonCommand: func(cmd string) bool {
				return isShuttleDaemonCommand(cmd, func(p string) bool { return p == "/opt/shuttle/bin/shuttled" })
			}},
			receiptMismatch, "restart the daemon so it binds", "beam.smp (daemon) listens on TCP 127.0.0.1:4999"},
		{"shared, no tool but a proxy", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, httpsProxy: "localhost:1055"},
			receiptMismatch, "https_proxy", "proxy"},
		{"broken host file", hostEvidence{settingsErr: errors.New("host.json: class \"x\" is not one of …")},
			receiptMismatch, "fix the daemon listener setting", "class \"x\""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := evaluateHost(tc.ev)
			if got.Status != tc.status {
				t.Fatalf("status = %s, want %s (%+v)", got.Status, tc.status, got)
			}
			if !strings.Contains(got.Repair, tc.repairHas) {
				t.Errorf("repair %q lacks %q", got.Repair, tc.repairHas)
			}
			if tc.status == receiptHealthy && (got.Repair != "" || len(got.Problems) != 0) {
				t.Errorf("healthy host carries findings: %+v", got)
			}
			if tc.problemHas != "" && !strings.Contains(strings.Join(got.Problems, "\n"), tc.problemHas) {
				t.Errorf("problems %q lack %q", got.Problems, tc.problemHas)
			}
			if got.Listeners == nil {
				t.Error("listeners must encode as [], never null")
			}
		})
	}
}

// TestEvaluateHost_OneRepairPerRemedy — each listener is its own problem, but
// two daemon listeners share one repair, and each role words its own.
func TestEvaluateHost_OneRepairPerRemedy(t *testing.T) {
	got := evaluateHost(hostEvidence{
		settings:    hostSettings{Class: "exposed", Listen: "unix:///srv/s.sock", listen: listenAddr{"unix", "/srv/s.sock"}},
		listenFrom:  "ss",
		daemonPorts: []int{4000},
		listeners: []rawListener{
			{Process: "beam.smp", PID: 1, Address: "127.0.0.1", Port: 4000},
			{Process: "beam.smp", PID: 1, Address: "::1", Port: 4000},
			{Process: "autossh", PID: 2, Address: "127.0.0.1", Port: 4001},
			{Process: "tailscaled", PID: 3, Address: "127.0.0.1", Port: 1055},
		},
	})
	if len(got.Problems) != 4 || strings.Count(got.Repair, "restart the daemon so it binds") != 1 ||
		!strings.Contains(got.Repair, "stop the tunnel") || !strings.Contains(got.Repair, "run tailscaled without") {
		t.Fatalf("got %+v", got)
	}
	if strings.Contains(got.Repair, "felt shuttle host class") {
		t.Errorf("an already-socket class must not be told to declare its class: %q", got.Repair)
	}
}

func TestInspectSocketDir(t *testing.T) {
	euid := os.Geteuid()
	base := t.TempDir()
	dir := filepath.Join(base, "sock")
	if d := inspectSocketDir(dir, euid); d.Exists || d.BadAncestor != "" {
		t.Errorf("absent dir under a private temp dir: %+v", d)
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(dir, 0o700)
	if d := inspectSocketDir(dir, euid); !d.Exists || d.Symlink || d.Mode != "0700" || !d.OwnerOK || d.BadAncestor != "" {
		t.Errorf("private dir: %+v", d)
	}
	if d := inspectSocketDir(dir, euid+1); d.OwnerOK {
		t.Errorf("another euid must not own it: %+v", d)
	}

	// A symlink is reported as one (Lstat), not as its target's mode.
	link := filepath.Join(base, "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	if d := inspectSocketDir(link, euid); !d.Symlink {
		t.Errorf("symlink not reported: %+v", d)
	}

	// A world-writable, non-sticky ancestor is named; a sticky one is fine.
	open := filepath.Join(base, "open")
	inner := filepath.Join(open, "sock")
	if err := os.MkdirAll(inner, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(open, 0o777)
	if d := inspectSocketDir(inner, euid); !strings.Contains(d.BadAncestor, "open") || !strings.Contains(d.BadAncestor, "0777") {
		t.Errorf("open ancestor not reported: %+v", d)
	}
	_ = os.Chmod(open, 0o777|os.ModeSticky)
	if d := inspectSocketDir(inner, euid); d.BadAncestor != "" {
		t.Errorf("sticky ancestor reported: %+v", d)
	}
}

func TestIsShuttleDaemonCommand(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "bin", "shuttled"), nil, 0o755)
	cases := []struct {
		cmd  string
		want bool
	}{
		{root + "/erts-16.4/bin/beam.smp -- -root " + root + " -bindir x -progname erl", true},
		{"/home/op/dev/felt/bin/rel/erts-16.4/bin/beam.smp -- -root /home/op/dev/felt/bin/rel", true},
		{"/opt/rel/bin/shuttled start", true},
		{"/usr/lib/erlang/erts/bin/beam.smp -- -root /usr/lib/erlang -progname erl -- -s elixir_ls", false},
		{"beam.smp -- -root", false},
	}
	for _, tc := range cases {
		if got := isShuttleDaemonCommand(tc.cmd, fileExists); got != tc.want {
			t.Errorf("%q: got %v, want %v", tc.cmd, got, tc.want)
		}
	}
}

func TestParsePSCommands(t *testing.T) {
	out := "  38927 /opt/rel/erts/bin/beam.smp -- -root /opt/rel -progname erl\n  101 /usr/bin/ssh -N -L 4001:localhost:4000 hub-a\n\nbogus\n"
	got := parsePSCommands(out)
	if got[38927] != "/opt/rel/erts/bin/beam.smp -- -root /opt/rel -progname erl" || got[101] != "/usr/bin/ssh -N -L 4001:localhost:4000 hub-a" || len(got) != 2 {
		t.Errorf("got %v", got)
	}
}

func TestFoldComponentRepair(t *testing.T) {
	cases := []struct {
		name, before, component, want string
		status                        receiptStatus
	}{
		{"replaces generic", receiptRepair(receiptMismatch), "fix host", "fix host", receiptMismatch},
		{"appends to specific", "fix felt", "fix host", "fix felt; also: fix host", receiptMismatch},
		{"no duplicate", "fix host", "fix host", "fix host", receiptMismatch},
		{"other status untouched", "fix felt", "fix host", "fix felt", receiptPartial},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := RuntimeReceipt{Status: receiptMismatch, Repair: tc.before, Generation: ReceiptGenerationReceipt{Status: receiptHealthy}}
			foldComponentRepair(&r, tc.status, tc.component)
			if r.Repair != tc.want {
				t.Errorf("repair = %q, want %q", r.Repair, tc.want)
			}
		})
	}
}
