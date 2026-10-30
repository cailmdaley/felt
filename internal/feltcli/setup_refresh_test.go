package feltcli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParsePiPackageListing(t *testing.T) {
	listing := "Installed packages:\n  npm:pi-subagents\n    /home/user/.pi/node_modules/pi-subagents\n  git:github.com/cailmdaley/felt\n    /home/user/.pi/git/cailmdaley-felt\n  /home/user/dev/felt\n    /home/user/dev/felt\n"
	got := parsePiPackageListing(listing)
	if len(got) != 3 {
		t.Fatalf("parsed %d packages, want 3: %#v", len(got), got)
	}
	want := []piPackageListing{
		{source: "npm:pi-subagents", path: "/home/user/.pi/node_modules/pi-subagents"},
		{source: "git:github.com/cailmdaley/felt", path: "/home/user/.pi/git/cailmdaley-felt"},
		{source: "/home/user/dev/felt", path: "/home/user/dev/felt"},
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("package %d = %#v, want %#v", i, got[i], want[i])
		}
	}
}

func TestIsLocalFeltPackageUsesCommittedManifest(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, committed, working string
		want                     bool
	}{
		{"edited into felt", "other", "felt", false},
		{"deleted committed felt manifest", "felt", "", true},
		{"edited away from felt", "felt", "other", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			dir := initGitPackage(t, tc.committed)
			manifest := filepath.Join(dir, "package.json")
			if tc.working == "" {
				if err := os.Remove(manifest); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(manifest, []byte(`{"name":"`+tc.working+`"}`), 0o644); err != nil {
				t.Fatal(err)
			}
			env, _ := testEnv(t)
			if got := testApp(t, env).isLocalFeltPackage(dir); got != tc.want {
				t.Errorf("isLocalFeltPackage() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRefreshPiPinsSourceHeadAndLeavesCheckoutDetached(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	upstream := initGitPackage(t, "felt")
	packagePath := filepath.Join(root, "pi-felt")
	gitTest(t, root, "clone", upstream, packagePath)
	setUpstream := filepath.Join(upstream, "content.txt")
	if err := os.WriteFile(setUpstream, []byte("target\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTest(t, upstream, "add", "content.txt")
	gitTest(t, upstream, "commit", "-m", "target")
	target := strings.TrimSpace(gitTest(t, upstream, "rev-parse", "HEAD"))

	listingEnv, _ := testEnv(t)
	listingEnv.Set("PI_FELT_PATH", packagePath)
	fakeCommand(t, listingEnv, "pi", "printf '  git:github.com/cailmdaley/felt\\n    %s\\n' \"$PI_FELT_PATH\"\n")
	if err := testApp(t, listingEnv).refreshPiHarness(upstream, target); err != nil {
		t.Fatalf("refreshPiHarness: %v", err)
	}
	if got := strings.TrimSpace(gitTest(t, packagePath, "rev-parse", "HEAD")); got != target {
		t.Fatalf("Pi clone HEAD = %s, want exact target %s", got, target)
	}
	if out, err := exec.Command("git", "-C", packagePath, "symbolic-ref", "-q", "HEAD").CombinedOutput(); err == nil {
		t.Fatalf("Pi clone remains on branch %s, want detached HEAD", strings.TrimSpace(string(out)))
	}
}

func TestRefreshPiKeepsDirtyCanonicalCheckoutSource(t *testing.T) {
	t.Parallel()
	checkout := initGitPackage(t, "felt")
	tracked := filepath.Join(checkout, "tracked.txt")
	if err := os.WriteFile(tracked, []byte("committed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTest(t, checkout, "add", "tracked.txt")
	gitTest(t, checkout, "commit", "-m", "tracked")
	head := strings.TrimSpace(gitTest(t, checkout, "rev-parse", "HEAD"))
	if err := os.WriteFile(tracked, []byte("local edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "felt-alias")
	if err := os.Symlink(checkout, alias); err != nil {
		t.Fatal(err)
	}
	env, _ := testEnv(t)
	env.Set("PI_FELT_PATH", alias)
	fakeCommand(t, env, "pi", "printf '  %s\\n    %s\\n' \"$PI_FELT_PATH\" \"$PI_FELT_PATH\"\n")
	if err := testApp(t, env).refreshPiHarness(checkout, head); err != nil {
		t.Fatalf("dirty canonical source should be retained: %v", err)
	}
}

func TestRefreshPiSourceHeadPinRefusesDirtyClone(t *testing.T) {
	t.Parallel()
	upstream := initGitPackage(t, "felt")
	trackedPath := filepath.Join(upstream, "tracked.txt")
	if err := os.WriteFile(trackedPath, []byte("initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTest(t, upstream, "add", "tracked.txt")
	gitTest(t, upstream, "commit", "-m", "tracked")
	cloneRoot := t.TempDir()
	packagePath := filepath.Join(cloneRoot, "pi-felt")
	gitTest(t, cloneRoot, "clone", upstream, packagePath)
	if err := os.WriteFile(trackedPath, []byte("target\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTest(t, upstream, "add", "tracked.txt")
	gitTest(t, upstream, "commit", "-m", "target")
	target := strings.TrimSpace(gitTest(t, upstream, "rev-parse", "HEAD"))
	if err := os.WriteFile(filepath.Join(packagePath, "tracked.txt"), []byte("local edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	listingEnv, _ := testEnv(t)
	listingEnv.Set("PI_FELT_PATH", packagePath)
	fakeCommand(t, listingEnv, "pi", "printf '  git:github.com/cailmdaley/felt\\n    %s\\n' \"$PI_FELT_PATH\"\n")
	app := testApp(t, listingEnv)
	if err := app.refreshPiHarness(upstream, target); err == nil || !strings.Contains(err.Error(), "local edits") {
		t.Fatalf("dirty source-head pin error = %v, want local edits error", err)
	}
	if got := strings.TrimSpace(gitTest(t, packagePath, "rev-parse", "HEAD")); got == target {
		t.Fatal("dirty package changed to the target despite rejection")
	}
}

func TestReceiptProblemsNamesUnhealthyComponents(t *testing.T) {
	receipt := RuntimeReceipt{
		Status: receiptMissing,
		Felt:   ReceiptComponent{Status: receiptHealthy},
		Bundles: []ReceiptBundle{{Harness: "claude", Enabled: true, Status: receiptMissing,
			Repair: "run felt setup claude"}},
		Hooks:      ReceiptComponent{Status: receiptMissing, Repair: "restore hooks"},
		Generation: ReceiptGenerationReceipt{Status: receiptHealthy},
	}
	got := receiptProblems(receipt)
	for _, want := range []string{"claude plugin missing", "run felt setup claude", "hooks missing", "restore hooks"} {
		if !strings.Contains(got, want) {
			t.Errorf("receipt problems %q omit %q", got, want)
		}
	}
}

func TestRefreshReceiptBundlesUsesTypedInspection(t *testing.T) {
	t.Parallel()
	const head = "0123456789abcdef0123456789abcdef01234567"
	postFailure := RuntimeReceipt{
		Status: receiptMismatch,
		Felt:   ReceiptComponent{Status: receiptHealthy},
		Bundles: []ReceiptBundle{{Harness: "claude", Enabled: true, Inspection: inspectionConfirmed,
			Status: receiptMismatch, Repair: "run felt setup claude to repair cache"}},
		Hooks:      ReceiptComponent{Status: receiptHealthy},
		Generation: ReceiptGenerationReceipt{Status: receiptMismatch, Repair: "repair active generation"},
	}
	tests := []struct {
		name          string
		receipt       RuntimeReceipt
		wantCalls     []string
		wantVerify    int
		wantErrorText string
	}{
		{
			name: "confirmed and configured enabled bundles refresh",
			receipt: RuntimeReceipt{Status: receiptPartial, Bundles: []ReceiptBundle{
				{Harness: "claude", Enabled: true, Inspection: inspectionConfirmed, Status: receiptStale},
				{Harness: "codex", Enabled: true, Inspection: inspectionConfigured, Status: receiptPartial},
			}},
			wantCalls:  []string{"claude plugin", "codex plugin"},
			wantVerify: 1,
		},
		{
			name: "disabled bundle stays untouched",
			receipt: RuntimeReceipt{Status: receiptHealthy, Bundles: []ReceiptBundle{
				{Harness: "claude", Enabled: false, Inspection: inspectionConfirmed, Status: receiptPartial},
			}},
		},
		{name: "absent bundles stay untouched", receipt: RuntimeReceipt{Status: receiptMissing}},
		{
			name: "unknown enabled inspection refuses before setup",
			receipt: RuntimeReceipt{Status: receiptPartial, Bundles: []ReceiptBundle{
				{Harness: "claude", Enabled: true, Inspection: inspectionUnknown,
					Repair: "repair Claude plugin list"},
			}},
			wantErrorText: "repair Claude plugin list",
		},
		{
			name: "healthy sealed source commit skips setup",
			receipt: RuntimeReceipt{
				Status: receiptHealthy,
				Felt:   ReceiptComponent{Status: receiptHealthy, Build: "dev (abc123)"},
				Bundles: []ReceiptBundle{{Harness: "claude", Enabled: true,
					Inspection: inspectionConfirmed, Status: receiptHealthy}},
				Hooks: ReceiptComponent{Status: receiptHealthy},
				Generation: ReceiptGenerationReceipt{Status: receiptHealthy,
					Active: &pluginGenerationIdentity{ResolvedCommit: head}},
			},
		},
		{
			name:          "post refresh receipt failure names repair",
			receipt:       RuntimeReceipt{Status: receiptPartial, Bundles: []ReceiptBundle{{Harness: "claude", Enabled: true, Inspection: inspectionConfirmed}}},
			wantCalls:     []string{"claude plugin"},
			wantVerify:    1,
			wantErrorText: "claude plugin mismatch: run felt setup claude to repair cache",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			env, _ := testEnv(t)
			calls := map[string]func() string{}
			for _, harness := range []string{"claude", "codex"} {
				calls[harness] = fakeCallLog(t, env, harness, "")
			}
			a := testApp(t, env)
			verifyCalls := 0
			setup := func(harness, source string) error {
				return a.runHarnessCLI(harness, "plugin", source)
			}
			verify := func() error {
				verifyCalls++
				if tt.name == "post refresh receipt failure names repair" {
					return verifyRuntimeReceipt(postFailure)
				}
				return nil
			}
			err := a.refreshReceiptBundles(tt.receipt, "/source", head, setup, verify)
			if tt.wantErrorText == "" && err != nil {
				t.Fatalf("refreshReceiptBundles: %v", err)
			}
			if tt.wantErrorText != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErrorText)) {
				t.Fatalf("refreshReceiptBundles error = %v, want substring %q", err, tt.wantErrorText)
			}
			if verifyCalls != tt.wantVerify {
				t.Errorf("verification calls = %d, want %d", verifyCalls, tt.wantVerify)
			}
			var gotCalls []string
			for _, harness := range []string{"claude", "codex"} {
				if strings.TrimSpace(calls[harness]()) != "" {
					gotCalls = append(gotCalls, harness+" plugin")
				}
			}
			if strings.Join(gotCalls, ",") != strings.Join(tt.wantCalls, ",") {
				t.Errorf("harness setup calls = %v, want %v", gotCalls, tt.wantCalls)
			}
		})
	}
}

func initGitPackage(t *testing.T, name string) string {
	t.Helper()
	dir := t.TempDir()
	gitTest(t, dir, "init", "-b", "main")
	gitTest(t, dir, "config", "user.email", "felt-test@example.invalid")
	gitTest(t, dir, "config", "user.name", "Felt Test")
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"`+name+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTest(t, dir, "add", "package.json")
	gitTest(t, dir, "commit", "-m", "initial")
	return dir
}

func gitTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return string(out)
}

func TestSetupRefreshRequiresSource(t *testing.T) {
	t.Parallel()
	dir, _ := newStore(t)
	_, _, err := executeCLI(t, dir, "setup", "refresh")
	if err == nil || !strings.Contains(err.Error(), "requires --source") {
		t.Fatalf("setup refresh without source error = %v", err)
	}
}

func TestSetupRefreshDoesNotExposeRef(t *testing.T) {
	t.Parallel()
	dir, _ := newStore(t)
	stdout, _, err := executeCLI(t, dir, "setup", "refresh", "--help")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stdout, "--ref") {
		t.Fatalf("setup refresh help unexpectedly exposes --ref: %s", stdout)
	}
}
