package shuttlecli

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	osuser "os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const defaultDaemonLabel = "io.shuttle.daemon"

var templatePlaceholderPattern = regexp.MustCompile(`__[A-Z][A-Z0-9_]*__`)

func newShuttleDaemonInstallCommand() *cobra.Command {
	home, _ := os.UserHomeDir()
	sshSocket, sshSocketSet := os.LookupEnv("AGENT_SSH_AUTH_SOCK")
	label := os.Getenv("AGENT_LABEL")
	if label == "" {
		label = defaultDaemonLabel
	}
	options := supervisorOptions{
		Label:        label,
		Stores:       os.Getenv("AGENT_STORES"),
		Path:         os.Getenv("AGENT_PATH"),
		Log:          os.Getenv("AGENT_LOG"),
		Port:         os.Getenv("AGENT_PORT"),
		SSHSocket:    sshSocket,
		SSHSocketSet: sshSocketSet,
		OS:           supervisorOS(runtime.GOOS),
	}
	command := &cobra.Command{
		Use:   "install",
		Short: "Install a per-user daemon supervisor",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			options.Print, _ = cmd.Flags().GetBool("print")
			options.OS, _ = cmd.Flags().GetString("os")
			if cmd.Flags().Changed("ssh-auth-sock") {
				options.SSHSocketSet = true
			} else if socket, ok := os.LookupEnv("AGENT_SSH_AUTH_SOCK"); ok {
				options.SSHSocket, options.SSHSocketSet = socket, true
			} else {
				options.SSHSocket, options.SSHSocketSet = defaultDaemonSSHSocket(options.OS, home), false
			}
			if cmd.Flags().Changed("tmux-tmpdir") {
				options.TmuxTmpdirSet = true
			} else if dir, ok := os.LookupEnv("AGENT_TMUX_TMPDIR"); ok {
				options.TmuxTmpdir, options.TmuxTmpdirSet = dir, true
			}
			options.CodexSocketSet = cmd.Flags().Changed("codex-socket")
			return installDaemonSupervisor(options)
		},
	}
	command.Flags().StringVar(&options.Stores, "stores", options.Stores, "Fixed comma-separated store list; empty uses the editable registry")
	command.Flags().StringVar(&options.SSHSocket, "ssh-auth-sock", options.SSHSocket, "SSH agent socket to use (empty omits the setting)")
	command.Flags().StringVar(&options.Path, "path", options.Path, "PATH for the supervisor (default: captured from a login shell)")
	command.Flags().StringVar(&options.TmuxTmpdir, "tmux-tmpdir", "", "TMUX_TMPDIR for the supervisor, so the daemon shares your tmux server (default: captured from a login shell; empty omits the setting)")
	command.Flags().StringVar(&options.CodexSocket, "codex-socket", "", "Codex desktop control socket (absolute path; defaults to SHUTTLE_CODEX_SOCKET or the installed setting; empty resets)")
	command.Flags().StringVar(&options.Log, "log", options.Log, "Daemon log path")
	command.Flags().StringVar(&options.Label, "label", options.Label, "Supervisor label")
	command.Flags().StringVar(&options.Port, "port", options.Port, "Daemon port for an additional instance")
	command.Flags().BoolVar(&options.Print, "print", false, "Render the supervisor without installing it")
	command.Flags().BoolVar(&options.Print, "dry-run", false, "Render the supervisor without installing it")
	command.Flags().String("os", options.OS, "Preview target OS (Darwin or Linux; only with --print)")
	return command
}

func newShuttleDaemonUninstallCommand() *cobra.Command {
	label := os.Getenv("AGENT_LABEL")
	if label == "" {
		label = defaultDaemonLabel
	}
	command := &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the per-user daemon supervisor",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			value, _ := cmd.Flags().GetString("label")
			return uninstallDaemonSupervisor(value)
		},
	}
	command.Flags().StringVar(&label, "label", label, "Supervisor label to remove")
	return command
}

