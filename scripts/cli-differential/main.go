// Command cli-differential runs one corpus of felt and shuttle invocations
// against two builds of both CLIs and reports every observable difference.
//
// Each invocation runs once per build, each time in its own fixture seeded
// identically from one template: a HOME, XDG and TMPDIR tree, a felt store
// in a Git repository, Shuttle host and fleet configuration, recording fake
// executables first and alone on PATH, and an in-process mock daemon that
// records every request. Every run is fenced by sandbox-exec: it can write
// only inside its fixture, connect only to its own mock daemon's port and
// to Unix sockets inside its fixture, execute only the fixture's fakes, the
// two builds and the system's shell tools, and signal no other process.
//
// A run's record holds its exit status, stdout and stderr, every file left
// in the fixture with its mode, the store's Git history and status, every
// recorded child execution (argv, working directory and environment), and
// every request the mock daemon received. Fixture paths, the daemon port,
// the build directories, and ULIDs and timestamps that the template did not
// hold are normalised; nothing else is.
//
// The corpus walks each build's help to enumerate every verb and subverb,
// so a verb added to either build is exercised without editing this file.
// See run.sh for building two revisions and running the comparison.
//
// macOS only: the fence is sandbox-exec.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	flagA       = flag.String("a", "", "directory holding the baseline felt and shuttle binaries")
	flagB       = flag.String("b", "", "directory holding the candidate felt and shuttle binaries")
	flagOut     = flag.String("out", "", "directory for the report, the differing records and the corpus")
	flagJobs    = flag.Int("j", runtime.NumCPU(), "invocations to run at once")
	flagRun     = flag.String("run", "", "only run invocations whose name matches this regexp")
	flagEnv     = flag.String("env-names", "", "file of environment variable names (one per line) to vary")
	flagTimeout = flag.Duration("timeout", 30*time.Second, "per-run time limit")
	flagKeep    = flag.Bool("keep", false, "keep each run's fixture under -out")
)

// Fixed identity of the seeded fixture.
const (
	hostID     = "testhost"
	remoteHost = "otherhost"
	seedPort   = "59999" // the template's daemon port, which a copy replaces
	fixToken   = "@FIX@"
)

// fakeNames are the executables a fixture fakes. Each records its call and
// exits 0 silently, except git, felt and shuttle, which record and then run
// the real tool.
var fakeNames = []string{
	"autossh", "claude", "codex", "curl", "defaults", "gh", "go", "journalctl",
	"kill", "killall", "launchctl", "loginctl", "lsof", "make", "mix", "node",
	"npm", "open", "osascript", "pgrep", "pi", "pkill", "ps", "rsync", "scp",
	"security", "ssh", "sw_vers", "systemctl", "tailscale", "tmux", "uname",
	"fake-shell",
}

// deniedExecs are system tools a run may not execute even by absolute path.
var deniedExecs = []string{
	"/bin/launchctl", "/bin/kill", "/usr/bin/killall", "/usr/bin/pkill",
	"/usr/bin/osascript", "/usr/bin/open", "/usr/bin/ssh", "/usr/bin/scp",
	"/usr/bin/sftp", "/usr/bin/rsync", "/usr/bin/curl", "/usr/bin/sudo",
	"/usr/bin/su", "/usr/bin/security", "/usr/bin/defaults", "/usr/bin/tmux",
	"/usr/bin/nc", "/usr/bin/caffeinate", "/usr/bin/shutdown", "/sbin/shutdown",
	"/sbin/reboot", "/usr/bin/automator",
}

type invocation struct {
	Name  string             `json:"name"`
	CLI   string             `json:"cli"`
	Args  []string           `json:"args"`
	Cwd   string             `json:"cwd"`           // relative to the fixture root
	Env   map[string]*string `json:"env,omitempty"` // nil value: unset
	Stdin string             `json:"stdin,omitempty"`
}

type record struct {
	Exit     string            `json:"exit"`
	Stdout   string            `json:"stdout"`
	Stderr   string            `json:"stderr"`
	Files    map[string]string `json:"files"`
	Git      string            `json:"git"`
	Execs    []string          `json:"execs"`
	Requests []string          `json:"requests"`
}

type build struct {
	label, dir, real string
}

type harness struct {
	builds   [2]build
	work     string // real path of the scratch root
	template string // real path of the seeded template fixture
	keep     bool
	known    map[string]bool // ULIDs and timestamps the template holds
	git      string          // the real git, past the xcrun shim
	bin      string          // the fakes, shared by every run
}

func main() {
	flag.Parse()
	if runtime.GOOS != "darwin" {
		fatalf("cli-differential fences runs with sandbox-exec and runs only on macOS")
	}
	if *flagA == "" || *flagB == "" || *flagOut == "" {
		fatalf("usage: cli-differential -a <baseline bin dir> -b <candidate bin dir> -out <dir>")
	}
	h, err := newHarness(*flagA, *flagB, *flagOut)
	if err != nil {
		fatalf("%v", err)
	}
	h.keep = *flagKeep

	var envNames []string
	if *flagEnv != "" {
		raw, err := os.ReadFile(*flagEnv)
		if err != nil {
			fatalf("%v", err)
		}
		envNames = strings.Fields(string(raw))
	}

	trees, err := h.enumerate()
	if err != nil {
		fatalf("enumerating verbs: %v", err)
	}
	corpus := buildCorpus(trees, envNames)
	if *flagRun != "" {
		re := regexp.MustCompile(*flagRun)
		filtered := corpus[:0]
		for _, inv := range corpus {
			if re.MatchString(inv.Name) {
				filtered = append(filtered, inv)
			}
		}
		corpus = filtered
	}
	writeJSON(filepath.Join(*flagOut, "corpus.json"), corpus)
	writeJSON(filepath.Join(*flagOut, "verbs.json"), trees)

	diffs, seen := h.runCorpus(corpus, *flagJobs)
	report(trees, corpus, diffs, seen, *flagOut)
	if len(diffs) > 0 || trees.mismatch() {
		os.Exit(1)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "cli-differential: "+format+"\n", args...)
	os.Exit(2)
}

