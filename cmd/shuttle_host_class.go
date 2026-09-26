package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/spf13/cobra"
)

// The host class: what kind of machine this daemon runs on, and therefore what
// its listener may be.
//
//   - single-user: a laptop or workstation nobody else logs into. Loopback TCP
//     is private enough, so the daemon binds tcp://127.0.0.1:<port>.
//   - shared-multi-user: a login node or shared server. Every local user can
//     reach a loopback port, so the daemon binds a unix socket inside a 0700
//     directory instead, and filesystem permissions are the access control.
//   - exposed: a host reachable from outside (a mesh-VPN node serving the
//     board). The daemon must use a unix socket; its front proxy dials it.
//
// This is the Go half of a two-reader contract, like the fleet file: the
// daemon resolves the same class and listener from the same file, and
// daemon/test/fixtures/host/ holds cases BOTH suites must reproduce. The
// daemon also shells `felt shuttle host --json` as the validator, so the JSON
// shape of hostSettings is a wire format.
//
// Resolution:
//
//	file   $FELT_HOST_FILE, else ~/.config/felt/host.json
//	class  host.json "class", else single-user (missing file or key)
//	listen $SHUTTLE_LISTEN → host.json "listen" → the class default:
//	       single-user            tcp://127.0.0.1:<$SHUTTLE_PORT or 4000>
//	       shared-multi-user,
//	       exposed                unix://<$SHUTTLE_DATA_DIR or ~/.shuttle>/sock/daemon.sock
//
// Accepted listeners are tcp://127.0.0.1:PORT and unix://ABSOLUTE_PATH. A
// declared listener that binds anything but loopback is refused rather than
// honoured: the class exists to keep the daemon off the network.

type hostClass string

const (
	hostClassSingleUser hostClass = "single-user"
	hostClassShared     hostClass = "shared-multi-user"
	hostClassExposed    hostClass = "exposed"
)

var hostClasses = []hostClass{hostClassSingleUser, hostClassShared, hostClassExposed}

func (c hostClass) valid() bool {
	for _, known := range hostClasses {
		if c == known {
			return true
		}
	}
	return false
}

// usesSocket reports whether the class's listener must be a unix socket.
func (c hostClass) usesSocket() bool { return c == hostClassShared || c == hostClassExposed }

const (
	defaultDaemonPort = 4000

	// maxUnixSocketPath bounds a socket path's byte length. macOS caps
	// sun_path at 104 bytes including the terminating NUL (Linux at 108), and
	// the kernel truncates silently rather than failing the bind, so the
	// daemon would listen somewhere nobody dials. 100 leaves headroom on both.
	maxUnixSocketPath = 100

	// daemonSocketHost is the synthetic host daemonURL() hands out for a unix
	// listener. Every call site concatenates a path onto daemonURL(), so the
	// URL keeps the http:// shape; daemonHTTPClient's dialer recognizes this
	// host and dials the socket instead of DNS.
	// It is under .invalid (RFC 2606), which never resolves, so no real
	// remote can share the name.
	daemonSocketHost = "shuttle.invalid"
)

// Sources name the tier that answered, so a report can point at the thing
// that decided the value rather than a file sitting under an override.
const (
	hostSourceDefault      = "default"
	hostSourceHostFile     = "file"
	hostSourceListenEnv    = "SHUTTLE_LISTEN"
	hostSourceClassDefault = "class-default"
)

// hostConfigError is a refusal with a stable kind. The kind is what the
// parity fixtures assert, because the two languages word their messages
// differently and a message is not a contract.
type hostConfigError struct {
	Kind string
	Msg  string
}

func (e hostConfigError) Error() string { return e.Msg }

const (
	hostErrMalformed     = "malformed"
	hostErrBadClass      = "bad_class"
	hostErrBadListen     = "bad_listen"
	hostErrNonLoopback   = "non_loopback"
	hostErrPathTooLong   = "socket_path_too_long"
	hostErrBadPort       = "bad_port"
	hostErrRelativePath  = "relative_socket_path"
	hostErrBadSocketPath = "bad_socket_path"
	hostErrDuplicateKey  = "duplicate_key"
)

func hostErr(kind, format string, args ...any) error {
	return hostConfigError{Kind: kind, Msg: fmt.Sprintf(format, args...)}
}

// listenAddr is a parsed listener. Network is "tcp" or "unix"; Address is
// what net.Dial takes ("127.0.0.1:4000" or an absolute socket path).
type listenAddr struct {
	Network string
	Address string
}