type supervisorOptions struct {
	OS           string
	Label        string
	ShuttleBin   string
	Stores       string
	StoresFile   string
	Path         string
	Log          string
	Port         string
	SSHSocket    string
	SSHSocketSet bool
	// TmuxTmpdir selects the tmux server directory the daemon shares with
	// the user's login shells; TmuxTmpdirSet means it was given explicitly
	// rather than captured.
	TmuxTmpdir     string
	TmuxTmpdirSet  bool
	CodexSocket    string
	CodexSocketSet bool
	CodexHome      string
	Print          bool
}

func supervisorOS(goos string) string {
	switch goos {
	case "darwin":
		return "Darwin"
	case "linux":
		return "Linux"
	default:
		return goos
	}
}

func installDaemonSupervisor(options supervisorOptions) error {
	currentOS := supervisorOS(runtime.GOOS)
	if options.OS != currentOS && !options.Print {
		return errors.New("--os only applies to --print (an install must match this host)")
	}
	if options.OS != "Darwin" && options.OS != "Linux" {
		return fmt.Errorf("no keep-alive supervisor for %s (launchd on Darwin, systemd --user on Linux)", options.OS)
	}
	if err := validateSupervisorOptions(options); err != nil {
		return err
	}
	if err := resolveSupervisorCodex(&options); err != nil {
		return err
	}
	release, err := findDaemonRelease()
	if err != nil {
		return err
	}
	templatePath, err := findSupervisorTemplate(release, options.OS)
	if err != nil {
		return err
	}
	template, err := os.ReadFile(templatePath)
	if err != nil {
		return fmt.Errorf("reading supervisor template %s: %w", templatePath, err)
	}
	storesFile := options.StoresFile
	if storesFile == "" {
		storesFile, err = supervisorStoresFilePath()
		if err != nil {
			return err
		}
	}
	options.StoresFile = storesFile
	if options.Log == "" {
		options.Log = defaultDaemonLog(options.OS)
	}
	if options.Path == "" || !options.TmuxTmpdirSet {
		login := loginEnvCapture()
		if options.Path == "" {
			options.Path = login.Path
		}
		if !options.TmuxTmpdirSet {
			options.TmuxTmpdir = login.TmuxTmpdir
		}
	}
	options.Path = pathForDaemonSupervisor(options.Path)
	if options.SSHSocket == "" && options.OS == "Darwin" && !options.SSHSocketSet {
		home, _ := os.UserHomeDir()
		options.SSHSocket = filepath.Join(home, ".ssh", "agent.sock")
	}
	if err := validateSupervisorOptions(options); err != nil {
		return err
	}
	if options.Stores == "" {
		if _, err := os.Stat(options.StoresFile); errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "No store registry at %s; add a store in Settings → Stores after startup.\n", options.StoresFile)
		}
	}
	warnProtectedSupervisorPaths(options, release.Dir)
	rendered, err := renderSupervisorTemplate(options.OS, string(template), options, release)
	if err != nil {
		return err
	}
	if options.Print {
		fmt.Print(rendered)
		return nil
	}
	if _, _, _, err := seedOwnHost(); err != nil {
		fmt.Fprintf(os.Stderr, "⚠️  could not seed a host identity: %v\n", err)
		fmt.Fprintln(os.Stderr, "    The daemon dispatches nothing until it can resolve one.")
	}
	if err := os.MkdirAll(filepath.Dir(options.Log), 0o755); err != nil {
		return fmt.Errorf("creating daemon log directory: %w", err)
	}
	if options.OS == "Darwin" {
		return installLaunchAgent(options, release, rendered)
	}
	return installSystemdUserUnit(options, release, rendered)
}

