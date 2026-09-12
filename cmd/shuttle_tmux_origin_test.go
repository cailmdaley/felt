package cmd

import (
	"runtime"
	"strings"
	"testing"
)

// Real `launchctl print pid/22457` output, captured on a macOS 25.5 host from
// the tmux server the Shuttle daemon had forked. This is the fixture the whole
// attribution rests on: two coalition blocks, the resource one naming the
// daemon's launchd label.
const launchctlPrintDaemonBorn = `pid/22457 = {
	type = pid
	handle = 22457
	active count = 1
	on-demand count = 1
	creator = launchctl[61737]
	creator euid = 592148721
	uniqueid = 121596
	security context = {
		uid = 592148721
		asid = 100023
	}

	death port = 0x4344b

	services = {
	}

	unmanaged processes = {
	}

	endpoints = {
	}

	task-special ports = {
			 0x1ce03 4       bootstrap  (unknown)
			  0x3f03 9          access  (unknown)
	}

	resource coalition = {
		ID = 1296
		type = resource
		state = terminated
		active count = 0
		name = io.shuttle.daemon
	}

	jetsam coalition = {
		ID = 1297
		type = jetsam
		state = terminated
		active count = 0
		name = io.shuttle.daemon
	}


	properties = 
}
`

// Real output for a process rooted by the human's own terminal on the same
// host: kitty, launched by skhd, so the coalition names skhd's bundle. This is
// what a healthy, user-born tmux server looks like.
const launchctlPrintUserBorn = `pid/85804 = {
	type = pid
	handle = 85804
	active count = 1
	on-demand count = 1
	creator = launchctl[85806]
	creator euid = 592148721
	uniqueid = 1571310
	security context = {
		uid = 592148721
		asid = 100023
	}

	death port = 0x1254a3

	services = {
	}

	unmanaged processes = {
	}

	endpoints = {
	}

	task-special ports = {
			 0x1ce03 4       bootstrap  (unknown)
			  0x3f03 9          access  (unknown)
	}

	resource coalition = {
		ID = 1260
		type = resource
		state = active
		active count = 1
		name = com.koekeishiya.skhd
	}

	jetsam coalition = {
		ID = 1261
		type = jetsam
		state = active
		active count = 1
		name = com.koekeishiya.skhd
	}
`