func newHarness(a, b, out string) (*harness, error) {
	if err := os.MkdirAll(out, 0o755); err != nil {
		return nil, err
	}
	h := &harness{known: map[string]bool{}, git: "/usr/bin/git"}
	// /usr/bin/git is an xcrun shim that writes a cache outside the fence and
	// prints its refusal into git's output; run the tool it resolves to.
	if out, err := exec.Command("/usr/bin/xcrun", "-f", "git").Output(); err == nil {
		h.git = strings.TrimSpace(string(out))
	}
	for i, dir := range []string{a, b} {
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			return nil, err
		}
		for _, cli := range []string{"felt", "shuttle"} {
			if _, err := os.Stat(filepath.Join(real, cli)); err != nil {
				return nil, fmt.Errorf("build %s: %w", dir, err)
			}
		}
		h.builds[i] = build{label: string(rune('a' + i)), dir: dir, real: real}
	}
	work, err := os.MkdirTemp(out, "fixtures-")
	if err != nil {
		return nil, err
	}
	if h.work, err = filepath.EvalSymlinks(work); err != nil {
		return nil, err
	}
	// One copy of each fake serves every run, so macOS assesses each script
	// once rather than on a run's first exec, which can outlast a CLI's own
	// probe timeouts.
	h.bin = filepath.Join(h.work, "bin")
	if err := h.writeFakes(h.bin); err != nil {
		return nil, err
	}
	if err := h.seedTemplate(); err != nil {
		return nil, fmt.Errorf("seeding the template: %w", err)
	}
	return h, nil
}

// ---- fixtures ---------------------------------------------------------------

// seedTemplate builds the fixture every run copies, using the baseline build.
// Its paths and daemon port are tokens a copy substitutes.
func (h *harness) seedTemplate() error {
	root := filepath.Join(h.work, "template")
	h.template = root
	for _, dir := range []string{"home", "config", "cache", "data", "state", "tmp", "work/project", "work/elsewhere", "codex", "claude"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			return err
		}
	}
	files := map[string]string{
		"home/.gitconfig":                 "[user]\n\tname = Diff Tester\n\temail = diff@example.invalid\n[init]\n\tdefaultBranch = main\n",
		"config/shuttle/host":             hostID + "\n",
		"work/project/notes/relative.txt": "relative file in the project\n",
		"work/project/message.txt":        "launch directive from a file\n",
		"work/elsewhere/message.txt":      "decoy directive outside the project\n",
		"work/project/attach.txt":         "attachment body\n",
		"work/hook-stdin.json":            `{"hook_event_name":"SessionStart","session_id":"diff-session","cwd":"` + fixToken + `/work/project"}` + "\n",
	}
	for rel, body := range files {
		if err := writeFile(filepath.Join(root, rel), body); err != nil {
			return err
		}
	}

	run := func(cli string, args ...string) error {
		inv := invocation{Name: "seed", CLI: cli, Args: args, Cwd: "work/project"}
		cmd, _, _ := h.command(h.builds[0], root, seedPort, inv)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s %s: %v\n%s", cli, strings.Join(args, " "), err, out)
		}
		return nil
	}
	project := filepath.Join(root, "work", "project")
	steps := [][]string{
		{"git", "init", "-q"},
		{"felt", "init"},
		{"felt", "add", "alpha", "Alpha note", "-b", "Links [[beta]] and [[gamma]].", "-t", "note"},
		{"felt", "add", "beta", "Beta task", "-s", "active", "-o", "in flight"},
		{"felt", "add", "beta/child", "Beta child"},
		{"felt", "add", "gamma", "Gamma done", "-s", "closed", "-o", "done"},
		{"felt", "add", "delta", "Delta remote", "-s", "active"},
		{"felt", "add", "epsilon", "Epsilon standing"},
		{"felt", "add", "zeta", "Zeta pinned"},
		{"felt", "add", "roles/reviewer", "Reviewer role"},
		{"felt", "add", "roles/reviewer/ada", "Ada collaborator"},
		{"shuttle", "remotes", "add", remoteHost, "--url", "http://127.0.0.1:" + seedPort},
		{"shuttle", "install", "beta", "--project-dir", project},
		{"shuttle", "install", "delta", "--project-dir", project, "--host", remoteHost},
		{"shuttle", "repeat", "epsilon", "--project-dir", project, "--schedule", "0 9 * * *"},
		{"shuttle", "pin", "zeta", "--project-dir", project},
		{"git", "add", "-A"},
		{"git", "commit", "-q", "-m", "seed"},
	}
	for _, step := range steps {
		var err error
		if step[0] == "git" {
			cmd := exec.Command(h.git, step[1:]...)
			cmd.Dir = project
			cmd.Env = append(h.baseEnv(root, seedPort), "GIT_AUTHOR_DATE=2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-01-01T00:00:00Z")
			if out, e := cmd.CombinedOutput(); e != nil {
				err = fmt.Errorf("git %v: %v\n%s", step[1:], e, out)
			}
		} else {
			err = run(step[0], step[1:]...)
		}
		if err != nil {
			return err
		}
	}
	// The template's exec log and paths are per run.
	_ = os.Remove(filepath.Join(root, "exec.log"))
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Type()&fs.ModeSymlink != 0 {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range ulidRE.FindAllString(string(raw), -1) {
			h.known[m] = true
		}
		for _, m := range timestampRE.FindAllString(string(raw), -1) {
			h.known[m] = true
		}
		return nil
	})
}