func validateSupervisorOptions(options supervisorOptions) error {
	for name, value := range map[string]string{
		"--label": options.Label, "--stores": options.Stores, "--stores-file": options.StoresFile,
		"--path": options.Path, "--log": options.Log, "--port": options.Port,
		"--ssh-auth-sock": options.SSHSocket, "--tmux-tmpdir": options.TmuxTmpdir,
		"--codex-socket": options.CodexSocket, "CODEX_HOME": options.CodexHome,
	} {
		if strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("%s may not contain NUL or newline characters", name)
		}
	}
	if options.Label == "" {
		return errors.New("--label may not be empty")
	}
	if strings.ContainsAny(options.Label, `/\\`) {
		return errors.New("--label may not contain path separators")
	}
	if options.Port != "" {
		if _, err := parsePort(options.Port); err != nil {
			return fmt.Errorf("--port: %w", err)
		}
	}
	for name, path := range map[string]string{"--codex-socket": options.CodexSocket, "CODEX_HOME": options.CodexHome} {
		if path != "" && (!filepath.IsAbs(path) || filepath.Clean(path) != path) {
			return fmt.Errorf("%s must be a clean absolute filesystem path", name)
		}
	}
	return nil
}

func defaultDaemonSSHSocket(osName, home string) string {
	if osName == "Darwin" {
		return filepath.Join(home, ".ssh", "agent.sock")
	}
	return ""
}

// Explicit values override the installed supervisor; an omitted option preserves
// the desktop endpoint across reinstalls from shells without Codex's environment.
func resolveSupervisorCodex(options *supervisorOptions) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(home, "Library", "LaunchAgents", options.Label+".plist")
	if options.OS == "Linux" {
		path = filepath.Join(home, ".config", "systemd", "user", systemdUnitName(options.Label))
	}
	previous := map[string]string{}
	source, err := os.ReadFile(path)
	if err == nil {
		previous, err = supervisorCodexEnvironment(options.OS, string(source))
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("preserving Codex settings from %s: %w", path, err)
	}
	if !options.CodexSocketSet {
		if value, present := os.LookupEnv("SHUTTLE_CODEX_SOCKET"); present {
			options.CodexSocket = value
		} else {
			options.CodexSocket = previous["SHUTTLE_CODEX_SOCKET"]
		}
	}
	if value, present := os.LookupEnv("CODEX_HOME"); present {
		options.CodexHome = value
	} else {
		options.CodexHome = previous["CODEX_HOME"]
	}
	return validateSupervisorOptions(*options)
}

func supervisorCodexEnvironment(osName, source string) (map[string]string, error) {
	values := map[string]string{}
	keep := func(key, value string) {
		if key == "SHUTTLE_CODEX_SOCKET" || key == "CODEX_HOME" {
			values[key] = value
		}
	}
	if osName == "Linux" {
		for _, line := range strings.Split(source, "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "Environment=") || (!strings.Contains(line, "SHUTTLE_CODEX_SOCKET=") && !strings.Contains(line, "CODEX_HOME=")) {
				continue
			}
			assignment, err := strconv.Unquote(strings.TrimPrefix(line, "Environment="))
			if err != nil {
				return nil, fmt.Errorf("cannot decode Codex Environment assignment: %w", err)
			}
			key, value, _ := strings.Cut(assignment, "=")
			keep(key, strings.ReplaceAll(value, "%%", "%"))
		}
		return values, nil
	}
	decoder := xml.NewDecoder(strings.NewReader(source))
	depth, envDepth := 0, -1
	key := ""
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return values, nil
		}
		if err != nil {
			return nil, err
		}
		switch element := token.(type) {
		case xml.StartElement:
			if element.Name.Local == "key" || element.Name.Local == "string" {
				var value string
				if err := decoder.DecodeElement(&value, &element); err != nil {
					return nil, err
				}
				if element.Name.Local == "key" {
					key = value
				} else if depth == envDepth {
					keep(key, value)
				}
			} else {
				depth++
				if element.Name.Local == "dict" && key == "EnvironmentVariables" {
					envDepth = depth
					key = ""
				}
			}
		case xml.EndElement:
			if depth == envDepth {
				envDepth = -1
			}
			depth--
		}
	}
}