func (l listenAddr) String() string { return l.Network + "://" + l.Address }

// parseListen accepts exactly tcp://127.0.0.1:PORT and unix://ABSOLUTE_PATH.
func parseListen(raw string) (listenAddr, error) {
	s := strings.TrimSpace(raw)
	switch {
	case strings.HasPrefix(s, "tcp://"):
		hostPort := strings.TrimPrefix(s, "tcp://")
		host, portText, ok := strings.Cut(hostPort, ":")
		if !ok || strings.Contains(portText, ":") {
			return listenAddr{}, hostErr(hostErrBadListen, "listen %q: want tcp://127.0.0.1:PORT", s)
		}
		if host != "127.0.0.1" {
			return listenAddr{}, hostErr(hostErrNonLoopback,
				"listen %q binds %q; only 127.0.0.1 is allowed (use a unix socket to be private from other local users)", s, host)
		}
		port, err := parsePort(portText)
		if err != nil {
			return listenAddr{}, hostErr(hostErrBadPort, "listen %q: %v", s, err)
		}
		return listenAddr{Network: "tcp", Address: "127.0.0.1:" + strconv.Itoa(port)}, nil
	case strings.HasPrefix(s, "unix://"):
		return unixListen(strings.TrimPrefix(s, "unix://"))
	}
	return listenAddr{}, hostErr(hostErrBadListen, "listen %q: want tcp://127.0.0.1:PORT or unix://ABSOLUTE_PATH", s)
}

// unixListen validates and cleans a socket path. A ".." segment or a
// trailing "/" is refused rather than cleaned away — both mean the operator
// named something other than a socket file — while "//" and "/./" collapse.
func unixListen(path string) (listenAddr, error) {
	if !filepath.IsAbs(path) {
		return listenAddr{}, hostErr(hostErrRelativePath, "socket path %q is not absolute", path)
	}
	if strings.HasSuffix(path, "/") {
		return listenAddr{}, hostErr(hostErrBadSocketPath, "socket path %q ends in '/'; it must name a file", path)
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == ".." {
			return listenAddr{}, hostErr(hostErrBadSocketPath, "socket path %q has a '..' segment", path)
		}
	}
	path = filepath.Clean(path)
	if n := len(path); n >= maxUnixSocketPath {
		return listenAddr{}, hostErr(hostErrPathTooLong,
			"socket path %q is %d bytes; it must be under %d (macOS truncates sun_path at 104)", path, n, maxUnixSocketPath)
	}
	return listenAddr{Network: "unix", Address: path}, nil
}

// parsePort reads a decimal port in 1..65535. strconv.Atoi alone would accept
// "+4000".
func parsePort(text string) (int, error) {
	if text == "" || strings.TrimLeft(text, "0123456789") != "" {
		return 0, fmt.Errorf("port %q is not a number", text)
	}
	port, err := strconv.Atoi(text)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("port %q out of range 1-65535", text)
	}
	return port, nil
}

// hostSettings is the resolved class and listener — and, as the output of
// `felt shuttle host --json`, the wire format the daemon validates against.
type hostSettings struct {
	ID           string `json:"id"`
	Class        string `json:"class"`
	ClassSource  string `json:"class_source"`
	Listen       string `json:"listen"`
	ListenSource string `json:"listen_source"`
	File         string `json:"file"`

	listen listenAddr
}

// hostClassFilePath is $FELT_HOST_FILE, else ~/.config/felt/host.json.
func hostClassFilePath() (string, error) {
	return feltConfigPath("FELT_HOST_FILE", "host.json")
}

// readHostFile returns the file's object with every key preserved (the class
// writer round-trips keys it does not know), or nil when the file is absent.
func readHostFile(path string) (map[string]json.RawMessage, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	// encoding/json would quietly turn invalid UTF-8 into U+FFFD, so the two
	// readers could disagree about what a string says.
	if !utf8.Valid(data) {
		return nil, hostErr(hostErrMalformed, "parsing %s: not valid UTF-8", path)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil || doc == nil {
		msg := "not a JSON object"
		if err != nil {
			msg = err.Error()
		}
		return nil, hostErr(hostErrMalformed, "parsing %s: %s", path, msg)
	}
	if key, dup := duplicateTopLevelKey(data); dup {
		return nil, hostErr(hostErrDuplicateKey, "parsing %s: key %q appears more than once", path, key)
	}
	return doc, nil
}

// duplicateTopLevelKey reports a key the top-level object repeats. JSON
// parsers disagree on which copy wins (Go keeps the last, others the first),
// so a repeated key means two readers of one file can resolve different
// classes; it is refused instead. data is known to be a valid object.
func duplicateTopLevelKey(data []byte) (string, bool) {
	dec := json.NewDecoder(bytes.NewReader(data))
	if _, err := dec.Token(); err != nil { // {
		return "", false
	}
	seen := map[string]bool{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return "", false
		}
		key, _ := tok.(string)
		if seen[key] {
			return key, true
		}
		seen[key] = true
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return "", false
		}
	}
	return "", false
}