// newFixture copies the template to a fresh root, substituting its paths and
// daemon port, and writes the fakes.
func (h *harness) newFixture(port string) (string, error) {
	dir, err := os.MkdirTemp(h.work, "run-")
	if err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	err = filepath.WalkDir(h.template, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(h.template, path)
		dest := filepath.Join(root, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.MkdirAll(dest, info.Mode().Perm())
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(strings.ReplaceAll(target, h.template, root), dest)
		default:
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if !strings.Contains(rel, ".git"+string(filepath.Separator)+"objects") {
				raw = bytes.ReplaceAll(raw, []byte(h.template), []byte(root))
				raw = bytes.ReplaceAll(raw, []byte(fixToken), []byte(root))
				raw = bytes.ReplaceAll(raw, []byte("127.0.0.1:"+seedPort), []byte("127.0.0.1:"+port))
			}
			return os.WriteFile(dest, raw, info.Mode().Perm())
		}
	})
	if err != nil {
		return "", err
	}
	return root, nil
}

// writeFakes writes the fakes into bin. Each appends its call to
// $DIFF_EXEC_LOG, or, for a caller that scrubbed the environment, to the
// exec log beside $HOME.
func (h *harness) writeFakes(bin string) error {
	if err := os.MkdirAll(bin, 0o755); err != nil {
		return err
	}
	record := `rec="exec $(/usr/bin/basename "$0")
cwd $(/bin/pwd -P)"
for a in "$@"; do rec="$rec
arg $a"; done
rec="$rec
$(/usr/bin/env | /usr/bin/sort | /usr/bin/sed 's/^/env /')
--"
printf '%s\n' "$rec" >> "${DIFF_EXEC_LOG:-$HOME/../exec.log}"
`
	scripts := map[string]string{}
	for _, name := range fakeNames {
		scripts[name] = "#!/bin/sh\n" + record + "exit 0\n"
	}
	scripts["git"] = "#!/bin/sh\n" + record + "exec '" + h.git + "' \"$@\"\n"
	// felt and shuttle on PATH are the build under test; the harness points
	// DIFF_BUILD at it per run.
	for _, cli := range []string{"felt", "shuttle"} {
		scripts[cli] = "#!/bin/sh\n" + record + "exec \"$DIFF_BUILD/" + cli + "\" \"$@\"\n"
	}
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			return err
		}
	}
	return nil
}

// baseEnv is the whole environment a run starts from.
func (h *harness) baseEnv(root, port string) []string {
	return []string{
		"HOME=" + filepath.Join(root, "home"),
		"PATH=" + h.bin,
		"TMPDIR=" + filepath.Join(root, "tmp") + "/",
		"XDG_CONFIG_HOME=" + filepath.Join(root, "config"),
		"XDG_CACHE_HOME=" + filepath.Join(root, "cache"),
		"XDG_DATA_HOME=" + filepath.Join(root, "data"),
		"XDG_STATE_HOME=" + filepath.Join(root, "state"),
		"CODEX_HOME=" + filepath.Join(root, "codex"),
		"CLAUDE_CONFIG_DIR=" + filepath.Join(root, "claude"),
		"SHUTTLE_DAEMON_URL=http://127.0.0.1:" + port,
		"SHELL=" + filepath.Join(h.bin, "fake-shell"),
		"DIFF_EXEC_LOG=" + filepath.Join(root, "exec.log"),
		"USER=tester",
		"LOGNAME=tester",
		"LANG=C",
		"TZ=UTC",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_DATE=2026-01-01T00:00:00Z",
		"GIT_COMMITTER_DATE=2026-01-01T00:00:00Z",
	}
}

// ---- running ----------------------------------------------------------------

func (h *harness) sandboxProfile(root, port string, b build) string {
	var sb strings.Builder
	q := strconv.Quote
	sb.WriteString("(version 1)\n(allow default)\n")
	sb.WriteString("(deny file-write*)\n")
	fmt.Fprintf(&sb, "(allow file-write* (subpath %s) (literal \"/dev/null\") (literal \"/dev/tty\") (regex #\"^/dev/fd/\") (regex #\"^/dev/ttys\"))\n", q(root))
	sb.WriteString("(deny network-outbound)\n")
	if port != "" {
		fmt.Fprintf(&sb, "(allow network-outbound (remote ip %s))\n", q("localhost:"+port))
	}
	fmt.Fprintf(&sb, "(allow network-outbound (remote unix-socket (subpath %s)))\n", q(root))
	sb.WriteString("(deny process-exec)\n")
	fmt.Fprintf(&sb, "(allow process-exec (subpath %s) (subpath %s) (subpath %s) (subpath \"/bin\") (subpath \"/usr/bin\") (subpath \"/usr/libexec\") (subpath \"/Library/Developer/CommandLineTools\") (subpath \"/Applications/Xcode.app\"))\n", q(root), q(h.bin), q(b.real))
	sb.WriteString("(deny process-exec")
	for _, path := range deniedExecs {
		sb.WriteString(" (literal " + q(path) + ")")
	}
	sb.WriteString(")\n(deny signal (target others))\n")
	return sb.String()
}