func defaultDaemonLog(osName string) string {
	home, _ := os.UserHomeDir()
	if osName == "Darwin" {
		return filepath.Join(home, "Library", "Logs", "shuttle.log")
	}
	return filepath.Join(home, ".shuttle", "shuttle.log")
}

func findSupervisorTemplate(release daemonRelease, osName string) (string, error) {
	name := "io.shuttle.daemon.service.template"
	if osName == "Darwin" {
		name = "io.shuttle.daemon.plist.template"
	}
	inRelease := filepath.Join(release.Dir, "share", name)
	if isRegularFile(inRelease) {
		return inRelease, nil
	}
	if filepath.Base(release.Dir) == "rel" && filepath.Base(filepath.Dir(release.Dir)) == "bin" {
		inCheckout := filepath.Join(filepath.Dir(filepath.Dir(release.Dir)), "daemon", "share", name)
		if isRegularFile(inCheckout) {
			return inCheckout, nil
		}
	}
	return "", fmt.Errorf("supervisor template %s not found beside the Mix release", name)
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func renderSupervisorTemplate(osName, source string, options supervisorOptions, release daemonRelease) (string, error) {
	if err := validateTemplatePlaceholderSet(osName, source); err != nil {
		return "", err
	}
	shuttleBin := options.ShuttleBin
	if shuttleBin == "" {
		var err error
		shuttleBin, err = executablePath()
		if err != nil {
			return "", err
		}
	}
	values := map[string]string{
		"__SHUTTLE_BIN__":         shuttleBin,
		"__SHUTTLE_RELEASE__":     release.Dir,
		"__WORKING_DIRECTORY__":   daemonWorkingDirectory(release.Dir),
		"__LOG__":                 options.Log,
		"__SHUTTLE_STORES__":      options.Stores,
		"__SHUTTLE_STORES_FILE__": options.StoresFile,
		"__PATH__":                options.Path,
		"__PORT__":                options.Port,
		"__SSH_AUTH_SOCK__":       options.SSHSocket,
		"__TMUX_TMPDIR__":         options.TmuxTmpdir,
		"__CODEX_SOCKET__":        options.CodexSocket,
		"__CODEX_HOME__":          options.CodexHome,
	}
	for _, placeholder := range []string{"__CODEX_SOCKET__", "__CODEX_HOME__"} {
		if values[placeholder] != "" && !strings.Contains(source, placeholder) {
			return "", errors.New("supervisor template does not support Codex desktop settings; update the daemon release before installing with a Codex endpoint")
		}
	}
	if osName == "Darwin" {
		values["__LABEL__"] = options.Label
		for _, optional := range optionalSupervisorEnv {
			if values[optional.placeholder] == "" {
				source = removePlistEntry(source, optional.key, optional.placeholder)
			}
		}
		for placeholder, value := range values {
			source = strings.ReplaceAll(source, placeholder, xmlEscape(value))
		}
		return rejectUnrenderedPlaceholders(source)
	}

	for _, optional := range optionalSupervisorEnv {
		if values[optional.placeholder] == "" {
			source = removeEnvironmentLine(source, optional.key, optional.placeholder)
		}
	}
	source = strings.ReplaceAll(source, "WorkingDirectory=__WORKING_DIRECTORY__", "WorkingDirectory="+systemdLiteralPath(values["__WORKING_DIRECTORY__"]))
	source = strings.ReplaceAll(source, "StandardOutput=append:__LOG__", "StandardOutput=append:"+systemdLiteralPath(options.Log))
	source = strings.ReplaceAll(source, "StandardError=append:__LOG__", "StandardError=append:"+systemdLiteralPath(options.Log))
	for placeholder, value := range values {
		source = replaceSystemdPlaceholder(source, placeholder, value)
	}
	source = replaceSystemdExecStartPre(source)
	return rejectUnrenderedPlaceholders(source)
}

// optionalSupervisorEnv lists the environment entries a rendered supervisor
// drops when their value is empty: an empty setting is worse than none.
var optionalSupervisorEnv = []struct{ key, placeholder string }{
	{"SHUTTLE_PORT", "__PORT__"},
	{"SSH_AUTH_SOCK", "__SSH_AUTH_SOCK__"},
	{"TMUX_TMPDIR", "__TMUX_TMPDIR__"},
	{"SHUTTLE_CODEX_SOCKET", "__CODEX_SOCKET__"},
	{"CODEX_HOME", "__CODEX_HOME__"},
}

func validateTemplatePlaceholderSet(osName, source string) error {
	want := []string{"__SHUTTLE_BIN__", "__SHUTTLE_RELEASE__", "__WORKING_DIRECTORY__", "__LOG__", "__SHUTTLE_STORES__", "__SHUTTLE_STORES_FILE__", "__PATH__", "__PORT__", "__SSH_AUTH_SOCK__", "__TMUX_TMPDIR__"}
	for _, optional := range []string{"__CODEX_SOCKET__", "__CODEX_HOME__"} {
		if strings.Contains(source, optional) {
			want = append(want, optional)
		}
	}
	if osName == "Darwin" {
		want = append(want, "__LABEL__")
	}
	sort.Strings(want)
	seen := map[string]bool{}
	for _, placeholder := range templatePlaceholderPattern.FindAllString(source, -1) {
		seen[placeholder] = true
	}
	got := make([]string, 0, len(seen))
	for placeholder := range seen {
		got = append(got, placeholder)
	}
	sort.Strings(got)
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		return fmt.Errorf("supervisor template placeholders are %v; want exactly %v", got, want)
	}
	return nil
}

