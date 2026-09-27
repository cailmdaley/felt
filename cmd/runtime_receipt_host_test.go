package cmd

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
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

func procAddressHex(address net.IP) string {
	if ipv4 := address.To4(); ipv4 != nil {
		address = ipv4
	} else {
		address = address.To16()
	}
	return procAddressHexBytes(address)
}

func procAddressHex6(address net.IP) string { return procAddressHexBytes(address.To16()) }

func procAddressHexBytes(address net.IP) string {
	if address == nil || (len(address) != 4 && len(address) != 16) {
		panic("invalid proc address fixture")
	}
	encoded := make([]byte, len(address))
	for i := 0; i < len(address); i += 4 {
		binary.NativeEndian.PutUint32(encoded[i:i+4], binary.BigEndian.Uint32(address[i:i+4]))
	}
	return fmt.Sprintf("%X", encoded)
}

func procTCPRowFixture(local net.IP, localPort int, remote net.IP, remotePort int, state string, uid int, inode string, tcp6 bool) string {
	encode := procAddressHex
	if tcp6 {
		encode = procAddressHex6
	}
	return fmt.Sprintf("   0: %s:%04X %s:%04X %s 00000000:00000000 00:00000000 00000000 %5d        0 %s 1\n",
		encode(local), localPort, encode(remote), remotePort, state, uid, inode)
}