// command is inv as an exec.Cmd fenced to root, with the profile path it
// wrote and the environment it used.
func (h *harness) command(b build, root, port string, inv invocation) (*exec.Cmd, string, []string) {
	profile := filepath.Join(root, ".sandbox.sb")
	if err := os.WriteFile(profile, []byte(h.sandboxProfile(root, port, b)), 0o644); err != nil {
		fatalf("%v", err)
	}
	env := map[string]string{}
	for _, kv := range h.baseEnv(root, port) {
		k, v, _ := strings.Cut(kv, "=")
		env[k] = v
	}
	for k, v := range inv.Env {
		if v == nil {
			delete(env, k)
		} else {
			env[k] = strings.ReplaceAll(*v, fixToken, root)
		}
	}
	env["DIFF_BUILD"] = b.real
	environ := make([]string, 0, len(env))
	for k, v := range env {
		environ = append(environ, k+"="+v)
	}
	sort.Strings(environ)

	args := []string{"-f", profile, filepath.Join(b.real, inv.CLI)}
	for _, arg := range inv.Args {
		args = append(args, strings.ReplaceAll(arg, fixToken, root))
	}
	cmd := exec.Command("/usr/bin/sandbox-exec", args...)
	cmd.Dir = filepath.Join(root, inv.Cwd)
	cmd.Env = environ
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd, profile, environ
}

func (h *harness) run(b build, inv invocation, timeout time.Duration) (record, string, error) {
	daemon := newMockDaemon()
	if err := daemon.start(); err != nil {
		return record{}, "", err
	}
	defer daemon.stop()
	root, err := h.newFixture(daemon.port)
	if err != nil {
		return record{}, "", err
	}
	if !h.keep {
		defer os.RemoveAll(root)
	}
	cmd, profile, _ := h.command(b, root, daemon.port, inv)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.Stdin = strings.NewReader(strings.ReplaceAll(inv.Stdin, fixToken, root))
	exit := ""
	if err := cmd.Start(); err != nil {
		return record{}, root, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(timeout):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		err = <-done
		exit = "timeout"
	}
	// Reap anything the run left in its process group.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if exit == "" {
		var exitErr *exec.ExitError
		switch {
		case err == nil:
			exit = "0"
		case errors.As(err, &exitErr):
			exit = strconv.Itoa(exitErr.ExitCode())
		default:
			exit = err.Error()
		}
	}
	_ = os.Remove(profile)

	n := h.normalizer(root, daemon.port)
	rec := record{
		Exit:     exit,
		Stdout:   n(stdout.String()),
		Stderr:   n(stderr.String()),
		Files:    snapshot(root, n),
		Git:      n(h.gitSummary(root)),
		Execs:    readExecs(root, n),
		Requests: daemon.recorded(n),
	}
	return rec, root, nil
}

type result struct {
	inv  invocation
	a, b record
	err  error
}

// tally counts what the baseline runs exercised, so a clean comparison can
// be told from one that observed nothing.
type tally struct {
	exitZero, exitNonzero, timeouts, withRequests, withExecs int
	timedOut                                                 []string
	// flaky are invocations that differed under load and then matched
	// when rerun alone.
	flaky []string
}

func (t *tally) add(name string, r record) {
	switch r.Exit {
	case "0":
		t.exitZero++
	case "timeout":
		t.timeouts++
		t.timedOut = append(t.timedOut, name)
	default:
		t.exitNonzero++
	}
	if len(r.Requests) > 0 {
		t.withRequests++
	}
	if len(r.Execs) > 0 {
		t.withExecs++
	}
}

func (h *harness) runCorpus(corpus []invocation, jobs int) ([]result, tally) {
	work := make(chan invocation)
	results := make(chan result)
	var wg sync.WaitGroup
	for i := 0; i < jobs; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for inv := range work {
				var r result
				r.inv = inv
				var err error
				if r.a, _, err = h.run(h.builds[0], inv, *flagTimeout); err == nil {
					r.b, _, err = h.run(h.builds[1], inv, *flagTimeout)
				}
				r.err = err
				results <- r
			}
		}()
	}
	go func() {
		for _, inv := range corpus {
			work <- inv
		}
		close(work)
		wg.Wait()
		close(results)
	}()
	var diffs []result
	var seen tally
	done := 0
	for r := range results {
		done++
		if done%100 == 0 {
			fmt.Fprintf(os.Stderr, "  %d/%d\n", done, len(corpus))
		}
		seen.add(r.inv.Name, r.a)
		if r.err != nil || !equalRecords(r.a, r.b) {
			diffs = append(diffs, r)
		}
	}
	// A parallel pass loads the machine enough to trip the CLIs' own short
	// deadlines now and then. Rerun each difference alone, twice; one that
	// matches is reported as flaky rather than as a difference.
	persistent := diffs[:0]
	for _, d := range diffs {
		matched := false
		for attempt := 0; attempt < 2 && d.err == nil && !matched; attempt++ {
			a, _, errA := h.run(h.builds[0], d.inv, *flagTimeout)
			b, _, errB := h.run(h.builds[1], d.inv, *flagTimeout)
			matched = errA == nil && errB == nil && equalRecords(a, b)
		}
		if matched {
			seen.flaky = append(seen.flaky, d.inv.Name)
		} else {
			persistent = append(persistent, d)
		}
	}
	diffs = persistent
	sort.Slice(diffs, func(i, j int) bool { return diffs[i].inv.Name < diffs[j].inv.Name })
	sort.Strings(seen.timedOut)
	sort.Strings(seen.flaky)
	return diffs, seen
}

func equalRecords(a, b record) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return bytes.Equal(ja, jb)
}

// ---- observation ------------------------------------------------------------

var (
	ulidRE = regexp.MustCompile(`\b[0-9A-HJKMNP-TV-Z]{26}\b`)
	// os.MkdirTemp and os.CreateTemp end a name in a random decimal.
	tempNameRE  = regexp.MustCompile(`(/[A-Za-z0-9._]+[-.])[0-9]{6,10}\b`)
	timestampRE = regexp.MustCompile(`\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?\b`)
)

