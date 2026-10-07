package shuttlecli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const (
	harnessHead = "1111111111111111111111111111111111111111"
	harnessOld  = "2222222222222222222222222222222222222222"
)

// fakeHarnessReceipt renders a `felt setup receipt --json` document in the
// shape felt prints: indented JSON whose bundles carry "enabled", followed by
// the generation's active identity and per-harness copies. A bare name is a
// bundle its harness's plugin list confirmed; "!codex" is present but
// disabled; "~codex" is known only from its config and cache; "?codex" is the
// bundle felt reports when that list fails; "#claude" the one it reports when
// the harness config cannot be read; and "-claude" a bundle from a felt that
// predates the inspection field. Each
// harness copy carries a commit other than the active one, so a parser that
// reads the wrong identity is caught.
func fakeHarnessReceipt(t *testing.T, sealed string, bundles ...string) string {
	t.Helper()
	type bundle struct {
		Harness    string `json:"harness"`
		Path       string `json:"path,omitempty"`
		Enabled    bool   `json:"enabled"`
		Inspection string `json:"inspection,omitempty"`
		Evidence   string `json:"evidence,omitempty"`
		Status     string `json:"status"`
		Repair     string `json:"repair,omitempty"`
	}
	type identity struct {
		SourceKind     string `json:"source_kind"`
		ResolvedCommit string `json:"resolved_commit"`
		FeltBuild      string `json:"felt_build"`
	}
	type harness struct {
		Harness    string    `json:"harness"`
		Status     string    `json:"status"`
		Generation *identity `json:"generation,omitempty"`
	}
	type generation struct {
		Status    string    `json:"status"`
		Active    *identity `json:"active,omitempty"`
		Harnesses []harness `json:"harnesses,omitempty"`
	}
	receipt := struct {
		Schema     int        `json:"schema"`
		Status     string     `json:"status"`
		Bundles    []bundle   `json:"bundles"`
		Generation generation `json:"generation"`
	}{Schema: 1, Status: "healthy"}
	if sealed != "" {
		receipt.Generation.Active = &identity{SourceKind: "local", ResolvedCommit: sealed, FeltBuild: "dev"}
	}
	for _, spec := range bundles {
		name := strings.TrimLeft(spec, "!~?#-")
		b := bundle{Harness: name, Path: "/plugins/" + name, Enabled: true, Inspection: "confirmed", Evidence: name + " plugin list", Status: "healthy"}
		switch spec[0] {
		case '!':
			b.Enabled = false
		case '~':
			b.Inspection, b.Evidence, b.Status = "configured", "config/cache fallback", "partial"
		case '?':
			b = bundle{Harness: name, Enabled: true, Inspection: "unknown", Evidence: name + " plugin list unavailable", Status: "partial",
				Repair: "upgrade " + name + " or repair its plugin list, then rerun `felt setup " + name + "`"}
		case '#':
			b = bundle{Harness: name, Enabled: true, Inspection: "unknown", Status: "mismatch",
				Repair: "repair ~/." + name + "/settings.json, then rerun `felt setup " + name + "`"}
		case '-':
			b.Inspection = ""
		}
		receipt.Bundles = append(receipt.Bundles, b)
		receipt.Generation.Harnesses = append(receipt.Generation.Harnesses, harness{
			Harness: name, Status: "healthy",
			Generation: &identity{SourceKind: "local", ResolvedCommit: "3333333333333333333333333333333333333333", FeltBuild: "dev"},
		})
	}
	data, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return string(data) + "\n"
}

type harnessDeployCase struct {
	receipt          string // `felt setup receipt --json` before setup
	receiptRC        string // its exit status before setup
	afterRC          string // its exit status once a Claude/Codex setup has run
	after            string // `felt setup receipt --json` once a Claude/Codex setup has run (default: receipt)
	version          string // `felt --version`
	piAt             string // pi's clone HEAD; empty = pi has no felt GitHub package
	exactRef         string // deploy revision, empty for a branch deploy
	piAfter          string // pi's clone HEAD once `felt setup pi` has run
	piLocal          string // a local pi package: "checkout", a commit, "nogit", or "" for none
	piLocalAs        string // its committed package.json name (default felt)
	working          string // its working package.json name: "" = as committed, "deleted" = absent
	piEdits          string // `git status --porcelain` of pi's GitHub clone
	localEdits       string // `git status --porcelain` of the local pi package
	statusFail       string // "clone" or "local": that package's `git status` exits 128
	piFetchFail      bool
	piCheckoutFail   bool
	wantGitOps       []string
	wantGitMutations []string
	wantLine         string
	wantFailed       bool
	wantCalls        []string
}