func writeProcTCPFixture(t *testing.T, root, tcp, tcp6 string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"tcp": tcp, "tcp6": tcp6} {
		if err := os.WriteFile(filepath.Join(root, "net", name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestParseProcNetTCP(t *testing.T) {
	loopback4 := procAddressHex(net.IPv4(127, 0, 0, 1))
	loopback6 := procAddressHex(net.ParseIP("::1"))
	v4 := fmt.Sprintf("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"+
		"   0: %s:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0\n"+
		"   1: %s:0FA1 %s:D431 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1 0000000000000000 100 0 0 10 0\n",
		loopback4, loopback4, loopback4)
	// ::1 port 4001, uid 0.
	v6 := fmt.Sprintf("   0: %s:0FA1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5151 1 0000000000000000 100 0 0 10 0\n", loopback6)
	got := append(parseProcNetTCP(v4), parseProcNetTCP(v6)...)
	want := []procTCPRow{
		{Address: "127.0.0.1", Port: 4000, RemoteAddress: "0.0.0.0", State: "0A", UID: 1000, Inode: "4242"},
		{Address: "::1", Port: 4001, RemoteAddress: "::", State: "0A", UID: 0, Inode: "5151"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

// Negative control: changing row.UID != callerUID to == makes the foreign-owner case fail.
func TestCheckProcTCPConnectionOwner(t *testing.T) {
	serverIP, clientIP := net.IPv4(127, 0, 0, 1), net.IPv4(127, 0, 0, 1)
	const serverPort, clientPort = 4000, 51432

	t.Run("established row owned by caller", func(t *testing.T) {
		root := t.TempDir()
		writeProcTCPFixture(t, root, procTCPRowFixture(serverIP, serverPort, clientIP, clientPort, "01", 1000, "4242", false), "")
		if err := checkProcTCPConnectionOwner(root, "127.0.0.1:4000", "127.0.0.1:51432", 1000); err != nil {
			t.Fatalf("own established row refused: %v", err)
		}
	})

	t.Run("foreign established row refused", func(t *testing.T) {
		root := t.TempDir()
		writeProcTCPFixture(t, root, procTCPRowFixture(serverIP, serverPort, clientIP, clientPort, "01", 2000, "4242", false), "")
		err := checkProcTCPConnectionOwner(root, "127.0.0.1:4000", "127.0.0.1:51432", 1000)
		if err == nil || err.Error() != "127.0.0.1:4000 is held by uid 2000, not you" {
			t.Fatalf("foreign owner error = %v", err)
		}
	})

	t.Run("missing established row is one-shot pending", func(t *testing.T) {
		root := t.TempDir()
		writeProcTCPFixture(t, root, procTCPRowFixture(serverIP, serverPort, clientIP, clientPort, "03", 1000, "4242", false), "")
		err := checkProcTCPConnectionOwner(root, "127.0.0.1:4000", "127.0.0.1:51432", 1000)
		var owner *daemonTCPOwnerCheckError
		if !errors.As(err, &owner) || !owner.pending || owner.foreign || !strings.Contains(err.Error(), "no established row yet") {
			t.Fatalf("missing row error = %v; want one-shot pending", err)
		}
	})

	t.Run("v4-mapped tcp6 row matches", func(t *testing.T) {
		root := t.TempDir()
		mapped := net.ParseIP("::ffff:127.0.0.1")
		writeProcTCPFixture(t, root, "", procTCPRowFixture(mapped, serverPort, mapped, clientPort, "01", 1000, "4242", true))
		if err := checkProcTCPConnectionOwner(root, "127.0.0.1:4000", "127.0.0.1:51432", 1000); err != nil {
			t.Fatalf("v4-mapped row refused: %v", err)
		}
	})

	t.Run("uid-0 row is one-shot pending for every caller", func(t *testing.T) {
		// The kernel reports uid 0 on the server-side row until accept(); the
		// one-shot check cannot distinguish an unaccepted connection from a
		// root-owned listener.
		root := t.TempDir()
		writeProcTCPFixture(t, root, procTCPRowFixture(serverIP, serverPort, clientIP, clientPort, "01", 0, "4242", false), "")
		err := checkProcTCPConnectionOwner(root, "127.0.0.1:4000", "127.0.0.1:51432", 1000)
		var owner *daemonTCPOwnerCheckError
		if !errors.As(err, &owner) || !owner.pending || owner.foreign {
			t.Fatalf("uid-0 row should be pending, got %v", err)
		}
		if !strings.Contains(err.Error(), "not accepted") {
			t.Fatalf("pending message = %v", err)
		}
		rootErr := checkProcTCPConnectionOwner(root, "127.0.0.1:4000", "127.0.0.1:51432", 0)
		if !errors.As(rootErr, &owner) || !owner.pending || owner.foreign {
			t.Fatalf("root caller should also see uid-0 as pending, got %v", rootErr)
		}
	})

	t.Run("unreadable proc fails closed", func(t *testing.T) {
		err := checkProcTCPConnectionOwner(filepath.Join(t.TempDir(), "absent"), "127.0.0.1:4000", "127.0.0.1:51432", 1000)
		if err == nil || !strings.Contains(err.Error(), "cannot read /proc/net/tcp") {
			t.Fatalf("unreadable proc error = %v", err)
		}
	})
}

func TestDialAndCheckDaemonTCPWaitsForAccept(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the connection owner check reads Linux /proc")
	}
	const callerUID = 1 // Exercise the non-root refusal even when the test process is root.
	wait := 100 * time.Millisecond
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, address)
	}
	listen := func(t *testing.T) *net.TCPListener {
		t.Helper()
		listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = listener.Close() })
		return listener
	}

	t.Run("refuses an unaccepted socket after the wait", func(t *testing.T) {
		listener := listen(t)
		started := time.Now()
		conn, err := dialAndCheckDaemonTCP(context.Background(), dial, "tcp4", listener.Addr().String(), "/proc", callerUID, wait)
		elapsed := time.Since(started)
		if conn != nil {
			_ = conn.Close()
			t.Fatal("unaccepted socket was returned as an owned connection")
		}
		var ownerErr *daemonTCPOwnerCheckError
		if !errors.As(err, &ownerErr) || !ownerErr.pending || ownerErr.foreign {
			t.Fatalf("owner check error = %v; want a pending refusal", err)
		}
		if elapsed < wait || elapsed > wait+time.Second {
			t.Fatalf("refusal took %s; want about %s", elapsed, wait)
		}
	})

	t.Run("root waits before admitting uid zero", func(t *testing.T) {
		listener := listen(t)
		started := time.Now()
		conn, err := dialAndCheckDaemonTCP(context.Background(), dial, "tcp4", listener.Addr().String(), "/proc", 0, wait)
		elapsed := time.Since(started)
		if err != nil || conn == nil {
			t.Fatalf("root owner result = %v, %v; want admission after the wait", conn, err)
		}
		_ = conn.Close()
		if elapsed < wait || elapsed > wait+time.Second {
			t.Fatalf("root admission took %s; want about %s", elapsed, wait)
		}
	})

	t.Run("context cancellation stops polling", func(t *testing.T) {
		listener := listen(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		started := time.Now()
		conn, err := dialAndCheckDaemonTCP(ctx, dial, "tcp4", listener.Addr().String(), "/proc", callerUID, time.Second)
		elapsed := time.Since(started)
		if conn != nil {
			_ = conn.Close()
			t.Fatal("connection returned after its context expired")
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("owner check error = %v; want context deadline exceeded", err)
		}
		if elapsed >= time.Second {
			t.Fatalf("cancellation took %s; want it before the one-second wait", elapsed)
		}
	})
}

func TestObservedDaemonPortOwnerIncludesLoopbackAndWildcardListeners(t *testing.T) {
	settings := hostSettings{Class: "shared-multi-user", Listen: "tcp://127.0.0.1:4000"}
	ev := hostEvidence{settings: settings, daemonClass: "shared-multi-user", daemonListen: settings.Listen}
	cases := []struct {
		name    string
		address net.IP
		tcp6    bool
	}{
		{"ipv4 loopback", net.IPv4(127, 0, 0, 1), false},
		{"other ipv4 loopback", net.IPv4(127, 0, 0, 2), false},
		{"ipv6 loopback", net.ParseIP("::1"), true},
		{"ipv4 wildcard", net.IPv4zero, false},
		{"ipv6 wildcard", net.ParseIP("::"), true},
		{"mapped ipv4 wildcard", net.ParseIP("::ffff:0.0.0.0"), true},
		{"mapped loopback", net.ParseIP("::ffff:127.0.0.1"), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			row := procTCPRowFixture(tc.address, 4000, net.IPv4zero, 0, "0A", 2000, "4242", tc.tcp6)
			if tc.tcp6 {
				writeProcTCPFixture(t, root, "", row)
			} else {
				writeProcTCPFixture(t, root, row, "")
			}
			owner, listen := observedDaemonPortOwnerFromProc(ev, 1000, root)
			if owner == nil || owner.UID != 2000 || owner.IsCaller || listen != settings.Listen {
				t.Fatalf("observed owner = %+v at %q; want uid 2000 for %s", owner, listen, tc.name)
			}
		})
	}
}

func TestProcListeners(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "net"), 0o755))
	loopback := procAddressHex(net.IPv4(127, 0, 0, 1))
	must(os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(fmt.Sprintf(
		"  sl  local_address rem_address   st\n"+
			"   0: %s:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1\n"+
			"   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9999 1\n", loopback)), 0o644))
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
			receiptMismatch, "restart onto a daemon that gates TCP peers by uid", "beam.smp (daemon) listens on TCP 127.0.0.1:4000"},
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
			receiptMismatch, "restart onto a daemon that gates TCP peers by uid", "reports a TCP listener tcp://127.0.0.1:4999"},
		{"shared, daemon reports tcp without gate", hostEvidence{settings: unixSettings("shared-multi-user"), socketDir: goodDir, listenFrom: "ss", users: &one,
			daemonClass: "shared-multi-user", daemonListen: "tcp://127.0.0.1:4999", daemonPeerGate: "none"},
			receiptMismatch, "restart onto a daemon that gates TCP peers by uid", "reports a TCP listener tcp://127.0.0.1:4999"},
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
			receiptMismatch, "restart onto a daemon that gates TCP peers by uid", "beam.smp (daemon) listens on TCP 127.0.0.1:4999"},
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