// normalizer replaces what differs between two identically seeded runs for a
// reason that is not the build: the fixture's path, the daemon's port, the
// build directory, temporary names, and fresh ULIDs and timestamps.
func (h *harness) normalizer(root, port string) func(string) string {
	repl := strings.NewReplacer(
		h.bin, "$FIX/bin",
		root, "$FIX",
		strings.TrimPrefix(root, "/private"), "$FIX",
		h.builds[0].real, "$BUILD", h.builds[1].real, "$BUILD",
		h.builds[0].dir, "$BUILD", h.builds[1].dir, "$BUILD",
		"127.0.0.1:"+port, "127.0.0.1:$PORT",
		"localhost:"+port, "localhost:$PORT",
	)
	return func(s string) string {
		s = repl.Replace(s)
		s = tempNameRE.ReplaceAllString(s, "${1}$$RAND")
		s = ulidRE.ReplaceAllStringFunc(s, func(m string) string {
			if h.known[m] {
				return m
			}
			return "$ULID"
		})
		return timestampRE.ReplaceAllStringFunc(s, func(m string) string {
			if h.known[m] {
				return m
			}
			return "$TS"
		})
	}
}

// snapshot lists every file the fixture holds after a run, with its mode and
// content (or digest), leaving out the fakes, the exec log, the temp
// directory and Git's internals (gitSummary covers the repository).
func snapshot(root string, n func(string) string) map[string]string {
	out := map[string]string{}
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		rel, _ := filepath.Rel(root, path)
		if err != nil {
			out[rel] = "error: " + err.Error()
			return nil
		}
		if rel == "." {
			return nil
		}
		switch rel {
		case "bin", "tmp", ".git":
			return fs.SkipDir
		case "exec.log":
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			out[rel] = "git repository"
			return fs.SkipDir
		}
		info, err := d.Info()
		if err != nil {
			out[rel] = "error: " + err.Error()
			return nil
		}
		mode := info.Mode().String()
		switch {
		case d.IsDir():
			out[rel] = mode
		case d.Type()&fs.ModeSymlink != 0:
			target, _ := os.Readlink(path)
			out[rel] = mode + " -> " + n(target)
		case d.Type()&fs.ModeSocket != 0, d.Type()&fs.ModeNamedPipe != 0:
			out[rel] = mode
		default:
			raw, err := os.ReadFile(path)
			if err != nil {
				out[rel] = mode + " unreadable"
				return nil
			}
			if len(raw) > 256<<10 || bytes.IndexByte(raw, 0) >= 0 {
				sum := sha256.Sum256(raw)
				out[rel] = mode + " sha256:" + hex.EncodeToString(sum[:])
			} else {
				out[rel] = mode + "\n" + n(string(raw))
			}
		}
		return nil
	})
	return out
}

func (h *harness) gitSummary(root string) string {
	project := filepath.Join(root, "work", "project")
	var sb strings.Builder
	for _, args := range [][]string{
		{"log", "--all", "--format=%s%n%b%n-- %an <%ae>", "--name-status"},
		{"status", "--porcelain", "--untracked-files=all"},
		{"branch", "-a", "-vv", "--format=%(refname) %(upstream)"},
		{"stash", "list"},
		{"config", "--local", "--list"},
	} {
		cmd := exec.Command(h.git, args...)
		cmd.Dir = project
		cmd.Env = []string{"HOME=" + filepath.Join(root, "home"), "GIT_CONFIG_NOSYSTEM=1", "PATH=/usr/bin:/bin"}
		out, err := cmd.CombinedOutput()
		fmt.Fprintf(&sb, "$ git %s (%v)\n%s", strings.Join(args, " "), err, out)
	}
	return sb.String()
}

// readExecs is the fixture's recorded child executions, each one block of
// "exec", "cwd", "arg" and "env" lines. DIFF_BUILD is the harness's own.
func readExecs(root string, n func(string) string) []string {
	raw, err := os.ReadFile(filepath.Join(root, "exec.log"))
	if err != nil {
		return nil
	}
	var out []string
	for _, block := range strings.Split(string(raw), "\n--\n") {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		var lines []string
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "env DIFF_BUILD=") || strings.HasPrefix(line, "env DIFF_EXEC_LOG=") || strings.HasPrefix(line, "env _=") || strings.HasPrefix(line, "env SHLVL=") || strings.HasPrefix(line, "env PWD=") || strings.HasPrefix(line, "env OLDPWD=") {
				continue
			}
			lines = append(lines, line)
		}
		out = append(out, n(strings.Join(lines, "\n")))
	}
	return out
}

// ---- mock daemon --------------------------------------------------------------

type mockDaemon struct {
	ln   net.Listener
	srv  *http.Server
	port string
	mu   sync.Mutex
	reqs []string
}

func newMockDaemon() *mockDaemon { return &mockDaemon{} }

func (d *mockDaemon) start() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	d.ln = ln
	d.port = strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	d.srv = &http.Server{Handler: http.HandlerFunc(d.serve), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = d.srv.Serve(ln) }()
	return nil
}

func (d *mockDaemon) stop() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = d.srv.Shutdown(ctx)
}

func (d *mockDaemon) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var pretty bytes.Buffer
	if json.Valid(body) {
		var v any
		_ = json.Unmarshal(body, &v)
		canon, _ := json.Marshal(v)
		pretty.Write(canon)
	} else {
		pretty.Write(body)
	}
	headers := []string{}
	for _, key := range []string{"Content-Type", "Accept", "X-Shuttle-Origin", "X-Shuttle-Host", "Authorization"} {
		if v := r.Header.Get(key); v != "" {
			headers = append(headers, key+"="+v)
		}
	}
	d.mu.Lock()
	d.reqs = append(d.reqs, fmt.Sprintf("%s %s [%s] %s", r.Method, r.URL.RequestURI(), strings.Join(headers, " "), pretty.String()))
	d.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/v1/version":
		_, _ = io.WriteString(w, `{"host":"`+hostID+`","version":"difftest","git_sha":"difftest","git_short_sha":"difftest","ready":true,"booted_at":"2026-01-01T00:00:00Z","quarantined":false,"peers":[]}`)
	default:
		_, _ = io.WriteString(w, `{}`)
	}
}