func TestParseResourceCoalitionName(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want string
	}{
		{"daemon-born server", launchctlPrintDaemonBorn, "io.shuttle.daemon"},
		{"user-born server", launchctlPrintUserBorn, "com.koekeishiya.skhd"},
		// The jetsam coalition carries the same key and is printed right after
		// the resource one; picking the wrong block would attribute a process
		// to the jetsam grouping, which is not what TCC follows.
		{"jetsam block alone is not an answer", `pid/1 = {
	jetsam coalition = {
		name = com.example.other
	}
}`, ""},
		{"resource block without a name", `pid/1 = {
	resource coalition = {
		ID = 7
		type = resource
	}
}`, ""},
		{"a nested name does not count", `pid/1 = {
	resource coalition = {
		inner = {
			name = com.example.nested
		}
	}
}`, ""},
		{"launchctl said nothing", "", ""},
		{"launchctl refused", "Could not print job: 3: No such process", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseResourceCoalitionName(tc.out); got != tc.want {
				t.Fatalf("parseResourceCoalitionName() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClassifyCoalition(t *testing.T) {
	for _, tc := range []struct{ name, want string }{
		{daemonLaunchdLabel, tmuxOriginDaemonBorn},
		{"com.koekeishiya.skhd", tmuxOriginUserBorn},
		{"net.kovidgoyal.kitty", tmuxOriginUserBorn},
		{"", tmuxOriginUnknown},
	} {
		if got := classifyCoalition(tc.name); got != tc.want {
			t.Fatalf("classifyCoalition(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// The end-to-end contract the fixtures exist for: the captured daemon output
// must classify as daemon_born, and nothing else may.
func TestFixturesClassify(t *testing.T) {
	if got := classifyCoalition(parseResourceCoalitionName(launchctlPrintDaemonBorn)); got != tmuxOriginDaemonBorn {
		t.Fatalf("captured daemon-born output classified %q", got)
	}
	if got := classifyCoalition(parseResourceCoalitionName(launchctlPrintUserBorn)); got != tmuxOriginUserBorn {
		t.Fatalf("captured user-born output classified %q", got)
	}
}

// A daemon-born server must fail the receipt: it is the one origin whose remedy
// (restart the server from a terminal) no other surface would ever suggest, and
// leaving it healthy means the human keeps dismissing "erlexec" prompts forever.
func TestCollectTmuxServerReceiptFailsOnlyOnDaemonBorn(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the tmux-server receipt is macOS-only; there is nothing to report here")
	}

	for _, tc := range []struct {
		origin string
		want   receiptStatus
	}{
		{tmuxOriginDaemonBorn, receiptMismatch},
		{tmuxOriginUserBorn, receiptHealthy},
		{tmuxOriginUnknown, receiptHealthy},
		{tmuxOriginAbsent, receiptHealthy},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			restore := stubTmuxOrigin(tmuxOriginReport{Origin: tc.origin, ServerPID: "22457"})
			defer restore()

			rec := collectTmuxServerReceipt()
			if rec == nil {
				t.Fatal("expected a tmux-server receipt on darwin")
			}
			if rec.Status != tc.want {
				t.Fatalf("origin %s: status %s, want %s", tc.origin, rec.Status, tc.want)
			}
			if tc.want == receiptMismatch && rec.Repair == "" {
				t.Fatal("a mismatch must carry the restart-from-a-terminal repair")
			}
		})
	}
}

// The whole-receipt propagation: a daemon-born server alone makes the runtime
// receipt mismatched, and the top-level repair names the tmux remedy rather
// than the generic "repair the mismatched plugin" line.
func TestRuntimeReceiptSurfacesDaemonBornTmuxServer(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the tmux-server receipt is macOS-only")
	}

	restore := stubTmuxOrigin(tmuxOriginReport{Origin: tmuxOriginDaemonBorn, ServerPID: "22457"})
	defer restore()

	status, repair := combineReceiptStatus(
		receiptHealthy, nil, receiptHealthy, receiptHealthy,
		receiptHealthy, collectTmuxServerReceipt().Status,
	)
	if status != receiptMismatch {
		t.Fatalf("combined status %s, want %s", status, receiptMismatch)
	}
	if repair == "" {
		t.Fatal("a mismatched receipt must carry a repair")
	}
}

// The tmux line must never DISPLACE another component's repair: a felt that is
// missing and a daemon-born tmux server are two independent problems, and the
// human needs both strings. (Generation stays the one repair that wins outright
// — a wrong install is more fundamental than a mis-rooted tmux server.)
func TestTmuxRepairDoesNotReplaceAnotherComponentsRepair(t *testing.T) {
	tmuxRec := &ReceiptTmuxServer{Status: receiptMismatch, Repair: tmuxOriginRepair, Origin: tmuxOriginDaemonBorn}

	t.Run("appends to another component's repair", func(t *testing.T) {
		r := RuntimeReceipt{
			Status:     receiptMismatch,
			Repair:     "reinstall the felt executable",
			Generation: ReceiptGenerationReceipt{Status: receiptHealthy},
			TmuxServer: tmuxRec,
		}
		applyTmuxServerRepair(&r)
		if !strings.Contains(r.Repair, "reinstall the felt executable") {
			t.Fatalf("dropped the other component's repair: %q", r.Repair)
		}
		if !strings.Contains(r.Repair, tmuxOriginRepair) {
			t.Fatalf("dropped the tmux repair: %q", r.Repair)
		}
	})

	t.Run("fills an empty repair", func(t *testing.T) {
		r := RuntimeReceipt{Status: receiptMismatch, Generation: ReceiptGenerationReceipt{Status: receiptHealthy}, TmuxServer: tmuxRec}
		applyTmuxServerRepair(&r)
		if r.Repair != tmuxOriginRepair {
			t.Fatalf("repair = %q, want the tmux repair", r.Repair)
		}
	})

	t.Run("the generation repair is more fundamental and survives alone", func(t *testing.T) {
		r := RuntimeReceipt{
			Status:     receiptMismatch,
			Repair:     "rebuild the install",
			Generation: ReceiptGenerationReceipt{Status: receiptMismatch, Repair: "rebuild the install"},
			TmuxServer: tmuxRec,
		}
		applyTmuxServerRepair(&r)
		if r.Repair != "rebuild the install" {
			t.Fatalf("repair = %q, want the generation repair untouched", r.Repair)
		}
	})
}

func stubTmuxOrigin(report tmuxOriginReport) func() {
	prev := detectTmuxOrigin
	detectTmuxOrigin = func() tmuxOriginReport { return report }
	return func() { detectTmuxOrigin = prev }
}