func daemonWorkingDirectory(releaseDir string) string {
	if filepath.Base(releaseDir) == "rel" && filepath.Base(filepath.Dir(releaseDir)) == "bin" {
		return filepath.Dir(filepath.Dir(releaseDir))
	}
	return releaseDir
}

func rejectUnrenderedPlaceholders(source string) (string, error) {
	if remaining := templatePlaceholderPattern.FindAllString(source, -1); len(remaining) > 0 {
		return "", fmt.Errorf("unrendered supervisor template placeholders: %s", strings.Join(remaining, ", "))
	}
	return source, nil
}

func removePlistEntry(source, key, placeholder string) string {
	pattern := regexp.MustCompile(`(?m)^[ \t]*<key>` + regexp.QuoteMeta(key) + `</key>\r?\n[ \t]*<string>` + regexp.QuoteMeta(placeholder) + `</string>\r?\n`)
	return pattern.ReplaceAllString(source, "")
}

func removeEnvironmentLine(source, key, placeholder string) string {
	pattern := regexp.MustCompile(`(?m)^Environment="` + regexp.QuoteMeta(key) + `=` + regexp.QuoteMeta(placeholder) + `"\r?\n`)
	return pattern.ReplaceAllString(source, "")
}

func xmlEscape(value string) string {
	var encoded bytes.Buffer
	_ = xml.EscapeText(&encoded, []byte(value))
	return encoded.String()
}

func replaceSystemdPlaceholder(source, placeholder, value string) string {
	return strings.ReplaceAll(source, placeholder, systemdQuotedValue(value))
}

func systemdQuotedValue(value string) string {
	var result strings.Builder
	for _, r := range value {
		switch r {
		case '\\':
			result.WriteString(`\\`)
		case '"':
			result.WriteString(`\"`)
		case '%':
			result.WriteString("%%")
		case '\n':
			result.WriteString(`\n`)
		case '\r':
			result.WriteString(`\r`)
		case '\t':
			result.WriteString(`\t`)
		default:
			result.WriteRune(r)
		}
	}
	return result.String()
}

func systemdLiteralPath(value string) string {
	return strings.ReplaceAll(value, "%", "%%")
}

