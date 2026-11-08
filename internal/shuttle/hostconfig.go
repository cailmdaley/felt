package shuttle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/cailmdaley/felt/internal/sysenv"
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
// ResolveHostConfig is the one Go reader of host.json: the shuttle CLI and
// the messaging transports dial the daemon where it says. The daemon resolves
// the same class and listener from the same file (daemon/lib/shuttle/host.ex),
// and daemon/test/fixtures/host/ holds cases both readers must reproduce.
//
// Resolution:
//
//	file   $SHUTTLE_HOST_CONFIG_FILE, else ~/.config/shuttle/host.json
//	class  host.json "class", else single-user (missing file or key)
//	listen $SHUTTLE_LISTEN → host.json "listen" → the class default:
//	       single-user            tcp://127.0.0.1:<$SHUTTLE_PORT or 4000>
//	       shared-multi-user,
//	       exposed                unix://<$SHUTTLE_DATA_DIR or ~/.shuttle>/sock/daemon.sock
//
// Accepted listeners are tcp://127.0.0.1:PORT and unix://ABSOLUTE_PATH. A
// declared listener that binds anything but loopback is refused rather than
// honoured: the class exists to keep the daemon off the network.

type HostClass string

const (
	HostClassSingleUser HostClass = "single-user"
	HostClassShared     HostClass = "shared-multi-user"
	HostClassExposed    HostClass = "exposed"
)

// HostClasses lists every class, in the order help text names them.
var HostClasses = []HostClass{HostClassSingleUser, HostClassShared, HostClassExposed}

func (c HostClass) Valid() bool {
	for _, known := range HostClasses {
		if c == known {
			return true
		}
	}
	return false
}

// UsesSocket reports whether the class's listener must be a unix socket.
func (c HostClass) UsesSocket() bool { return c == HostClassShared || c == HostClassExposed }

// HostClassList names every class, comma-separated, for messages.
func HostClassList() string {
	names := make([]string, len(HostClasses))
	for i, c := range HostClasses {
		names[i] = string(c)
	}
	return strings.Join(names, ", ")
}

const (
	DefaultDaemonPort = 4000

	// maxUnixSocketPath bounds a socket path's byte length. macOS caps
	// sun_path at 104 bytes including the terminating NUL (Linux at 108), and
	// the kernel truncates silently rather than failing the bind, so the
	// daemon would listen somewhere nobody dials. 100 leaves headroom on both.
	maxUnixSocketPath = 100
)

// Sources name the tier that answered, so a report can point at the thing
// that decided the value rather than a file sitting under an override.
const (
	HostSourceDefault      = "default"
	HostSourceHostFile     = "file"
	HostSourceListenEnv    = "SHUTTLE_LISTEN"
	HostSourceClassDefault = "class-default"
)

// HostConfigError is a refusal with a stable kind. The kind is what the
// parity fixtures assert, because the two languages word their messages
// differently and a message is not a contract.
type HostConfigError struct {
	Kind string
	Msg  string
}

func (e HostConfigError) Error() string { return e.Msg }

const (
	HostErrMalformed     = "malformed"
	HostErrBadClass      = "bad_class"
	HostErrBadListen     = "bad_listen"
	HostErrNonLoopback   = "non_loopback"
	HostErrPathTooLong   = "socket_path_too_long"
	HostErrBadPort       = "bad_port"
	HostErrRelativePath  = "relative_socket_path"
	HostErrBadSocketPath = "bad_socket_path"
	HostErrDuplicateKey  = "duplicate_key"
	HostErrBadTerminal   = "bad_terminal"
)

// HostErr is a HostConfigError of kind with a formatted message.
func HostErr(kind, format string, args ...any) error {
	return HostConfigError{Kind: kind, Msg: fmt.Sprintf(format, args...)}
}

// Listener is a parsed listener. Network is "tcp" or "unix"; Address is
// what net.Dial takes ("127.0.0.1:4000" or an absolute socket path).
type Listener struct {
	Network string
	Address string
}

func (l Listener) String() string { return l.Network + "://" + l.Address }

// DaemonSocketHost is the synthetic host a unix listener's base URL names.
// Clients concatenate paths onto the base URL, so it keeps the http:// shape;
// their dialer recognizes this host and dials the socket instead of DNS. It is
// under .invalid (RFC 2606), which never resolves, so no real remote can share
// the name.
const DaemonSocketHost = "shuttle.invalid"

// BaseURL is the HTTP base a client of the daemon on l uses:
// http://127.0.0.1:PORT, or http://shuttle.invalid dialed through the socket.
func (l Listener) BaseURL() string {
	if l.Network == "unix" {
		return "http://" + DaemonSocketHost
	}
	return "http://" + l.Address
}