func (d *mockDaemon) recorded(n func(string) string) []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, len(d.reqs))
	for i, r := range d.reqs {
		out[i] = n(r)
	}
	return out
}

// ---- verbs --------------------------------------------------------------------

type verbTrees struct {
	// Paths maps each CLI to the union of its verb paths, each a
	// space-joined path ("" is the root).
	Paths map[string][]string `json:"paths"`
	// Only lists, per build label, the verb paths that build alone has.
	Only    map[string][]string `json:"only"`
	Aliases map[string][]string `json:"aliases"`
}

func (t verbTrees) mismatch() bool {
	for _, only := range t.Only {
		if len(only) > 0 {
			return true
		}
	}
	return false
}

// hiddenVerbs are verbs help does not list, so the walk cannot find them.
var hiddenVerbs = map[string][]string{"shuttle": {"resolve-dir"}}

var helpHeaders = map[string]bool{"Usage:": true, "Flags:": true, "Global Flags:": true, "Aliases:": true, "Examples:": true, "Additional help topics:": true}

// enumerate walks each build's help, breadth first, from each CLI's root.
func (h *harness) enumerate() (verbTrees, error) {
	trees := verbTrees{Paths: map[string][]string{}, Only: map[string][]string{}, Aliases: map[string][]string{}}
	for _, cli := range []string{"felt", "shuttle"} {
		seen := [2]map[string]bool{{}, {}}
		for i, b := range h.builds {
			queue := [][]string{{}}
			seen[i][""] = true
			for len(queue) > 0 {
				path := queue[0]
				queue = queue[1:]
				rec, _, err := h.run(b, invocation{CLI: cli, Args: append(append([]string{}, path...), "--help"), Cwd: "work/project"}, *flagTimeout)
				if err != nil {
					return trees, err
				}
				subs, aliases := parseHelp(rec.Stdout)
				if len(aliases) > 0 && i == 0 {
					trees.Aliases[cli+" "+strings.Join(path, " ")] = aliases
				}
				for _, sub := range subs {
					next := append(append([]string{}, path...), sub)
					key := strings.Join(next, " ")
					if !seen[i][key] {
						seen[i][key] = true
						queue = append(queue, next)
					}
				}
			}
		}
		union := map[string]bool{}
		for _, verb := range hiddenVerbs[cli] {
			union[verb] = true
		}
		for i, s := range seen {
			for key := range s {
				union[key] = true
				if !seen[1-i][key] {
					label := h.builds[i].label
					trees.Only[label] = append(trees.Only[label], cli+" "+key)
				}
			}
		}
		for key := range union {
			trees.Paths[cli] = append(trees.Paths[cli], key)
		}
		sort.Strings(trees.Paths[cli])
	}
	return trees, nil
}

// parseHelp reads the subcommands listed under any command-group header of a
// cobra help page (everything after Usage: that is not a flag, alias or
// example section), and the Aliases: line.
func parseHelp(help string) (subs, aliases []string) {
	_, rest, ok := strings.Cut(help, "\nUsage:\n")
	if !ok {
		if strings.HasPrefix(help, "Usage:\n") {
			rest = strings.TrimPrefix(help, "Usage:\n")
		} else {
			return nil, nil
		}
	}
	section := "Usage:"
	for _, line := range strings.Split(rest, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(line, " ") && strings.HasSuffix(trimmed, ":") {
			section = trimmed
			continue
		}
		if !strings.HasPrefix(line, " ") {
			section = ""
			continue
		}
		if section == "Aliases:" {
			for _, alias := range strings.Split(trimmed, ",") {
				aliases = append(aliases, strings.TrimSpace(alias))
			}
			continue
		}
		if section == "" || helpHeaders[section] {
			continue
		}
		if fields := strings.Fields(trimmed); len(fields) > 0 && strings.HasPrefix(line, "  ") && !strings.HasPrefix(fields[0], "-") {
			subs = append(subs, fields[0])
		}
	}
	return subs, aliases
}

// ---- corpus -------------------------------------------------------------------

func strp(s string) *string { return &s }