// runHarnessDeploy runs deploy's harness snippet in bash against fake felt,
// git, and pi executables, and returns its output and the setup calls felt saw.
func runHarnessDeploy(t *testing.T, c harnessDeployCase) (string, []string, error) {
	t.Helper()
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	fake := t.TempDir()
	bin := filepath.Join(fake, "bin")
	checkout := filepath.Join(fake, "checkout dir")
	piClone := filepath.Join(fake, "pi-felt")
	for _, dir := range []string{bin, checkout, piClone} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, content string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(fake, "receipt.json"), c.receipt, 0o644)
	write(filepath.Join(fake, "receipt.rc"), c.receiptRC, 0o644)
	write(filepath.Join(fake, "receipt.after"), c.afterRC, 0o644)
	if c.after != "" {
		write(filepath.Join(fake, "receipt.after.json"), c.after, 0o644)
	}
	write(filepath.Join(fake, "version"), c.version, 0o644)
	write(filepath.Join(checkout, "HEAD_SHA"), harnessHead, 0o644)
	piList := "User packages:\n  npm:other\n    /elsewhere\n"
	if c.piAt != "" {
		write(filepath.Join(piClone, "HEAD_SHA"), c.piAt, 0o644)
		write(filepath.Join(piClone, "STATUS"), c.piEdits, 0o644)
		if c.statusFail == "clone" {
			write(filepath.Join(piClone, "STATUS_FAIL"), "", 0o644)
		}
		if c.piFetchFail {
			write(filepath.Join(fake, "FETCH_FAIL"), "", 0o644)
		}
		if c.piCheckoutFail {
			write(filepath.Join(fake, "CHECKOUT_FAIL"), "", 0o644)
		}
		piList += "  git:github.com/cailmdaley/felt\n    " + piClone + "\n"
	}
	if c.piLocal != "" {
		local := filepath.Join(fake, "local felt")
		if c.piLocal == "checkout" {
			local = checkout
		} else {
			if err := os.MkdirAll(local, 0o755); err != nil {
				t.Fatal(err)
			}
			if c.piLocal != "nogit" {
				write(filepath.Join(local, "HEAD_SHA"), c.piLocal, 0o644)
			}
			write(filepath.Join(local, "STATUS"), c.localEdits, 0o644)
			if c.statusFail == "local" {
				write(filepath.Join(local, "STATUS_FAIL"), "", 0o644)
			}
		}
		manifest := func(name string) string {
			return "{\n  \"name\": \"" + name + "\",\n  \"version\": \"0.1.0\"\n}\n"
		}
		committed := c.piLocalAs
		if committed == "" {
			committed = "felt"
		}
		if c.piLocal != "nogit" {
			write(filepath.Join(local, "HEAD_package.json"), manifest(committed), 0o644)
		}
		switch c.working {
		case "":
			write(filepath.Join(local, "package.json"), manifest(committed), 0o644)
		case "deleted":
		default:
			write(filepath.Join(local, "package.json"), manifest(c.working), 0o644)
		}
		piList += "  ../" + filepath.Base(local) + "\n    " + local + "\n"
	}
	write(filepath.Join(fake, "pi.list"), piList, 0o644)
	if c.piAfter != "" {
		write(filepath.Join(fake, "pi.after"), c.piAfter, 0o644)
	}
	write(filepath.Join(bin, "felt"), `#!/bin/sh
d="$FAKE_DIR"
case "$*" in
  --version) printf 'felt version %s\n' "$(cat "$d/version")" ;;
  "setup receipt --json") cat "$d/receipt.json"; exit "$(cat "$d/receipt.rc")" ;;
  "setup receipt") exit "$(cat "$d/receipt.rc")" ;;
  "setup pi")
    echo "$*" >> "$d/calls"
    [ -f "$d/pi.after" ] && cp "$d/pi.after" "$d/pi-felt/HEAD_SHA"
    exit 0 ;;
  setup\ *)
    echo "$*" >> "$d/calls"
    cp "$d/receipt.after" "$d/receipt.rc"
    [ ! -f "$d/receipt.after.json" ] || cp "$d/receipt.after.json" "$d/receipt.json" ;;
  *) exit 2 ;;
esac
`, 0o755)
	write(filepath.Join(bin, "git"), `#!/bin/sh
[ "$1" = -C ] || exit 2
[ -f "$2/HEAD_SHA" ] || { echo "fatal: not a git repository" >&2; exit 128; }
case "$3 $4 $5" in
  "rev-parse HEAD ") cat "$2/HEAD_SHA" ;;
  "rev-parse --git-dir ") echo .git ;;
  "show HEAD:package.json ") cat "$2/HEAD_package.json" ;;
  "status --porcelain --untracked-files=no"|"status --porcelain ")
    [ ! -f "$2/STATUS_FAIL" ] || { echo "fatal: index file corrupt" >&2; exit 128; }
    cat "$2/STATUS" 2>/dev/null ;;
  "fetch origin $5")
    echo "fetch $5" >> "$FAKE_DIR/git-ops"
    [ "$5" = "$HARNESS_HEAD" ] && [ ! -f "$FAKE_DIR/FETCH_FAIL" ] || { echo "could not fetch $5" >&2; exit 1; }
    echo "fetch $5" >> "$FAKE_DIR/git-mutations" ;;
  "checkout --detach $5")
    echo "checkout $5" >> "$FAKE_DIR/git-ops"
    [ "$5" = "$HARNESS_HEAD" ] && [ ! -f "$FAKE_DIR/CHECKOUT_FAIL" ] || exit 1
    echo "checkout $5" >> "$FAKE_DIR/git-mutations"
    printf '%s' "$5" > "$2/HEAD_SHA" ;;
  *) exit 2 ;;
esac
`, 0o755)
	write(filepath.Join(bin, "pi"), `#!/bin/sh
[ "$1" = list ] && cat "$FAKE_DIR/pi.list"
`, 0o755)

	harness := `shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
` + shellFunction(t, string(script), "harness_setup_cmd") + `
harness_setup_cmd "$CHECKOUT" | /bin/bash
`
	cmd := exec.Command("/bin/bash", "-c", harness)
	cmd.Env = append(os.Environ(), "PATH="+bin+":/usr/bin:/bin", "FAKE_DIR="+fake, "CHECKOUT="+checkout, "HARNESS_HEAD="+harnessHead, "DEPLOY_REF="+c.exactRef)
	out, runErr := cmd.CombinedOutput()
	var calls []string
	if data, err := os.ReadFile(filepath.Join(fake, "calls")); err == nil {
		calls = strings.Split(strings.TrimSpace(strings.ReplaceAll(string(data), checkout, "<checkout>")), "\n")
	}
	readLines := func(name string) []string {
		data, err := os.ReadFile(filepath.Join(fake, name))
		if err != nil {
			return []string{}
		}
		return strings.Split(strings.TrimSpace(string(data)), "\n")
	}
	if c.wantGitOps != nil && !reflect.DeepEqual(readLines("git-ops"), c.wantGitOps) {
		t.Errorf("git operations = %v, want %v", readLines("git-ops"), c.wantGitOps)
	}
	if c.wantGitMutations != nil && !reflect.DeepEqual(readLines("git-mutations"), c.wantGitMutations) {
		t.Errorf("git mutations = %v, want %v", readLines("git-mutations"), c.wantGitMutations)
	}
	return string(out), calls, runErr
}