func replaceSystemdExecStartPre(source string) string {
	const prefix = "ExecStartPre="
	const command = `/bin/sh -c 'if [ -f "$$SHUTTLE_LOG" ] && [ "$$(wc -c < "$$SHUTTLE_LOG")" -gt 67108864 ]; then mv -f "$$SHUTTLE_LOG" "$$SHUTTLE_LOG.1"; fi'`
	lines := strings.Split(source, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, prefix) {
			lines[i] = prefix + command
		}
	}
	return strings.Join(lines, "\n")
}

func findExecutableInPath(name, pathValue string) string {
	for _, dir := range filepath.SplitList(pathValue) {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		if isExecutable(candidate) {
			return candidate
		}
	}
	return ""
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

func pathForDaemonSupervisor(pathValue string) string {
	entries := cleanPathEntries(pathValue)
	add := func(dir string) {
		if dir == "" {
			return
		}
		for _, existing := range entries {
			if existing == dir {
				return
			}
		}
		entries = append(entries, dir)
	}
	if executable, err := executablePath(); err == nil {
		add(filepath.Dir(executable))
	}
	felt, err := exec.LookPath("felt")
	if err != nil {
		felt = findExecutableInPath("felt", strings.Join(entries, string(os.PathListSeparator)))
	}
	if felt != "" {
		add(filepath.Dir(felt))
	} else if executable, err := executablePath(); err == nil && isExecutable(filepath.Join(filepath.Dir(executable), "felt")) {
		add(filepath.Dir(executable))
	} else {
		fmt.Fprintln(os.Stderr, "⚠️  no felt executable was found for the supervisor PATH.")
		fmt.Fprintln(os.Stderr, "    The daemon needs felt for fiber data; install both CLIs or pass --path.")
	}
	return strings.Join(entries, string(os.PathListSeparator))
}

func cleanPathEntries(value string) []string {
	seen := map[string]bool{}
	var entries []string
	for _, entry := range filepath.SplitList(value) {
		if entry == "" || seen[entry] {
			continue
		}
		seen[entry] = true
		entries = append(entries, entry)
	}
	return entries
}

// loginEnv is what a supervisor carries from the user's login shell: the
// PATH that finds both CLIs, and the TMUX_TMPDIR that places the daemon's
// workers on the same tmux server the user attaches to.
type loginEnv struct {
	Path       string
	TmuxTmpdir string
}

// loginEnvCapture is the capture installDaemonSupervisor uses.
var loginEnvCapture = captureLoginEnv

// captureLoginEnv runs one login shell in a scrubbed environment and reads
// every loginEnv variable from its output. It tries the user's shell as an
// interactive login shell, then as a plain login shell, then /bin/bash; the
// first attempt that reports a PATH supplies every value. If none does, the
// installing process's own environment stands in.
func captureLoginEnv() loginEnv {
	shell := os.Getenv("SHELL")
	base := filepath.Base(shell)
	switch base {
	case "bash", "zsh", "sh", "dash", "ksh", "ksh93", "mksh":
	default:
		shell = "/bin/bash"
	}
	if !isExecutable(shell) {
		shell = "/bin/bash"
	}
	for _, attempt := range []struct{ shell, flags string }{{shell, "-lic"}, {shell, "-lc"}, {"/bin/bash", "-lc"}} {
		if env, ok := captureLoginEnvWith(attempt.shell, attempt.flags); ok {
			env.Path = strings.Join(cleanPathEntries(env.Path), string(os.PathListSeparator))
			return env
		}
	}
	return loginEnv{
		Path:       strings.Join(cleanPathEntries(os.Getenv("PATH")), string(os.PathListSeparator)),
		TmuxTmpdir: os.Getenv("TMUX_TMPDIR"),
	}
}

const (
	loginPathMarker       = "__SHUTTLE_PATH__"
	loginTmuxTmpdirMarker = "__SHUTTLE_TMUX_TMPDIR__"
)

// captureLoginEnvWith runs one shell invocation and parses its fenced output.
// It reports false unless the shell printed a PATH.
func captureLoginEnvWith(shell, flags string) (loginEnv, bool) {
	home, _ := os.UserHomeDir()
	user := os.Getenv("USER")
	if user == "" {
		user = os.Getenv("LOGNAME")
	}
	if user == "" {
		if current, err := osuser.Current(); err == nil {
			user = current.Username
		}
	}
	file, err := os.CreateTemp("", "shuttle-env-*.txt")
	if err != nil {
		return loginEnv{}, false
	}
	path := file.Name()
	defer os.Remove(path)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	script := `printf '\n` + loginPathMarker + `%s\n` + loginTmuxTmpdirMarker + `%s\n' "${PATH-}" "${TMUX_TMPDIR-}"`
	cmd := exec.CommandContext(ctx, shell, flags, script)
	cmd.Env = []string{
		"HOME=" + home, "USER=" + user, "SHELL=" + shell, "TERM=xterm-256color", "TMUX=shuttle-capture",
		"DISABLE_AUTO_UPDATE=true", "HOMEBREW_NO_AUTO_UPDATE=1",
	}
	cmd.Stdin = strings.NewReader("")
	cmd.Stdout = file
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		_ = file.Close()
		return loginEnv{}, false
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return loginEnv{}, false
	}
	data, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil {
		return loginEnv{}, false
	}
	return parseLoginEnv(string(data))
}