func buildCorpus(trees verbTrees, envNames []string) []invocation {
	var corpus []invocation
	add := func(name, cli, cwd string, args []string, env map[string]*string, stdin string) {
		corpus = append(corpus, invocation{Name: name, CLI: cli, Args: args, Cwd: cwd, Env: env, Stdin: stdin})
	}
	const proj = "work/project"

	// Every verb: help, bare, a bad flag, fiber arguments, JSON, completion.
	for _, cli := range []string{"felt", "shuttle"} {
		for _, key := range trees.Paths[cli] {
			path := strings.Fields(key)
			with := func(extra ...string) []string { return append(append([]string{}, path...), extra...) }
			label := cli + " " + key
			add(label+" --help", cli, proj, with("--help"), nil, "")
			if len(path) > 0 {
				add(cli+" help "+key, cli, proj, append([]string{"help"}, path...), nil, "")
			}
			add(label+" (bare)", cli, proj, with(), nil, "")
			add(label+" --no-such-flag", cli, proj, with("--no-such-flag"), nil, "")
			for _, fiber := range []string{"alpha", "beta", "delta", "epsilon", "zeta", "missing-fiber"} {
				add(label+" "+fiber, cli, proj, with(fiber), nil, "")
			}
			add(label+" beta --json", cli, proj, with("beta", "--json"), nil, "")
			add(label+" beta extra-arg", cli, proj, with("beta", "extra-arg"), nil, "")
			add(label+" (bare, outside a store)", cli, "home", with(), nil, "")
			add(label+" beta (stdin)", cli, proj, with("beta"), nil, "text on stdin\n")
			for _, partial := range []string{"", "b", "-"} {
				add(cli+" __complete "+key+" "+strconv.Quote(partial), cli, proj, append(append([]string{"__complete"}, path...), partial), nil, "")
			}
		}
		for key, aliases := range trees.Aliases {
			if !strings.HasPrefix(key, cli+" ") {
				continue
			}
			parent := strings.Fields(strings.TrimPrefix(key, cli+" "))
			if len(parent) == 0 {
				continue
			}
			for _, alias := range aliases {
				aliased := append(append([]string{}, parent[:len(parent)-1]...), alias)
				add(cli+" alias "+strings.Join(aliased, " ")+" --help", cli, proj, append(aliased, "--help"), nil, "")
				add(cli+" alias "+strings.Join(aliased, " ")+" beta", cli, proj, append(aliased, "beta"), nil, "")
			}
		}
		for _, args := range [][]string{{"--version"}, {"-v"}, {"version"}, {"completion", "bash"}, {"completion", "zsh"}, {"completion", "fish"}, {"completion", "powershell"}, {}, {"-j"}, {"--json", "ls"}} {
			add(cli+" global "+strings.Join(args, " "), cli, proj, args, nil, "")
		}
	}

	// Store selection: cwd, -C relative and absolute, a missing or file -C.
	dirFlag := map[string]string{"felt": "-C", "shuttle": "--store"}
	reads := map[string][][]string{
		"felt":    {{"ls"}, {"ls", "--json"}, {"show", "alpha"}, {"tree"}, {"check"}, {"find", "alpha"}, {"session"}, {"add", "new-fiber", "New fiber"}, {"edit", "alpha", "-s", "active"}},
		"shuttle": {{"ls"}, {"status", "beta"}, {"status"}, {"check"}, {"show", "beta"}, {"pause", "beta"}, {"close", "beta"}, {"dispatch", "beta", "--message", "go"}},
	}
	cwds := []string{"work/project", "work/project/.felt", "work/project/.felt/beta", "work/project/notes", "work", "home", "work/elsewhere"}
	for _, cli := range []string{"felt", "shuttle"} {
		for _, args := range reads[cli] {
			label := cli + " " + strings.Join(args, " ")
			for _, cwd := range cwds {
				add(label+" @cwd="+cwd, cli, cwd, args, nil, "")
			}
			for _, sel := range []struct{ cwd, dir string }{
				{"home", fixToken + "/work/project"},
				{"work", "project"},
				{"work/elsewhere", "../project"},
				{"home", "~/../work/project"},
				{"work/project", "nonexistent"},
				{"work/project", "message.txt"},
				{"work/project", ""},
			} {
				add(label+" "+dirFlag[cli]+"="+sel.dir+" @cwd="+sel.cwd, cli, sel.cwd, append([]string{dirFlag[cli], sel.dir}, args...), nil, "")
			}
		}
	}

	// Relative and absolute file arguments, from a cwd that holds them and
	// from one that holds a decoy of the same name.
	files := map[string][][]string{
		"felt": {
			{"init", "relative-store"},
			{"migrate", "--dir", "project", "--dry-run"},
			{"backfill-ids", "--dir", "project", "--dry-run"},
			{"setup", "skills", "--target", "relative-skills", "--source", "missing-source"},
			{"setup", "validate", "--source", "missing-source", "--executable", "relative-felt"},
		},
		"shuttle": {
			{"dispatch", "beta", "--message-file", "message.txt"},
			{"dispatch", "delta", "--message-file", "message.txt"},
			{"reopen", "gamma", "--message-file", "message.txt"},
			{"reopen", "delta", "--message-file", "message.txt"},
			{"message", "beta", "--file", "message.txt"},
			{"message", "beta", "hello", "--attach", "attach.txt"},
			{"message", "beta", "hello", "--attach", "message.txt"},
			{"agents", "init", "--path", "relative-agents.json"},
			{"sessions", "beta", "--materialize", "--dir", "relative-transcripts"},
			{"daemon", "install", "--print", "--os", "Linux", "--path", "/bin", "--log", "relative-logs/shuttle.log"},
			{"daemon", "install", "--print", "--os", "Darwin", "--path", "/bin", "--log", "relative-logs/shuttle.log"},
			{"tunnels", "install", "--dry-run", "--unit-dir", "relative-units", "--log-dir", "relative-logs"},
			{"tunnels", "install", "--write-only", "--unit-dir", "relative-units", "--log-dir", "relative-logs", "--autossh-path", "/bin/echo"},
			{"send-file", "message.txt"},
			{"follow", "message.txt"},
			{"resolve-dir", "notes"},
			{"install", "alpha", "--project-dir", "notes"},
			{"install", "alpha", "--project-dir", "~/"},
			{"install", "alpha", "--project-dir", "$HOME"},
			{"resume", "zeta", "--project-dir", "."},
			{"handoff", "beta"},
			{"handoff", ".felt/beta/beta.md"},
		},
	}
	for _, cli := range []string{"felt", "shuttle"} {
		for _, args := range files[cli] {
			label := cli + " " + strings.Join(args, " ")
			for _, cwd := range []string{"work/project", "work/elsewhere", "work"} {
				add(label+" @cwd="+cwd, cli, cwd, args, nil, "")
			}
		}
	}

	// Standard input sources and hook adapters.
	stdins := []struct {
		cli   string
		args  []string
		stdin string
	}{
		{"shuttle", []string{"message", "beta", "-"}, "message from stdin\n"},
		{"shuttle", []string{"message", "beta", "--file", "-"}, "message from stdin\n"},
		{"shuttle", []string{"dispatch", "beta", "--message-file", "-"}, "directive from stdin\n"},
		{"shuttle", []string{"set-outcome", "beta"}, "outcome from stdin\n"},
		{"shuttle", []string{"message", "--request-json"}, `{"to":"beta","text":"framed","message_id":"m1"}`},
		{"felt", []string{"edit", "alpha", "--body", "-"}, "body from stdin\n"},
	}
	for _, s := range stdins {
		add(s.cli+" "+strings.Join(s.args, " ")+" (stdin)", s.cli, proj, s.args, nil, s.stdin)
	}
	hookStdin := `{"hook_event_name":"SessionStart","session_id":"diff-session","cwd":"` + fixToken + `/work/project","transcript_path":"` + fixToken + `/work/t.jsonl"}`
	for _, cli := range []string{"felt", "shuttle"} {
		for _, key := range trees.Paths[cli] {
			if strings.HasPrefix(key, "hook ") {
				add(cli+" "+key+" (hook stdin)", cli, proj, strings.Fields(key), nil, hookStdin)
			}
		}
	}

	// Environment: every variable either source reads, unset, empty, relative
	// and absolute, against a set of probes.
	probes := []struct {
		cli  string
		args []string
	}{
		{"felt", []string{"ls"}},
		{"felt", []string{"show", "alpha"}},
		{"felt", []string{"session"}},
		{"felt", []string{"setup", "receipt"}},
		{"shuttle", []string{"host"}},
		{"shuttle", []string{"host", "--json"}},
		{"shuttle", []string{"status", "beta"}},
		{"shuttle", []string{"ls"}},
		{"shuttle", []string{"remotes", "list"}},
		{"shuttle", []string{"agents", "list"}},
		{"shuttle", []string{"dispatch", "beta", "--message", "go"}},
		{"shuttle", []string{"pause", "delta"}},
		{"shuttle", []string{"message", "beta", "hello"}},
		{"shuttle", []string{"sessions"}},
		{"shuttle", []string{"version"}},
		{"shuttle", []string{"doctor"}},
		{"shuttle", []string{"daemon", "install", "--print"}},
	}
	for _, name := range envNames {
		for _, value := range []struct {
			label string
			v     *string
		}{{"unset", nil}, {"empty", strp("")}, {"relative", strp("relative/value")}, {"absolute", strp(fixToken + "/work/envvalue")}} {
			for _, p := range probes {
				add(fmt.Sprintf("%s %s @env %s=%s", p.cli, strings.Join(p.args, " "), name, value.label), p.cli, proj, p.args, map[string]*string{name: value.v}, "")
			}
		}
	}
	return corpus
}