// stringKey reads an optional string key; present-but-not-a-string is
// malformed rather than ignored.
func stringKey(doc map[string]json.RawMessage, key, path string) (string, bool, error) {
	raw, ok := doc[key]
	if !ok {
		return "", false, nil
	}
	var s string
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false, hostErr(hostErrMalformed, "%s: %q is null; omit the key instead", path, key)
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false, hostErr(hostErrMalformed, "%s: %q must be a string", path, key)
	}
	return s, true, nil
}

// resolveHostSettings resolves class and listener from the environment and
// the host file. It does not resolve the host id; the verb adds that.
func resolveHostSettings() (hostSettings, error) {
	path, err := hostClassFilePath()
	if err != nil {
		return hostSettings{}, err
	}
	s := hostSettings{File: path, Class: string(hostClassSingleUser), ClassSource: hostSourceDefault}

	doc, err := readHostFile(path)
	if err != nil {
		return hostSettings{}, err
	}
	class, hasClass, err := stringKey(doc, "class", path)
	if err != nil {
		return hostSettings{}, err
	}
	if hasClass {
		if !hostClass(class).valid() {
			return hostSettings{}, hostErr(hostErrBadClass, "%s: class %q is not one of %s", path, class, hostClassList())
		}
		s.Class, s.ClassSource = class, hostSourceHostFile
	}
	fileListen, hasListen, err := stringKey(doc, "listen", path)
	if err != nil {
		return hostSettings{}, err
	}

	var listen listenAddr
	switch {
	case strings.TrimSpace(os.Getenv("SHUTTLE_LISTEN")) != "":
		listen, err = parseListen(os.Getenv("SHUTTLE_LISTEN"))
		if err != nil {
			return hostSettings{}, fmt.Errorf("$SHUTTLE_LISTEN: %w", err)
		}
		s.ListenSource = hostSourceListenEnv
	case hasListen && strings.TrimSpace(fileListen) != "":
		listen, err = parseListen(fileListen)
		if err != nil {
			return hostSettings{}, fmt.Errorf("%s: %w", path, err)
		}
		s.ListenSource = hostSourceHostFile
	default:
		listen, err = classDefaultListen(hostClass(s.Class))
		if err != nil {
			return hostSettings{}, err
		}
		s.ListenSource = hostSourceClassDefault
	}
	s.listen, s.Listen = listen, listen.String()
	return s, nil
}

// classDefaultListen is the listener a class gets when nothing overrides it.
func classDefaultListen(class hostClass) (listenAddr, error) {
	if class.usesSocket() {
		dir, err := shuttleDataDir()
		if err != nil {
			return listenAddr{}, err
		}
		// Concatenated, not joined: Join would clean a ".." in the data dir
		// away before unixListen could refuse it.
		l, err := unixListen(dir + "/sock/daemon.sock")
		if err != nil {
			return listenAddr{}, fmt.Errorf("%w; set SHUTTLE_LISTEN or host.json \"listen\" to a shorter unix:// path", err)
		}
		return l, nil
	}
	port := defaultDaemonPort
	if v := strings.TrimSpace(os.Getenv("SHUTTLE_PORT")); v != "" {
		p, err := parsePort(v)
		if err != nil {
			return listenAddr{}, hostErr(hostErrBadPort, "$SHUTTLE_PORT: %v", err)
		}
		port = p
	}
	return listenAddr{Network: "tcp", Address: "127.0.0.1:" + strconv.Itoa(port)}, nil
}