// parseLoginEnv reads the last fenced value of each variable, so rc-file
// output printed before the fence cannot masquerade as a value.
func parseLoginEnv(output string) (loginEnv, bool) {
	var env loginEnv
	for _, line := range strings.Split(output, "\n") {
		switch {
		case strings.HasPrefix(line, loginPathMarker):
			env.Path = strings.TrimPrefix(line, loginPathMarker)
		case strings.HasPrefix(line, loginTmuxTmpdirMarker):
			env.TmuxTmpdir = strings.TrimPrefix(line, loginTmuxTmpdirMarker)
		}
	}
	if !strings.Contains(env.Path, "/") {
		return loginEnv{}, false
	}
	return env, true
}

func supervisorStoresFilePath() (string, error) {
	if path := strings.TrimSpace(os.Getenv("SHUTTLE_STORES_FILE")); path != "" {
		return expandUserPath(path)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".config", "shuttle", "stores.json"), nil
}

func warnProtectedSupervisorPaths(options supervisorOptions, releaseDir string) {
	if options.OS != "Darwin" {
		return
	}
	paths := []struct{ path, impact string }{{releaseDir, "the daemon will crash-loop on start."}}
	for _, store := range strings.Split(options.Stores, ",") {
		store = strings.TrimSpace(store)
		if store == "" {
			continue
		}
		if expanded, err := expandUserPath(store); err == nil {
			paths = append(paths, struct{ path, impact string }{expanded, "the daemon will start but walk no fibers — an empty board, no error."})
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	for _, item := range paths {
		for _, protected := range []string{"Documents", "Desktop", "Downloads"} {
			root := filepath.Join(home, protected)
			rel, err := filepath.Rel(root, item.path)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
				continue
			}
			fmt.Fprintf(os.Stderr, "⚠️  %s\n", item.path)
			fmt.Fprintln(os.Stderr, "    is under a TCC-protected folder (~/Documents, ~/Desktop, ~/Downloads).")
			fmt.Fprintln(os.Stderr, "    launchd cannot read there and Full Disk Access does not inherit, so")
			fmt.Fprintf(os.Stderr, "    %s\n", item.impact)
			fmt.Fprintln(os.Stderr, "    Fix: move it outside those folders (e.g. ~/felt or ~/dev).")
		}
	}
}

func installLaunchAgent(options supervisorOptions, release daemonRelease, rendered string) error {
	if supervisorInstallStopsDaemon(options.Label) {
		if err := stopDaemonRelease(release); err != nil {
			return err
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(home, "Library", "LaunchAgents", options.Label+".plist")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_ = exec.Command("launchctl", "unload", path).Run()
	if err := os.WriteFile(path, []byte(rendered), 0o644); err != nil {
		return err
	}
	if out, err := exec.Command("launchctl", "load", path).CombinedOutput(); err != nil {
		return fmt.Errorf("loading launchd agent: %w: %s", err, strings.TrimSpace(string(out)))
	}
	fmt.Printf("loaded %s → daemon will keep-alive + start at login\n", options.Label)
	fmt.Printf("board → http://127.0.0.1:%s/\n", defaultPort(options.Port))
	fmt.Printf("logs → %s   (launchctl list | grep shuttle to inspect)\n", options.Log)
	return nil
}

func installSystemdUserUnit(options supervisorOptions, release daemonRelease, rendered string) error {
	if err := exec.Command("systemctl", "--user", "show-environment").Run(); err != nil {
		fmt.Fprintln(os.Stderr, "no systemd user session here (systemctl --user is unavailable or not reachable).")
		fmt.Fprintln(os.Stderr, "Durable alternative — the tmux respawn loop:")
		fmt.Fprintf(os.Stderr, "  %s/bin/shuttle-launch\n", release.Dir)
		fmt.Fprintln(os.Stderr, "Or run the daemon without a supervisor:")
		fmt.Fprintf(os.Stderr, "  SHUTTLE_RELEASE=%s shuttle daemon start   # logs → %s\n", release.Dir, options.Log)
		return errors.New("systemd user manager is unavailable")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if supervisorInstallStopsDaemon(options.Label) {
		marker, err := daemonStopMarkerPath()
		if err != nil {
			return err
		}
		if err := touchDaemonStopMarker(marker); err != nil {
			return fmt.Errorf("marking the requested daemon stop: %w", err)
		}
		_ = exec.Command("tmux", "-S", filepath.Join(home, ".shuttle", "tmux.sock"), "kill-session", "-t", "shuttle-daemon").Run()
		_ = exec.Command("tmux", "kill-session", "-t", "shuttle-daemon").Run()
		if err := stopDaemonRelease(release); err != nil {
			return err
		}
	}
	unitName := systemdUnitName(options.Label)
	unitPath := filepath.Join(home, ".config", "systemd", "user", unitName)
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(unitPath, []byte(rendered), 0o644); err != nil {
		return err
	}
	for _, args := range [][]string{{"--user", "daemon-reload"}, {"--user", "enable", unitName}, {"--user", "restart", unitName}} {
		if out, err := exec.Command("systemctl", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}
	fmt.Printf("enabled %s → daemon restarts on crash + starts at login\n", unitName)
	fmt.Printf("board → http://127.0.0.1:%s/\n", defaultPort(options.Port))
	fmt.Printf("logs → %s   (systemctl --user status %s to inspect)\n", options.Log, unitName)
	fmt.Printf("run 'loginctl enable-linger %s' so it survives logout and starts at boot\n", os.Getenv("USER"))
	return nil
}

func uninstallDaemonSupervisor(label string) error {
	if label == "" {
		label = defaultDaemonLabel
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		path := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
		_ = exec.Command("launchctl", "unload", path).Run()
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		fmt.Printf("unloaded + removed %s\n", label)
		return nil
	}
	unitName := systemdUnitName(label)
	unitPath := filepath.Join(home, ".config", "systemd", "user", unitName)
	_ = exec.Command("systemctl", "--user", "disable", "--now", unitName).Run()
	if err := os.Remove(unitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	fmt.Printf("disabled + removed %s\n", unitName)
	return nil
}

func systemdUnitName(label string) string {
	if label == defaultDaemonLabel {
		return "shuttle-daemon.service"
	}
	return filepath.Base(label[strings.LastIndex(label, ".")+1:]) + ".service"
}

func supervisorInstallStopsDaemon(label string) bool {
	return label == defaultDaemonLabel
}

func defaultPort(port string) string {
	if port == "" {
		return "4000"
	}
	return port
}
