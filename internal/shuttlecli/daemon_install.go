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
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const defaultDaemonLabel = "io.shuttle.daemon"

var templatePlaceholderPattern = regexp.MustCompile(`__[A-Z][A-Z0-9_]*__`)

func newShuttleDaemonInstallCommand() *cobra.Command {
	home, _ := os.UserHomeDir()
	sshSocket, sshSocketSet := os.LookupEnv("AGENT_SSH_AUTH_SOCK")
	if !sshSocketSet && runtime.GOOS == "darwin" {
		sshSocket = filepath.Join(home, ".ssh", "agent.sock")
	}
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
			options.SSHSocketSet = options.SSHSocketSet || cmd.Flags().Changed("ssh-auth-sock")
			return installDaemonSupervisor(options)
		},
	}
	command.Flags().StringVar(&options.Stores, "stores", options.Stores, "Fixed comma-separated store list; empty uses the editable registry")
	command.Flags().StringVar(&options.SSHSocket, "ssh-auth-sock", options.SSHSocket, "SSH agent socket to use (empty omits the setting)")
	command.Flags().StringVar(&options.Path, "path", options.Path, "PATH for the supervisor (default: captured from a login shell)")
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
	Print        bool
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
	if options.Path == "" {
		options.Path = captureLoginPath()
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
		"--ssh-auth-sock": options.SSHSocket,
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
	return nil
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
		shuttleBin, err = resolvedExecutablePath()
		if err != nil {
			return "", err
		}
	}
	values := map[string]string{
		"__SHUTTLE_BIN__":         shuttleBin,
		"__SHUTTLE_RELEASE__":     release.Dir,
		"__LOG__":                 options.Log,
		"__SHUTTLE_STORES__":      options.Stores,
		"__SHUTTLE_STORES_FILE__": options.StoresFile,
		"__PATH__":                options.Path,
		"__PORT__":                options.Port,
		"__SSH_AUTH_SOCK__":       options.SSHSocket,
	}
	if osName == "Darwin" {
		values["__LABEL__"] = options.Label
		for _, key := range []string{"__PORT__", "__SSH_AUTH_SOCK__"} {
			if values[key] == "" {
				plistKey := "SSH_AUTH_SOCK"
				if key == "__PORT__" {
					plistKey = "SHUTTLE_PORT"
				}
				source = removePlistEntry(source, plistKey, key)
			}
		}
		escaped := map[string]string{
			"__LABEL__": xmlEscape(options.Label), "__SHUTTLE_BIN__": xmlEscape(values["__SHUTTLE_BIN__"]),
			"__SHUTTLE_RELEASE__": xmlEscape(release.Dir), "__LOG__": xmlEscape(options.Log),
			"__SHUTTLE_STORES__": xmlEscape(options.Stores), "__SHUTTLE_STORES_FILE__": xmlEscape(options.StoresFile),
			"__PATH__": xmlEscape(options.Path), "__PORT__": xmlEscape(options.Port),
			"__SSH_AUTH_SOCK__": xmlEscape(options.SSHSocket),
		}
		for placeholder, value := range escaped {
			source = strings.ReplaceAll(source, placeholder, value)
		}
		return rejectUnrenderedPlaceholders(source)
	}

	if options.Port == "" {
		source = removeEnvironmentLine(source, "SHUTTLE_PORT", "__PORT__")
	}
	if options.SSHSocket == "" {
		source = removeEnvironmentLine(source, "SSH_AUTH_SOCK", "__SSH_AUTH_SOCK__")
	}
	source = strings.ReplaceAll(source, "WorkingDirectory=__SHUTTLE_RELEASE__", "WorkingDirectory="+systemdLiteralPath(release.Dir))
	source = strings.ReplaceAll(source, "StandardOutput=append:__LOG__", "StandardOutput=append:"+systemdUnitValue(options.Log))
	source = strings.ReplaceAll(source, "StandardError=append:__LOG__", "StandardError=append:"+systemdUnitValue(options.Log))
	source = replaceSystemdPlaceholder(source, "__LOG__", options.Log)
	source = replaceSystemdPlaceholder(source, "__SHUTTLE_BIN__", values["__SHUTTLE_BIN__"])
	source = replaceSystemdPlaceholder(source, "__SHUTTLE_RELEASE__", release.Dir)
	source = replaceSystemdPlaceholder(source, "__SHUTTLE_STORES__", options.Stores)
	source = replaceSystemdPlaceholder(source, "__SHUTTLE_STORES_FILE__", options.StoresFile)
	source = replaceSystemdPlaceholder(source, "__PATH__", options.Path)
	source = replaceSystemdPlaceholder(source, "__PORT__", options.Port)
	source = replaceSystemdPlaceholder(source, "__SSH_AUTH_SOCK__", options.SSHSocket)
	source = replaceSystemdExecStartPre(source)
	return rejectUnrenderedPlaceholders(source)
}