// ParseListen accepts exactly tcp://127.0.0.1:PORT and unix://ABSOLUTE_PATH.
func ParseListen(raw string) (Listener, error) {
	s := strings.TrimSpace(raw)
	switch {
	case strings.HasPrefix(s, "tcp://"):
		hostPort := strings.TrimPrefix(s, "tcp://")
		host, portText, ok := strings.Cut(hostPort, ":")
		if !ok || strings.Contains(portText, ":") {
			return Listener{}, HostErr(HostErrBadListen, "listen %q: want tcp://127.0.0.1:PORT", s)
		}
		if host != "127.0.0.1" {
			return Listener{}, HostErr(HostErrNonLoopback,
				"listen %q binds %q; only 127.0.0.1 is allowed (use a unix socket to be private from other local users)", s, host)
		}
		port, err := ParsePort(portText)
		if err != nil {
			return Listener{}, HostErr(HostErrBadPort, "listen %q: %v", s, err)
		}
		return Listener{Network: "tcp", Address: "127.0.0.1:" + strconv.Itoa(port)}, nil
	case strings.HasPrefix(s, "unix://"):
		return unixListen(strings.TrimPrefix(s, "unix://"))
	}
	return Listener{}, HostErr(HostErrBadListen, "listen %q: want tcp://127.0.0.1:PORT or unix://ABSOLUTE_PATH", s)
}

// unixListen validates and cleans a socket path. A ".." segment or a
// trailing "/" is refused rather than cleaned away — both mean the operator
// named something other than a socket file — while "//" and "/./" collapse.
func unixListen(path string) (Listener, error) {
	if !filepath.IsAbs(path) {
		return Listener{}, HostErr(HostErrRelativePath, "socket path %q is not absolute", path)
	}
	if strings.HasSuffix(path, "/") {
		return Listener{}, HostErr(HostErrBadSocketPath, "socket path %q ends in '/'; it must name a file", path)
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == ".." {
			return Listener{}, HostErr(HostErrBadSocketPath, "socket path %q has a '..' segment", path)
		}
	}
	path = filepath.Clean(path)
	if n := len(path); n >= maxUnixSocketPath {
		return Listener{}, HostErr(HostErrPathTooLong,
			"socket path %q is %d bytes; it must be under %d (macOS truncates sun_path at 104)", path, n, maxUnixSocketPath)
	}
	return Listener{Network: "unix", Address: path}, nil
}

// ParsePort reads a decimal port in 1..65535. strconv.Atoi alone would accept
// "+4000" and "-0"; a port is digits. Leading zeros parse as the integer they
// denote.
func ParsePort(text string) (int, error) {
	if text == "" || strings.TrimLeft(text, "0123456789") != "" {
		return 0, fmt.Errorf("port %q is not a number", text)
	}
	port, err := strconv.Atoi(text)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("port %q out of range 1-65535", text)
	}
	return port, nil
}

// HostConfig is the resolved class, terminal and listener.
type HostConfig struct {
	Class        HostClass
	ClassSource  string
	Terminal     string
	Listen       Listener
	ListenSource string
	// File is the host file the configuration was read from (it may not exist).
	File string
	// DataDir is DataDir(env), or "" when it cannot be resolved.
	DataDir string
}

// HostConfigFile is $SHUTTLE_HOST_CONFIG_FILE, else ~/.config/shuttle/host.json.
func HostConfigFile(env *sysenv.Env) (string, error) {
	return ConfigPath(env, "SHUTTLE_HOST_CONFIG_FILE", "host.json")
}

// ConfigPath is one Shuttle operator file: $<envVar> (a leading ~ expanded,
// made absolute), else ~/.config/shuttle/<leaf>.
func ConfigPath(env *sysenv.Env, envVar, leaf string) (string, error) {
	if v := env.Getenv(envVar); v != "" {
		return ExpandUserPath(env, v)
	}
	home, err := env.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".config", "shuttle", leaf), nil
}

// ExpandUserPath expands a leading ~ and returns a cleaned absolute path.
func ExpandUserPath(env *sysenv.Env, path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("empty path")
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := env.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving home directory: %w", err)
		}
		if path == "~" {
			path = home
		} else {
			path = filepath.Join(home, path[2:])
		}
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	abs, err := env.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