func TestDeployHarnessSetup(t *testing.T) {
	t.Parallel()
	cases := map[string]harnessDeployCase{
		"a passing receipt sealed at HEAD by a clean build is left alone": {
			receipt: fakeHarnessReceipt(t, harnessHead, "claude", "codex"), receiptRC: "0", afterRC: "0",
			version: "dev (111111111111)", piAt: harnessHead,
			wantLine: "harness-ok harness plugins: claude codex current, pi current",
		},
		"a stale generation is set up from the checkout, for enabled bundles only": {
			receipt: fakeHarnessReceipt(t, harnessOld, "claude", "!codex"), receiptRC: "1", afterRC: "0",
			version:   "dev (111111111111)",
			wantLine:  "harness-ok harness plugins: claude set up",
			wantCalls: []string{"setup claude --source <checkout>"},
		},
		"a passing receipt sealed at another commit is set up again": {
			receipt: fakeHarnessReceipt(t, harnessOld, "codex"), receiptRC: "0", afterRC: "0",
			version:   "dev (111111111111)",
			wantLine:  "harness-ok harness plugins: codex set up",
			wantCalls: []string{"setup codex --source <checkout>"},
		},
		"a dirty build is always set up again": {
			receipt: fakeHarnessReceipt(t, harnessHead, "claude"), receiptRC: "0", afterRC: "0",
			version:   "dev (111111111111-dirty)",
			wantLine:  "harness-ok harness plugins: claude set up",
			wantCalls: []string{"setup claude --source <checkout>"},
		},
		"a receipt that still fails after setup names the failing component and its repair": {
			receipt: fakeHarnessReceipt(t, harnessOld, "claude"), receiptRC: "1", afterRC: "1",
			after: withReceiptProblems(t, fakeHarnessReceipt(t, harnessHead, "claude"), genericRepair, map[string]any{
				"felt": map[string]any{"status": "mismatch", "repair": "remove the stale copy so one felt remains"},
			}),
			version:    "dev (111111111111)",
			wantLine:   "harness-fail setup receipt still fails after felt setup: felt mismatch: remove the stale copy so one felt remains",
			wantFailed: true,
			wantCalls:  []string{"setup claude --source <checkout>"},
		},
		"unapproved Codex hooks fail with the hooks repair, not the generic one": {
			receipt: fakeHarnessReceipt(t, harnessOld, "codex"), receiptRC: "1", afterRC: "1",
			after: withReceiptProblems(t, fakeHarnessReceipt(t, harnessHead, "codex"), genericRepair, map[string]any{
				"hooks": map[string]any{"status": "mismatch", "path": "/plugins/codex", "repair": "open a Codex session and approve felt's hooks, then rerun the receipt"},
			}),
			version:    "dev (111111111111)",
			wantLine:   "harness-fail setup receipt still fails after felt setup: hooks mismatch: open a Codex session and approve felt's hooks, then rerun the receipt",
			wantFailed: true,
			wantCalls:  []string{"setup codex --source <checkout>"},
		},
		"several failing components are each named, a shared repair once": {
			receipt: fakeHarnessReceipt(t, harnessOld, "claude"), receiptRC: "1", afterRC: "1",
			after: withReceiptProblems(t, fakeHarnessReceipt(t, harnessHead, "claude"), genericRepair, map[string]any{
				"bundle claude": map[string]any{"status": "missing", "repair": "rerun `felt setup claude`"},
				"hooks":         map[string]any{"status": "missing", "repair": "rerun `felt setup claude`"},
				"generation":    map[string]any{"status": "partial", "repair": "finish the pending plugin promotion"},
			}),
			version:    "dev (111111111111)",
			wantLine:   "harness-fail setup receipt still fails after felt setup: claude plugin missing: rerun `felt setup claude`; generation partial: finish the pending plugin promotion; hooks missing\n",
			wantFailed: true,
			wantCalls:  []string{"setup claude --source <checkout>"},
		},
		"a failing receipt with every component healthy falls back to its top-level repair": {
			receipt: fakeHarnessReceipt(t, harnessOld, "claude"), receiptRC: "1", afterRC: "1",
			after:      withReceiptProblems(t, fakeHarnessReceipt(t, harnessHead, "claude"), genericRepair, nil),
			version:    "dev (111111111111)",
			wantLine:   "harness-fail setup receipt still fails after felt setup: " + genericRepair,
			wantFailed: true,
			wantCalls:  []string{"setup claude --source <checkout>"},
		},
		"an exact-ref pi clone behind HEAD is pinned": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessOld, exactRef: harnessHead,
			wantLine: "harness-ok harness plugins: pi pinned",
		},
		"an exact-ref pi fetch failure does not check out or mutate the clone": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessOld, exactRef: harnessHead, piFetchFail: true,
			wantLine: "harness-fail pi's felt package", wantFailed: true,
			wantGitOps: []string{"fetch " + harnessHead}, wantGitMutations: []string{},
		},
		"an exact-ref pi checkout failure leaves the clone revision unchanged": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessOld, exactRef: harnessHead, piCheckoutFail: true,
			wantLine: "harness-fail pi's felt package", wantFailed: true,
			wantGitOps:       []string{"fetch " + harnessHead, "checkout " + harnessHead},
			wantGitMutations: []string{"fetch " + harnessHead},
		},
		"an exact-ref pi clone with tracked edits is not pinned": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessOld, exactRef: harnessHead, piEdits: " M extensions/pi/index.ts\n",
			wantLine:   "harness-fail pi's felt package",
			wantFailed: true,
		},
		"pi behind HEAD is set up": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessOld, piAfter: harnessHead,
			wantLine:  "harness-ok harness plugins: pi set up",
			wantCalls: []string{"setup pi"},
		},
		"pi that setup cannot bring to HEAD fails the host": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessOld,
			wantLine:   "harness-fail pi's felt package is at 2222222, not 1111111",
			wantFailed: true,
			wantCalls:  []string{"setup pi"},
		},
		"an empty receipt fails instead of reading as no harness": {
			receipt: "", receiptRC: "1", afterRC: "1",
			version:    "dev (111111111111)",
			wantLine:   "harness-fail felt setup receipt --json gave no complete receipt (exit 1)",
			wantFailed: true,
		},
		"a receipt cut off inside its bundles fails instead of reading as no harness": {
			receipt:   truncateBefore(t, fakeHarnessReceipt(t, harnessHead, "claude"), `"enabled"`),
			receiptRC: "1", afterRC: "0",
			version:    "dev (111111111111)",
			wantLine:   "harness-fail felt setup receipt --json gave no complete receipt (exit 1)",
			wantFailed: true,
		},
		"a receipt without a bundles list fails": {
			receipt: "{\n  \"schema\": 1,\n  \"status\": \"healthy\"\n}\n", receiptRC: "0", afterRC: "0",
			version:    "dev (111111111111)",
			wantLine:   "harness-fail felt setup receipt --json gave no complete receipt (exit 0)",
			wantFailed: true,
		},
		"a receipt missing its closing brace fails": {
			receipt:   strings.TrimSuffix(fakeHarnessReceipt(t, harnessHead, "claude"), "}\n"),
			receiptRC: "0", afterRC: "0",
			version:    "dev (111111111111)",
			wantLine:   "harness-fail felt setup receipt --json gave no complete receipt (exit 0)",
			wantFailed: true,
		},
		"pi's GitHub clone at HEAD with local edits fails": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessHead, piEdits: " M extensions/pi/index.ts\n",
			wantLine:   "but has local edits ( M extensions/pi/index.ts )",
			wantFailed: true,
		},
		"pi's GitHub clone still edited after setup fails": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessOld, piAfter: harnessHead, piEdits: " D claude-plugin/skills/felt/SKILL.md\n",
			wantLine:   "but has local edits ( D claude-plugin/skills/felt/SKILL.md )",
			wantFailed: true,
			wantCalls:  []string{"setup pi"},
		},
		"a local pi package at HEAD with local edits fails": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: harnessHead, localEdits: " M package.json\n",
			wantLine:   "at the deployed 1111111 but with local edits ( M package.json )",
			wantFailed: true,
		},
		"a local pi package whose git status fails fails the host": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: harnessHead, statusFail: "local",
			wantLine:   "cannot inspect pi's felt package",
			wantFailed: true,
		},
		"pi's GitHub clone whose git status fails fails the host": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piAt: harnessHead, statusFail: "clone",
			wantLine:   "cannot inspect pi's felt package",
			wantFailed: true,
		},
		"a local pi package with its package.json deleted is still verified": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: harnessHead, working: "deleted", localEdits: " D package.json\n",
			wantLine:   "with local edits ( D package.json )",
			wantFailed: true,
		},
		"a local pi package with its package.json renamed is still verified": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: harnessHead, working: "loom", localEdits: " M package.json\n",
			wantLine:   "with local edits ( M package.json )",
			wantFailed: true,
		},
		"a local pi package outside git is identified by its working package.json": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: "nogit",
			wantLine:   "at no git commit, not the deployed 1111111",
			wantFailed: true,
		},
		"a plugin list that cannot be read fails with its repair instead of setting up": {
			receipt: fakeHarnessReceipt(t, harnessOld, "claude", "?codex"), receiptRC: "1", afterRC: "0",
			version:    "dev (111111111111)",
			wantLine:   "harness-fail cannot tell whether codex carries felt's plugin: upgrade codex or repair its plugin list, then rerun `felt setup codex`",
			wantFailed: true,
		},
		"a bundle known from its config alone is set up": {
			receipt: fakeHarnessReceipt(t, harnessOld, "~codex"), receiptRC: "1", afterRC: "0",
			version:   "dev (111111111111)",
			wantLine:  "harness-ok harness plugins: codex set up",
			wantCalls: []string{"setup codex --source <checkout>"},
		},
		"a receipt without inspection fails instead of guessing": {
			receipt: fakeHarnessReceipt(t, harnessHead, "-claude"), receiptRC: "0", afterRC: "0",
			version:    "dev (111111111111)",
			wantLine:   "harness-fail the receipt gives claude no known inspection (none)",
			wantFailed: true,
		},
		"an unreadable harness config fails with its repair instead of setting up": {
			receipt: fakeHarnessReceipt(t, harnessOld, "#claude"), receiptRC: "1", afterRC: "0",
			version:    "dev (111111111111)",
			wantLine:   "harness-fail cannot tell whether claude carries felt's plugin: repair ~/.claude/settings.json",
			wantFailed: true,
		},
		"a local pi package that is the checkout is current": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: "checkout",
			wantLine: "harness-ok harness plugins: pi current",
		},
		"a local pi package at HEAD is current": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: harnessHead,
			wantLine: "harness-ok harness plugins: pi current",
		},
		"a local pi package behind HEAD fails without being re-pointed": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: harnessOld,
			wantLine:   "harness-fail pi loads felt from the local package", // at no git commit
			wantFailed: true,
		},
		"a local pi package that is not felt is ignored": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version: "dev (111111111111)", piLocal: harnessOld, piLocalAs: "loom",
			wantLine: "harness-ok harness plugins: none carry felt",
		},
		"a host where no harness carries felt sets nothing up": {
			receipt: fakeHarnessReceipt(t, ""), receiptRC: "1", afterRC: "1",
			version:  "dev (111111111111)",
			wantLine: "harness-ok harness plugins: none carry felt",
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			out, calls, err := runHarnessDeploy(t, c)
			if failed := err != nil; failed != c.wantFailed {
				t.Fatalf("failed = %v, want %v\n%s", failed, c.wantFailed, out)
			}
			if !strings.Contains(out, c.wantLine) {
				t.Fatalf("output lacks %q:\n%s", c.wantLine, out)
			}
			if strings.Join(calls, "\n") != strings.Join(c.wantCalls, "\n") {
				t.Fatalf("setup calls = %q, want %q", calls, c.wantCalls)
			}
		})
	}
}

