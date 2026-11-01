package shuttlecli

import (
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type releaseMigration struct {
	path              string
	original, updated []byte
	mode              os.FileMode
	label, osName     string
	loaded            bool
	reloadSystemd     bool
	dataDir           string
}

type systemdWord struct {
	start, end int
	value      string
}

// Retain raw spans so deleting one assignment never reserializes another.
func systemdEnvironmentWords(source string) ([]systemdWord, error) {
	var words []systemdWord
	for i := 0; i < len(source); {
		if strings.ContainsRune(" \t\r\n", rune(source[i])) {
			i++
			continue
		}
		start := i
		var value strings.Builder
		var quote byte
		for i < len(source) {
			c := source[i]
			if quote == 0 && strings.ContainsRune(" \t\r\n", rune(c)) {
				break
			}
			if c == '\\' && i+1 < len(source) {
				i++
				if source[i] != '\n' {
					value.WriteByte(source[i])
				}
				i++
				continue
			}
			if c == '\'' || c == '"' {
				if quote == 0 {
					quote = c
					i++
					continue
				}
				if quote == c {
					quote = 0
					i++
					continue
				}
			}
			value.WriteByte(c)
			i++
		}
		if quote != 0 {
			return nil, fmt.Errorf("unclosed quote in systemd Environment assignment")
		}
		words = append(words, systemdWord{start, i, value.String()})
	}
	return words, nil
}

func withoutSystemdReleasePin(line string) (string, error) {
	prefix, assignments, ok := strings.Cut(line, "=")
	if !ok || strings.TrimSpace(prefix) != "Environment" {
		return line, nil
	}
	words, err := systemdEnvironmentWords(assignments)
	if err != nil {
		return "", err
	}
	var result strings.Builder
	previous, retained, removed := 0, 0, false
	for _, word := range words {
		if strings.HasPrefix(word.value, "SHUTTLE_RELEASE=") {
			result.WriteString(assignments[previous:word.start])
			previous = word.end
			removed = true
		} else if word.value != "" {
			retained++
		}
	}
	if !removed {
		return line, nil
	}
	if retained == 0 {
		return "", nil
	}
	result.WriteString(assignments[previous:])
	return prefix + "=" + result.String(), nil
}

// XML offsets let us edit root fields and the environment dictionary without
// changing any other entry's spelling, escaping, whitespace or ordering.
func migratePlistReleasePins(source, home string) (string, error) {
	type replacement struct {
		start, end int
		text       string
	}
	var edits []replacement
	decoder := xml.NewDecoder(strings.NewReader(source))
	depth, rootDepth, envDepth := 0, -1, -1
	key, keyStart := "", 0
	for {
		start := int(decoder.InputOffset())
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		switch element := token.(type) {
		case xml.StartElement:
			if element.Name.Local == "key" || element.Name.Local == "string" {
				var value string
				if err := decoder.DecodeElement(&value, &element); err != nil {
					return "", err
				}
				if element.Name.Local == "key" {
					key, keyStart = value, start
					continue
				}
				end := int(decoder.InputOffset())
				if depth == envDepth && key == "SHUTTLE_RELEASE" {
					edits = append(edits, replacement{keyStart, end, ""})
				} else if depth == rootDepth && key == "WorkingDirectory" && value != home {
					edits = append(edits, replacement{start, end, "<string>" + xmlEscape(home) + "</string>"})
				}
				key = ""
			} else {
				if element.Name.Local == "dict" && depth == rootDepth && key == "EnvironmentVariables" {
					envDepth = depth + 1
				}
				depth++
				if element.Name.Local == "dict" && rootDepth == -1 {
					rootDepth = depth
				}
				key = ""
			}
		case xml.EndElement:
			if depth == envDepth {
				envDepth = -1
			}
			depth--
		}
	}
	for i := len(edits) - 1; i >= 0; i-- {
		edit := edits[i]
		source = source[:edit.start] + edit.text + source[edit.end:]
	}
	return source, nil
}

func systemdLogicalLines(source string) []string {
	physical := strings.SplitAfter(source, "\n")
	var logical []string
	for i := 0; i < len(physical); i++ {
		line := physical[i]
		for strings.HasSuffix(line, "\\\n") && i+1 < len(physical) {
			i++
			line += physical[i]
		}
		logical = append(logical, line)
	}
	return logical
}

// migrateReleasePins only changes SHUTTLE_RELEASE and WorkingDirectory.
// Other environment entries and service directives retain their original bytes.
func migrateReleasePins(osName, source, home string) (string, error) {
	if osName == "Darwin" {
		return migratePlistReleasePins(source, home)
	}
	var result strings.Builder
	for _, line := range systemdLogicalLines(source) {
		key, _, assignment := strings.Cut(line, "=")
		if assignment && strings.TrimSpace(key) == "WorkingDirectory" {
			result.WriteString(key + "=" + systemdLiteralPath(home))
			if strings.HasSuffix(line, "\n") {
				result.WriteByte('\n')
			}
			continue
		}
		updated, err := withoutSystemdReleasePin(line)
		if err != nil {
			return "", err
		}
		result.WriteString(updated)
	}
	return result.String(), nil
}

func (a *app) planReleaseMigrations() ([]releaseMigration, error) {
	home, err := a.env.UserHomeDir()
	if err != nil {
		return nil, err
	}
	osName := supervisorOS(runtime.GOOS)
	pattern := filepath.Join(home, "Library", "LaunchAgents", "*.plist")
	if osName == "Linux" {
		pattern = filepath.Join(home, ".config", "systemd", "user", "*.service")
	}
	paths, err := filepath.Glob(pattern)
	if err != nil {
		return nil, err
	}
	loop := daemonRespawnLoopPresent(a.env)
	var plans []releaseMigration
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		source := string(data)
		if !strings.Contains(source, "shuttle") || (!strings.Contains(source, "SHUTTLE_RELEASE") && !strings.Contains(source, "daemon start") && !strings.Contains(source, "<string>daemon</string>")) {
			continue
		}
		updated, err := migrateReleasePins(osName, source, home)
		if err != nil {
			return nil, fmt.Errorf("migrating %s: %w", path, err)
		}
		if updated == source {
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		label := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		if osName == "Linux" {
			if label == "shuttle-daemon" {
				label = defaultDaemonLabel
			} else {
				label = "io.shuttle." + label
			}
		}
		loaded, reloadSystemd := false, false
		if !loop {
			if osName == "Darwin" {
				loaded = a.env.Command("launchctl", "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), label)).Run() == nil
			} else {
				reloadSystemd = a.env.Command("systemctl", "--user", "show-environment").Run() == nil
				loaded = reloadSystemd && a.env.Command("systemctl", "--user", "is-active", "--quiet", systemdUnitName(label)).Run() == nil
			}
		}
		plan := releaseMigration{path: path, original: data, updated: []byte(updated), mode: info.Mode().Perm(), label: label, osName: osName, loaded: loaded, reloadSystemd: reloadSystemd}
		if loaded {
			values, err := supervisorEnvironment(osName, source)
			if err != nil {
				return nil, err
			}
			options := supervisorOptions{OS: osName, Label: label, Port: values["SHUTTLE_PORT"]}
			settings, err := a.supervisorHostSettings(options)
			if err != nil {
				return nil, err
			}
			service := *a
			service.env = a.env.Clone()
			// A service-local endpoint wins over manager and caller environments.
			service.env.Set("SHUTTLE_LISTEN", settings.Listen)
			for _, key := range []string{"SHUTTLE_HOST_CONFIG_FILE", "SHUTTLE_DATA_DIR", "SHUTTLE_PORT", "SHUTTLE_LISTEN"} {
				if value, ok := values[key]; ok {
					service.env.Set(key, value)
				}
			}
			settings, err = newApp(service.env).resolveHostSettings()
			if err != nil {
				return nil, err
			}
			if _, err := service.daemonLifecycleGet(settings, "/api/v1/version", 2*time.Second); err == nil && a.supervisorListenerPID(options, settings) == 0 {
				return nil, fmt.Errorf("refusing to migrate %s: its manager does not own the answering daemon", path)
			}
			plan.dataDir = settings.DataDir
		}
		plans = append(plans, plan)
	}
	return plans, nil
}

func (a *app) reloadReleaseMigrations(plans []releaseMigration, cycle bool) error {
	reloaded := false
	for _, plan := range plans {
		if plan.osName == "Linux" && plan.reloadSystemd && !cycle && !reloaded {
			if output, err := a.env.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
				return fmt.Errorf("reloading migrated units: %w: %s", err, output)
			}
			reloaded = true
		}
		if plan.loaded && cycle {
			if err := touchDaemonStopMarker(filepath.Join(plan.dataDir, "heartbeat.stopped")); err != nil {
				return err
			}
			if plan.osName == "Linux" {
				// The installed daemon may not report release_path yet. Its manager
				// can cycle it without guessing that old VM's boot directory.
				if output, err := a.env.Command("systemctl", "--user", "restart", systemdUnitName(plan.label)).CombinedOutput(); err != nil {
					return fmt.Errorf("restarting migrated unit: %w: %s", err, output)
				}
				continue
			}
			if output, err := a.env.Command("launchctl", "unload", plan.path).CombinedOutput(); err != nil {
				return fmt.Errorf("unloading migrated agent: %w: %s", err, output)
			}
			if output, err := a.env.Command("launchctl", "load", plan.path).CombinedOutput(); err != nil {
				return fmt.Errorf("loading migrated agent: %w: %s", err, output)
			}
		}
	}
	return nil
}