func validateTemplatePlaceholderSet(osName, source string) error {
	want := []string{"__SHUTTLE_BIN__", "__SHUTTLE_RELEASE__", "__LOG__", "__SHUTTLE_STORES__", "__SHUTTLE_STORES_FILE__", "__PATH__", "__PORT__", "__SSH_AUTH_SOCK__"}
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

func systemdUnitValue(value string) string {
	var result strings.Builder
	for _, r := range value {
		switch r {
		case '\\':
			result.WriteString(`\\`)
		case ' ':
			result.WriteString(`\x20`)
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
	if executable, err := resolvedExecutablePath(); err == nil {
		add(filepath.Dir(executable))
	}
	felt, err := exec.LookPath("felt")
	if err != nil {
		felt = findExecutableInPath("felt", strings.Join(entries, string(os.PathListSeparator)))
	}
	if felt != "" {
		add(filepath.Dir(felt))
	} else if executable, err := resolvedExecutablePath(); err == nil && isExecutable(filepath.Join(filepath.Dir(executable), "felt")) {
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

func captureLoginPath() string {
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
		if path := captureLoginPathWith(attempt.shell, attempt.flags); path != "" {
			return strings.Join(cleanPathEntries(path), string(os.PathListSeparator))
		}
	}
	return strings.Join(cleanPathEntries(os.Getenv("PATH")), string(os.PathListSeparator))
}

func captureLoginPathWith(shell, flags string) string {
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
	file, err := os.CreateTemp("", "shuttle-path-*.txt")
	if err != nil {
		return ""
	}
	path := file.Name()
	defer os.Remove(path)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, flags, `printf '\n__SHUTTLE_PATH__%s\n' "$PATH"`)
	cmd.Env = []string{
		"HOME=" + home, "USER=" + user, "SHELL=" + shell, "TERM=xterm-256color", "TMUX=shuttle-capture",
		"DISABLE_AUTO_UPDATE=true", "HOMEBREW_NO_AUTO_UPDATE=1",
	}
	cmd.Stdin = strings.NewReader("")
	cmd.Stdout = file
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		_ = file.Close()
		return ""
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return ""
	}
	data, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil {
		return ""
	}
	var captured string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "__SHUTTLE_PATH__") {
			captured = strings.TrimPrefix(line, "__SHUTTLE_PATH__")
		}
	}
	if !strings.Contains(captured, "/") {
		return ""
	}
	return captured
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
	if err := stopDaemonRelease(release); err != nil {
		return err
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
	marker, err := daemonStopMarkerPath()
	if err != nil {
		return err
	}
	if err := touchDaemonStopMarker(marker); err != nil {
		return fmt.Errorf("marking the requested daemon stop: %w", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	_ = exec.Command("tmux", "-S", filepath.Join(home, ".shuttle", "tmux.sock"), "kill-session", "-t", "shuttle-daemon").Run()
	_ = exec.Command("tmux", "kill-session", "-t", "shuttle-daemon").Run()
	if err := stopDaemonRelease(release); err != nil {
		return err
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

func defaultPort(port string) string {
	if port == "" {
		return "4000"
	}
	return port
}