// ReadHostFile returns the file's object with every key preserved (the class
// writer round-trips keys it does not know), or nil when the file is absent.
func ReadHostFile(path string) (map[string]json.RawMessage, error) {
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
		return nil, HostErr(HostErrMalformed, "parsing %s: not valid UTF-8", path)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil || doc == nil {
		msg := "not a JSON object"
		if err != nil {
			msg = err.Error()
		}
		return nil, HostErr(HostErrMalformed, "parsing %s: %s", path, msg)
	}
	if key, dup := duplicateTopLevelKey(data); dup {
		return nil, HostErr(HostErrDuplicateKey, "parsing %s: key %q appears more than once", path, key)
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
		return "", false, HostErr(HostErrMalformed, "%s: %q is null; omit the key instead", path, key)
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false, HostErr(HostErrMalformed, "%s: %q must be a string", path, key)
	}
	return s, true, nil
}

func hostTerminal(doc map[string]json.RawMessage, path string) (string, error) {
	raw, ok := doc["terminal"]
	if !ok {
		return "tmux", nil
	}
	var value string
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil || (value != "tmux" && value != "rex") {
		return "", HostErr(HostErrBadTerminal, "%s: invalid terminal %s", path, raw)
	}
	return value, nil
}

// HostTerminal is the host file's terminal backend ("tmux" when unset), read
// without resolving the listener.
func HostTerminal(env *sysenv.Env) (string, error) {
	path, err := HostConfigFile(env)
	if err != nil {
		return "", err
	}
	doc, err := ReadHostFile(path)
	if err != nil {
		return "", err
	}
	return hostTerminal(doc, path)
}

// ResolveHostConfig resolves class, terminal and listener from the
// environment and the host file.
func ResolveHostConfig(env *sysenv.Env) (HostConfig, error) {
	path, err := HostConfigFile(env)
	if err != nil {
		return HostConfig{}, err
	}
	c := HostConfig{File: path, Class: HostClassSingleUser, ClassSource: HostSourceDefault}
	if dir, err := DataDir(env); err == nil {
		c.DataDir = dir
	}

	doc, err := ReadHostFile(path)
	if err != nil {
		return HostConfig{}, err
	}
	c.Terminal, err = hostTerminal(doc, path)
	if err != nil {
		return HostConfig{}, err
	}
	class, hasClass, err := stringKey(doc, "class", path)
	if err != nil {
		return HostConfig{}, err
	}
	if hasClass {
		if !HostClass(class).Valid() {
			return HostConfig{}, HostErr(HostErrBadClass, "%s: class %q is not one of %s", path, class, HostClassList())
		}
		c.Class, c.ClassSource = HostClass(class), HostSourceHostFile
	}
	fileListen, hasListen, err := stringKey(doc, "listen", path)
	if err != nil {
		return HostConfig{}, err
	}

	switch {
	case strings.TrimSpace(env.Getenv("SHUTTLE_LISTEN")) != "":
		c.Listen, err = ParseListen(env.Getenv("SHUTTLE_LISTEN"))
		if err != nil {
			return HostConfig{}, fmt.Errorf("$SHUTTLE_LISTEN: %w", err)
		}
		c.ListenSource = HostSourceListenEnv
	case hasListen && strings.TrimSpace(fileListen) != "":
		c.Listen, err = ParseListen(fileListen)
		if err != nil {
			return HostConfig{}, fmt.Errorf("%s: %w", path, err)
		}
		c.ListenSource = HostSourceHostFile
	default:
		c.Listen, err = classDefaultListen(env, c.Class)
		if err != nil {
			return HostConfig{}, err
		}
		c.ListenSource = HostSourceClassDefault
	}
	return c, nil
}

// classDefaultListen is the listener a class gets when nothing overrides it.
func classDefaultListen(env *sysenv.Env, class HostClass) (Listener, error) {
	if class.UsesSocket() {
		dir, err := DataDir(env)
		if err != nil {
			return Listener{}, err
		}
		// Concatenated, not joined: Join would clean a ".." in the data dir
		// away before unixListen could refuse it.
		l, err := unixListen(dir + "/sock/daemon.sock")
		if err != nil {
			return Listener{}, fmt.Errorf("%w; set SHUTTLE_LISTEN or host.json \"listen\" to a shorter unix:// path", err)
		}
		return l, nil
	}
	port := DefaultDaemonPort
	if v := strings.TrimSpace(env.Getenv("SHUTTLE_PORT")); v != "" {
		p, err := ParsePort(v)
		if err != nil {
			return Listener{}, HostErr(HostErrBadPort, "$SHUTTLE_PORT: %v", err)
		}
		port = p
	}
	return Listener{Network: "tcp", Address: "127.0.0.1:" + strconv.Itoa(port)}, nil
}