func TestEvaluateHostReportsPrivateTailnetSocket(t *testing.T) {
	one := 1
	listen := "unix:///srv/s/sock/daemon.sock"
	dir := shortPrivateTempDir(t)
	tailscaleSocket := filepath.Join(dir, "tailscaled.sock")
	listener, err := net.Listen("unix", tailscaleSocket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	got := evaluateHost(hostEvidence{
		settings: hostSettings{
			Class: "shared-multi-user", ClassSource: "file", Listen: listen,
			listen: listenAddr{"unix", "/srv/s/sock/daemon.sock"},
		},
		users:           &one,
		socketDir:       &ReceiptSocketDir{Path: "/srv/s/sock", Exists: true, Mode: "0700", OwnerOK: true},
		listenFrom:      "ss",
		tailscaleSocket: tailscaleSocket,
	})

	if got.Status != receiptHealthy || got.TailscaleSocket != tailscaleSocket || got.HTTPSProxy != "" ||
		got.TailnetSocketEvidence == nil || !got.TailnetSocketEvidence.Private {
		t.Fatalf("private Tailscale socket receipt = %+v", got)
	}
}

func TestGatherHostEvidenceReportsConfiguredTailnetSocket(t *testing.T) {
	dir := shortPrivateTempDir(t)
	path := filepath.Join(dir, "tailscaled.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	fleet := filepath.Join(dir, "remotes.json")
	contents := fmt.Sprintf(`{"defaults":{"tailscale_socket":%q},"remotes":[{"name":"hub-a","url":"https://hub-a.example.ts.net"}]}`, path)
	if err := os.WriteFile(fleet, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_REMOTES_FILE", fleet)

	got := gatherHostEvidence()
	if got.tailscaleSocket != path || got.tailscaleConfigError != "" ||
		got.tailnetSocketEvidence == nil || !got.tailnetSocketEvidence.Private ||
		!slices.Equal(got.tailnetRemoteNames, []string{"hub-a"}) {
		t.Fatalf("gathered tailnet socket evidence = %+v", got)
	}
}

func TestGatherHostEvidencePreservesMalformedRemotesFileError(t *testing.T) {
	dir := t.TempDir()
	fleet := filepath.Join(dir, "remotes.json")
	if err := os.WriteFile(fleet, []byte(`{"defaults":`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_REMOTES_FILE", fleet)

	ev := gatherHostEvidence()
	if ev.remotesConfigError == "" || ev.tailscaleSocket != "" {
		t.Fatalf("malformed remotes file evidence = %+v", ev)
	}

	listen := "unix:///tmp/shuttle.sock"
	got := evaluateHost(hostEvidence{
		settings: hostSettings{
			Class: "single-user", ClassSource: "file", Listen: listen,
			listen: listenAddr{"unix", "/tmp/shuttle.sock"},
		},
		remotesConfigError: ev.remotesConfigError,
	})
	if got.Status != receiptMismatch || !strings.Contains(strings.Join(got.Problems, "\n"), "cannot read or parse the remotes file") {
		t.Fatalf("malformed remotes file receipt = %+v", got)
	}
}

func TestEvaluateHostReportsDaemonFleetTailnetSocketMismatch(t *testing.T) {
	listen := "unix:///srv/s/sock/daemon.sock"
	got := evaluateHost(hostEvidence{
		settings: hostSettings{
			Class: "shared-multi-user", ClassSource: "file", Listen: listen,
			listen: listenAddr{"unix", "/srv/s/sock/daemon.sock"},
		},
		tailscaleSocket: "/run/from-file/tailscaled.sock",
		tailnetSocketEvidence: &ReceiptTailnetSocket{
			Path: "/run/from-file/tailscaled.sock", Exists: true, Socket: true, OwnerOK: true, Private: true,
		},
		daemonTailnetDial: &ReceiptTailnetDial{Configured: true, Socket: "/run/from-daemon/tailscaled.sock"},
	})
	if got.Status != receiptMismatch || !strings.Contains(strings.Join(got.Problems, "\n"), "daemon uses Tailscale LocalAPI socket") {
		t.Fatalf("daemon/fleet socket mismatch receipt = %+v", got)
	}

	got = evaluateHost(hostEvidence{
		settings: hostSettings{
			Class: "shared-multi-user", ClassSource: "file", Listen: listen,
			listen: listenAddr{"unix", "/srv/s/sock/daemon.sock"},
		},
		tailscaleSocket:       "/run/from-file/tailscaled.sock",
		daemonVersionReported: true,
	})
	if got.Status != receiptMismatch || !strings.Contains(strings.Join(got.Problems, "\n"), "does not report private Tailscale dial support") {
		t.Fatalf("old daemon tailnet support receipt = %+v", got)
	}
}

func TestEvaluateHostReportsUnreadyTailnetBridge(t *testing.T) {
	listen := "unix:///srv/s/sock/daemon.sock"
	got := evaluateHost(hostEvidence{
		settings: hostSettings{
			Class: "shared-multi-user", ClassSource: "file", Listen: listen,
			listen: listenAddr{"unix", "/srv/s/sock/daemon.sock"},
		},
		tailscaleSocket:    "/run/tailscaled.sock",
		tailnetRemoteNames: []string{"hub-a"},
		daemonTailnetDial: &ReceiptTailnetDial{
			Configured: true,
			Socket:     "/run/tailscaled.sock",
			Bridges:    []ReceiptTailnetBridge{{Name: "hub-a", Status: "error", ErrorStage: "localapi_connect", Error: "permission denied"}},
		},
	})
	problems := strings.Join(got.Problems, "\n")
	if got.Status != receiptMismatch || !strings.Contains(problems, "private HTTPS bridge hub-a is error at localapi_connect") {
		t.Fatalf("unready bridge receipt = %+v", got)
	}
}

func TestEvaluateHostRejectsUnconfinedTailnetSocketAndConflictingDefaults(t *testing.T) {
	listen := "unix:///srv/s/sock/daemon.sock"
	base := hostEvidence{
		settings: hostSettings{
			Class: "shared-multi-user", ClassSource: "file", Listen: listen,
			listen: listenAddr{"unix", "/srv/s/sock/daemon.sock"},
		},
		socketDir:  &ReceiptSocketDir{Path: "/srv/s/sock", Exists: true, Mode: "0700", OwnerOK: true},
		listenFrom: "ss",
	}

	t.Run("unconfined socket", func(t *testing.T) {
		path := "/run/tailscaled.sock"
		ev := base
		ev.tailscaleSocket = path
		ev.tailnetSocketEvidence = &ReceiptTailnetSocket{
			Path: path, Exists: true, Socket: true, OwnerOK: true,
			BadAncestor: "no ancestor directory owned by the daemon uid blocks traversal by other users",
		}
		got := evaluateHost(ev)
		if got.Status != receiptMismatch || !strings.Contains(strings.Join(got.Problems, "\n"), "not confined to a private directory") {
			t.Fatalf("unconfined LocalAPI socket receipt = %+v", got)
		}
	})

	t.Run("conflicting defaults", func(t *testing.T) {
		ev := base
		ev.httpsProxy = "localhost:1055"
		ev.tailscaleSocket = "/run/tailscaled.sock"
		ev.tailscaleConfigError = "defaults.https_proxy and defaults.tailscale_socket are mutually exclusive"
		got := evaluateHost(ev)
		if got.Status != receiptMismatch || !strings.Contains(strings.Join(got.Problems, "\n"), "mutually exclusive") {
			t.Fatalf("conflicting dial defaults receipt = %+v", got)
		}
	})
}

// Negative control: a traversable temp directory makes this probe red; mode 0700 restores it.
func TestInspectTailnetSocketPrivateDirectoryBoundary(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "felt-tailnet-socket-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "tailscaled.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	if got := inspectTailnetSocket(path, os.Geteuid()); got.Private {
		t.Fatalf("traversable parent reported private: %+v", got)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := inspectTailnetSocket(path, os.Geteuid()); !got.Private {
		t.Fatalf("private parent not recognized: %+v", got)
	}
}

// Negative control: remove the ACL grant below; the receipt must then report the directory private.
func TestInspectTailnetSocketRejectsACLGrantedTraversal(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS ACLs can grant traversal without changing mode bits")
	}

	dir := shortPrivateTempDir(t)
	path := filepath.Join(dir, "tailscaled.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	output, err := exec.Command("/bin/chmod", "+a", "everyone allow search", dir).CombinedOutput()
	if err != nil {
		t.Fatalf("grant ACL search permission: %v: %s", err, output)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o700 {
		t.Fatalf("ACL changed the directory mode to %04o", mode)
	}

	got := inspectTailnetSocket(path, os.Geteuid())
	if got.Private || !strings.Contains(got.BadAncestor, "ACL") {
		t.Fatalf("ACL-accessible socket directory was reported private: %+v", got)
	}
}

func TestInspectTailnetSocketDistinguishesMissingFileSymlinkAndRegularFile(t *testing.T) {
	dir := shortPrivateTempDir(t)
	missing := inspectTailnetSocket(filepath.Join(dir, "missing.sock"), os.Geteuid())
	if missing.Exists || missing.Error == "" {
		t.Fatalf("missing socket evidence = %+v", missing)
	}

	regular := filepath.Join(dir, "regular")
	if err := os.WriteFile(regular, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := inspectTailnetSocket(regular, os.Geteuid()); !got.Exists || got.Socket || got.Symlink {
		t.Fatalf("regular file evidence = %+v", got)
	}

	socketPath := filepath.Join(dir, "actual.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	link := filepath.Join(dir, "alias.sock")
	if err := os.Symlink(socketPath, link); err != nil {
		t.Fatal(err)
	}
	if got := inspectTailnetSocket(link, os.Geteuid()); !got.Symlink || got.Socket {
		t.Fatalf("symlink evidence = %+v", got)
	}
	if got := inspectTailnetSocket(socketPath, os.Geteuid()); !got.Socket || !got.Private {
		t.Fatalf("unix socket evidence = %+v", got)
	}
}

func shortPrivateTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "td-private-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func TestEvaluateHost_PeerGateUidSourceAndOwner(t *testing.T) {
	callerUID := os.Geteuid()
	foreignUID := callerUID + 1
	listen := "tcp://127.0.0.1:4000"
	settings := hostSettings{
		Class: "shared-multi-user", Listen: listen, listen: listenAddr{"tcp", "127.0.0.1:4000"},
	}
	cases := []struct {
		name, source, problem string
		uid                   int
	}{
		{"environment override", "env", fmt.Sprintf("the daemon admits uid %d (from SHUTTLE_PEER_UID); you are uid %d", callerUID, callerUID), callerUID},
		{"different daemon uid", "euid", fmt.Sprintf("the daemon admits uid %d; you are uid %d", foreignUID, callerUID), foreignUID},
		{"missing uid source", "", "the daemon reports uid gating without saying which uid; restart onto the current build", callerUID},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := evaluateHost(hostEvidence{
				settings: settings, daemonClass: "shared-multi-user", daemonListen: listen, daemonPeerGate: "uid",
				daemonPeerGateUID: &tc.uid, daemonPeerGateUIDSource: tc.source,
			})
			if got.Status != receiptMismatch || !strings.Contains(strings.Join(got.Problems, "\n"), tc.problem) {
				t.Fatalf("peer-gate uid identity finding = %+v, want %q", got, tc.problem)
			}
		})
	}
}

// Negative control: remove the missing-source/value switch case and this daemon can look healthy.
func TestEvaluateHost_UidGateWithoutUidMismatches(t *testing.T) {
	listen := "tcp://127.0.0.1:4000"
	got := evaluateHost(hostEvidence{
		settings: hostSettings{
			Class: "shared-multi-user", Listen: listen, listen: listenAddr{"tcp", "127.0.0.1:4000"},
		},
		daemonClass: "shared-multi-user", daemonListen: listen, daemonPeerGate: "uid",
		daemonPeerGateUIDSource: "euid",
	})
	if got.Status != receiptMismatch || got.PeerGate != nil ||
		!strings.Contains(strings.Join(got.Problems, "\n"), "without saying which uid") {
		t.Fatalf("uid gate without an admitted uid = %+v, want mismatch without a verified PeerGate", got)
	}
}

func TestEvaluateHost_ForeignDaemonPortOwnerOverridesVersionGate(t *testing.T) {
	listen := "tcp://127.0.0.1:4000"
	callerUID := os.Geteuid()
	got := evaluateHost(hostEvidence{
		settings: hostSettings{
			Class: "shared-multi-user", Listen: listen, listen: listenAddr{"tcp", "127.0.0.1:4000"},
		},
		daemonClass:             "shared-multi-user",
		daemonListen:            listen,
		daemonPeerGate:          "uid",
		daemonPeerGateUID:       &callerUID,
		daemonPeerGateUIDSource: "euid",
		daemonPortOwner:         &ReceiptDaemonPortOwner{UID: 2000, IsCaller: false},
		daemonPortListen:        listen,
	})
	if got.Status != receiptMismatch || got.PeerGate != nil {
		t.Fatalf("foreign listener with a forged uid-gate version = %+v", got)
	}
	if got.DaemonPortOwner == nil || got.DaemonPortOwner.UID != 2000 || got.DaemonPortOwner.IsCaller {
		t.Fatalf("daemon port owner not retained: %+v", got.DaemonPortOwner)
	}
	problems := strings.Join(got.Problems, "\n")
	if !strings.Contains(problems, "127.0.0.1:4000 is held by uid 2000, not you") ||
		!strings.Contains(got.Repair, "stop trusting this port") {
		t.Fatalf("foreign listener finding = %+v", got)
	}
}

// TestEvaluateHost_UidGatedDaemonListener checks the daemon exemption and
// confirms that unrelated fleet listeners remain findings.
func TestEvaluateHost_UidGatedDaemonListener(t *testing.T) {
	one, callerUID := 1, os.Geteuid()
	settings := hostSettings{
		Class:       "shared-multi-user",
		ClassSource: "file",
		Listen:      "tcp://127.0.0.1:4000",
		listen:      listenAddr{"tcp", "127.0.0.1:4000"},
	}
	daemonTCP := []rawListener{{Process: "beam.smp", PID: 1, Address: "127.0.0.1", Port: 4000}}

	got := evaluateHost(hostEvidence{
		settings:                settings,
		users:                   &one,
		listenFrom:              "ss",
		listeners:               daemonTCP,
		daemonPorts:             []int{4000},
		daemonClass:             "shared-multi-user",
		daemonListen:            "tcp://127.0.0.1:4000",
		daemonPeerGate:          "uid",
		daemonPeerGateUID:       &callerUID,
		daemonPeerGateUIDSource: "euid",
	})
	if got.Status != receiptHealthy || got.Repair != "" || len(got.Problems) != 0 {
		t.Fatalf("uid-gated daemon listener = %+v, want healthy", got)
	}
	if got.PeerGate == nil || got.PeerGate.Mode != "uid" ||
		!strings.Contains(got.PeerGate.Reason, "/proc/net/tcp") ||
		!strings.Contains(got.PeerGate.Reason, "exact uid") || strings.Contains(got.PeerGate.Reason, "root") {
		t.Fatalf("peer gate receipt = %+v", got.PeerGate)
	}
	if len(got.Listeners) != 1 || got.Listeners[0].Role != "daemon" {
		t.Fatalf("receipt should retain the observed daemon listener: %+v", got.Listeners)
	}

	exposedListen := "tcp://127.0.0.1:4000"
	exposed := evaluateHost(hostEvidence{
		settings: hostSettings{
			Class: "exposed", Listen: exposedListen, listen: listenAddr{"tcp", "127.0.0.1:4000"},
		},
		daemonClass:    "exposed",
		daemonListen:   exposedListen,
		daemonPeerGate: "uid",
	})
	if exposed.Status != receiptMismatch || exposed.PeerGate != nil {
		t.Fatalf("exposed TCP must not receive the shared-host gate exemption: %+v", exposed)
	}

	got = evaluateHost(hostEvidence{
		settings:                settings,
		users:                   &one,
		listenFrom:              "ss",
		listeners:               append(daemonTCP, rawListener{Process: "tailscaled", PID: 2, Address: "127.0.0.1", Port: 1055}, rawListener{Process: "autossh", PID: 3, Address: "127.0.0.1", Port: 4001}),
		daemonPorts:             []int{4000},
		tunnelPorts:             []int{4001},
		daemonClass:             "shared-multi-user",
		daemonListen:            "tcp://127.0.0.1:4000",
		daemonPeerGate:          "uid",
		daemonPeerGateUID:       &callerUID,
		daemonPeerGateUIDSource: "euid",
	})
	if got.Status != receiptMismatch || len(got.Problems) != 2 {
		t.Fatalf("non-daemon fleet listeners should remain mismatches: %+v", got)
	}
	problems := strings.Join(got.Problems, "\n")
	if strings.Contains(problems, "beam.smp") || !strings.Contains(problems, "tailscaled") || !strings.Contains(problems, "autossh") {
		t.Fatalf("unexpected uid-gated listener findings: %q", problems)
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
	if len(got.Problems) != 4 || strings.Count(got.Repair, "restart onto a daemon that gates TCP peers by uid") != 1 ||
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
	// Explicit mode: under a 002 umask TempDir is 0775, which the ancestry check names.
	if err := os.Chmod(base, 0o755); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "sock")
	// The check walks every ancestor to /, so a TMPDIR under a group-writable
	// home leaves nothing here to assert about; that is the environment, not
	// the inspection.
	if d := inspectSocketDir(dir, euid); d.BadAncestor != "" {
		t.Skipf("TMPDIR has an unsafe ancestor: %s", d.BadAncestor)
	}
	if d := inspectSocketDir(dir, euid); d.Exists {
		t.Errorf("absent dir reported present: %+v", d)
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