// truncateBefore cuts a receipt just before the first line holding marker, as
// a felt killed while writing would leave it.
func truncateBefore(t *testing.T, receipt, marker string) string {
	t.Helper()
	i := strings.Index(receipt, marker)
	if i < 0 {
		t.Fatalf("receipt has no %s", marker)
	}
	return receipt[:strings.LastIndex(receipt[:i], "\n")+1]
}

const genericRepair = "repair the mismatched Felt executable, plugin, or hook, then rerun the receipt"

// withReceiptProblems sets a receipt's top-level repair and overlays the given
// components: "felt", "hooks" and "generation" fields, or "bundle <harness>"
// for that bundle's. The result is re-indented as felt prints it.
func withReceiptProblems(t *testing.T, receipt, repair string, components map[string]any) string {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal([]byte(receipt), &doc); err != nil {
		t.Fatal(err)
	}
	doc["status"], doc["repair"] = "mismatch", repair
	if _, ok := doc["felt"]; !ok {
		doc["felt"] = map[string]any{"status": "healthy"}
	}
	if _, ok := doc["hooks"]; !ok {
		doc["hooks"] = map[string]any{"status": "healthy"}
	}
	for name, fields := range components {
		target, _ := doc[name].(map[string]any)
		if harness, ok := strings.CutPrefix(name, "bundle "); ok {
			for _, b := range doc["bundles"].([]any) {
				if b.(map[string]any)["harness"] == harness {
					target = b.(map[string]any)
				}
			}
		}
		if target == nil {
			t.Fatalf("receipt has no component %q", name)
		}
		for k, v := range fields.(map[string]any) {
			target[k] = v
		}
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return string(data) + "\n"
}