// ---- reporting ----------------------------------------------------------------

func report(trees verbTrees, corpus []invocation, diffs []result, seen tally, out string) {
	dir := filepath.Join(out, "diffs")
	_ = os.RemoveAll(dir)
	_ = os.MkdirAll(dir, 0o755)
	var sb strings.Builder
	verbs := 0
	for _, paths := range trees.Paths {
		verbs += len(paths)
	}
	fmt.Fprintf(&sb, "invocations: %d (each run once per build)\n", len(corpus))
	fmt.Fprintf(&sb, "verb paths: felt %d, shuttle %d\n", len(trees.Paths["felt"]), len(trees.Paths["shuttle"]))
	for label, only := range trees.Only {
		fmt.Fprintf(&sb, "verbs only build %s has: %s\n", label, strings.Join(only, ", "))
	}
	fmt.Fprintf(&sb, "baseline runs: %d exit 0, %d exit non-zero, %d timed out; %d sent daemon requests, %d ran child processes\n",
		seen.exitZero, seen.exitNonzero, seen.timeouts, seen.withRequests, seen.withExecs)
	for _, name := range seen.timedOut {
		fmt.Fprintf(&sb, "  timed out on the baseline: %s\n", name)
	}
	for _, name := range seen.flaky {
		fmt.Fprintf(&sb, "  differed under load, matched alone: %s\n", name)
	}
	fmt.Fprintf(&sb, "differing invocations: %d\n", len(diffs))
	for i, d := range diffs {
		base := filepath.Join(dir, fmt.Sprintf("%04d", i))
		if d.err != nil {
			fmt.Fprintf(&sb, "  %04d %s: harness error: %v\n", i, d.inv.Name, d.err)
			continue
		}
		writeJSON(base+".a.json", d.a)
		writeJSON(base+".b.json", d.b)
		writeJSON(base+".invocation.json", d.inv)
		fmt.Fprintf(&sb, "  %04d %s: %s\n", i, d.inv.Name, strings.Join(differingFields(d.a, d.b), ", "))
	}
	_ = os.WriteFile(filepath.Join(out, "report.txt"), []byte(sb.String()), 0o644)
	fmt.Print(sb.String())
}

func differingFields(a, b record) []string {
	var fields []string
	if a.Exit != b.Exit {
		fields = append(fields, "exit "+a.Exit+" vs "+b.Exit)
	}
	if a.Stdout != b.Stdout {
		fields = append(fields, "stdout")
	}
	if a.Stderr != b.Stderr {
		fields = append(fields, "stderr")
	}
	ja, _ := json.Marshal(a.Files)
	jb, _ := json.Marshal(b.Files)
	if !bytes.Equal(ja, jb) {
		fields = append(fields, "files")
	}
	if a.Git != b.Git {
		fields = append(fields, "git")
	}
	if strings.Join(a.Execs, "\x00") != strings.Join(b.Execs, "\x00") {
		fields = append(fields, "execs")
	}
	if strings.Join(a.Requests, "\x00") != strings.Join(b.Requests, "\x00") {
		fields = append(fields, "requests")
	}
	return fields
}

func writeJSON(path string, v any) {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fatalf("%v", err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		fatalf("%v", err)
	}
}

func writeFile(path, body string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(body), 0o644)
}