// shuttleDataDir is $SHUTTLE_DATA_DIR, else ~/.shuttle. Only a leading "~"
// is expanded: the value is neither cleaned nor made absolute against the
// working directory, so the socket-path checks see what the operator wrote,
// exactly as the daemon does.
func shuttleDataDir() (string, error) {
	if v := strings.TrimSpace(os.Getenv("SHUTTLE_DATA_DIR")); v != "" {
		if v != "~" && !strings.HasPrefix(v, "~/") {
			return v, nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving home directory: %w", err)
		}
		return home + v[1:], nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".shuttle"), nil
}

func hostClassList() string {
	names := make([]string, len(hostClasses))
	for i, c := range hostClasses {
		names[i] = string(c)
	}
	return strings.Join(names, ", ")
}

// writeHostClass sets "class" in the host file, keeping every other key. A
// malformed file is refused rather than overwritten: it may hold a listener
// someone chose on purpose. The write is atomic and 0600.
func writeHostClass(class hostClass) (string, error) {
	if !class.valid() {
		return "", hostErr(hostErrBadClass, "class %q is not one of %s", class, hostClassList())
	}
	path, err := hostClassFilePath()
	if err != nil {
		return "", err
	}
	doc, err := readHostFile(path)
	if err != nil {
		return "", err
	}
	if doc == nil {
		doc = map[string]json.RawMessage{}
	}
	doc["class"], _ = json.Marshal(string(class))
	payload, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", err
	}
	payload = append(payload, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".host.json-*")
	if err != nil {
		return "", fmt.Errorf("write %s: %w", path, err)
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", fmt.Errorf("protect %s: %w", tmp.Name(), err)
	}
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return "", fmt.Errorf("write %s: %w", tmp.Name(), err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("write %s: %w", tmp.Name(), err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", fmt.Errorf("rename into %s: %w", path, err)
	}
	return path, nil
}

// ── CLI ──

var shuttleHostCmd = &cobra.Command{
	Use:   "host",
	Short: "Show this host's identity, class, and daemon listener",
	Long: `Report the host id the daemon dispatches as, the host class, and the
listener the daemon binds and the CLI dials.

The class says who else can reach this machine:
  single-user          nobody else logs in; the daemon listens on 127.0.0.1
  shared-multi-user    other users log in; the daemon listens on a unix socket
  exposed              reachable from outside; the daemon listens on a unix socket

--json prints {id, class, class_source, listen, listen_source, file} and is the
validator the daemon shells: a malformed host file fails here, naming its path.

Examples:
  felt shuttle host
  felt shuttle host --json
  felt shuttle host class shared-multi-user`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		s, err := resolveHostSettings()
		if err != nil {
			return err
		}
		id, source, err := resolveOwnHostSourced("")
		if err != nil {
			return err
		}
		s.ID = id
		if jsonOutput {
			return outputJSON(s)
		}
		fmt.Printf("id      %s (%s)\n", s.ID, source.describe())
		fmt.Printf("class   %s (%s)\n", s.Class, describeHostSource(s.ClassSource, s.File))
		fmt.Printf("listen  %s (%s)\n", s.Listen, describeHostSource(s.ListenSource, s.File))
		return nil
	},
}

var shuttleHostClassCmd = &cobra.Command{
	Use:       "class <single-user|shared-multi-user|exposed>",
	Short:     "Declare this host's class in the host file",
	Args:      cobra.ExactArgs(1),
	ValidArgs: []string{string(hostClassSingleUser), string(hostClassShared), string(hostClassExposed)},
	RunE: func(cmd *cobra.Command, args []string) error {
		path, err := writeHostClass(hostClass(args[0]))
		if err != nil {
			return err
		}
		s, err := resolveHostSettings()
		if err != nil {
			return err
		}
		fmt.Printf("class %s saved to %s; the daemon listens on %s after its next restart\n", s.Class, path, s.Listen)
		return nil
	},
}

func describeHostSource(source, file string) string {
	switch source {
	case hostSourceHostFile:
		return file
	case hostSourceListenEnv:
		return "$SHUTTLE_LISTEN"
	case hostSourceClassDefault:
		return "class default"
	}
	return "default; no class in " + file
}

// isHostConfigError reports whether err is a host-file refusal of the given
// kind, through any wrapping.
func isHostConfigError(err error, kind string) bool {
	var hc hostConfigError
	return errors.As(err, &hc) && hc.Kind == kind
}

func init() {
	shuttleHostCmd.AddCommand(shuttleHostClassCmd)
	shuttleCmd.AddCommand(shuttleHostCmd)
}
