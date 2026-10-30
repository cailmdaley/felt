package shuttlecli

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/sysenv"
)

// A durable process identity survives exec; an inherited flock descriptor need
// not survive the release shell and Erlang runtime. The short flock serializes
// claim replacement, while PID + process birth identifies the live owner.
// Claims are host- and endpoint-specific because HOME can be shared over NFS.
// Like the daemon's foreground release, this guard supports Darwin and Linux.
type daemonOwner struct {
	PID        int    `json:"pid"`
	Birth      string `json:"birth"`
	Supervisor string `json:"supervisor,omitempty"`
	OS         string `json:"os,omitempty"`
}

func processBirth(env *sysenv.Env, pid int) (string, error) {
	// Linux start ticks disambiguate PID reuse without locale or timestamp rounding.
	if data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil {
		if end := strings.LastIndexByte(string(data), ')'); end >= 0 {
			fields := strings.Fields(string(data)[end+1:])
			if len(fields) > 19 {
				boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
				if err == nil {
					return strings.TrimSpace(string(boot)) + ":ticks:" + fields[19], nil
				}
			}
		}
	}
	cmd := env.Command("ps", "-p", fmt.Sprint(pid), "-o", "lstart=")
	cmd.Env = append(env.Environ(), "LC_ALL=C", "TZ=UTC")
	out, err := cmd.Output()
	birth := strings.TrimSpace(string(out))
	if err != nil || birth == "" {
		return "", fmt.Errorf("process %d birth unavailable", pid)
	}
	return birth, nil
}

// claimDaemonOwner rejects live starts/installers even before a listener exists.
// replacePID is nonzero only for a verified target supervisor holding the live
// listener. All launch paths must use `shuttle daemon start` to participate.
func (a *app) claimDaemonOwner(settings hostSettings, replacePID int, installing *supervisorOptions) (func(), error) {
	path, err := a.daemonOwnerPath(settings)
	if err != nil {
		return nil, err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, fmt.Errorf("another daemon ownership operation is in progress: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if len(data) > 0 {
		var owner daemonOwner
		if err := json.Unmarshal(data, &owner); err != nil {
			return nil, fmt.Errorf("invalid daemon ownership claim %s: %w", path, err)
		}
		if owner.PID <= 0 || owner.Birth == "" {
			return nil, fmt.Errorf("incomplete daemon ownership claim %s", path)
		}
		if owner.PID > 0 {
			birth, err := processBirth(a.env, owner.PID)
			if err != nil && syscall.Kill(owner.PID, 0) != syscall.ESRCH {
				return nil, fmt.Errorf("cannot verify daemon owner process %d: %w", owner.PID, err)
			}
			if err == nil && birth == owner.Birth && owner.PID != replacePID {
				// Only the target manager's actual new main process can take the
				// installer's claim. This works before the child has bound its listener.
				handoff := installing == nil && owner.Supervisor != "" && a.supervisorMainPID(supervisorOptions{OS: owner.OS, Label: owner.Supervisor}) == os.Getpid()
				if !handoff {
					return nil, fmt.Errorf("daemon endpoint already claimed by live process %d (start or install in progress)", owner.PID)
				}
			}
		}
	}
	birth, err := processBirth(a.env, os.Getpid())
	if err != nil {
		return nil, err
	}
	owner := daemonOwner{PID: os.Getpid(), Birth: birth}
	if installing != nil {
		owner.Supervisor, owner.OS = installing.Label, installing.OS
	}
	data, _ = json.Marshal(owner)
	// Keep the previous complete record if a writer dies during publication.
	// The stable sidecar, not the replaceable record inode, owns the flock.
	tmp, err := os.CreateTemp(dir, ".owner-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		return nil, writeErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return nil, err
	}
	return func() {
		// On exec this closure never runs: the claim follows the unchanged PID.
		// On a returned start or completed install, remove only our own claim.
		file, err := os.OpenFile(path+".lock", os.O_RDWR, 0600)
		if err != nil {
			return
		}
		defer file.Close()
		if syscall.Flock(int(file.Fd()), syscall.LOCK_EX) != nil {
			return
		}
		defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		current, err := os.ReadFile(path)
		if err == nil && string(current) == string(data) {
			_ = os.Remove(path)
		}
	}, nil
}

func (a *app) daemonOwnerPath(settings hostSettings) (string, error) {
	home, err := a.env.UserHomeDir()
	if err != nil {
		return "", err
	}
	host, err := a.env.Hostname()
	if err != nil {
		return "", err
	}
	key := fmt.Sprintf("%x", sha256.Sum256([]byte(host+"\x00"+settings.listen.Network+"\x00"+settings.listen.Address)))
	return filepath.Join(home, ".shuttle", "daemon-owners", key+".json"), nil
}

func (a *app) isLiveDaemonChild() bool {
	settings, err := a.resolveHostSettings()
	if err != nil {
		return false
	}
	path, err := a.daemonOwnerPath(settings)
	if err != nil {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var owner daemonOwner
	if json.Unmarshal(data, &owner) != nil || owner.PID <= 0 || owner.Birth == "" {
		return false
	}
	birth, err := processBirth(a.env, owner.PID)
	if err != nil || birth != owner.Birth {
		return false
	}

	current := os.Getpid()
	for range 4 {
		parent, _, ok := messaging.ProcessParent(current)
		if !ok || parent <= 0 {
			return false
		}
		if parent == owner.PID {
			return true
		}
		current = parent
	}
	return false
}

// A manager may return from load/restart before its child begins executing.
// Keep the installer's reservation until the verified child takes it over.
func (a *app) awaitDaemonOwnerHandoff(settings hostSettings, options supervisorOptions, timeout time.Duration) error {
	path, err := a.daemonOwnerPath(settings)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		var owner daemonOwner
		if err == nil && json.Unmarshal(data, &owner) == nil && owner.PID > 0 && owner.PID != os.Getpid() && owner.Supervisor == "" {
			if birth, err := processBirth(a.env, owner.PID); err == nil && birth == owner.Birth && a.supervisorMainPID(options) == owner.PID {
				return nil
			}
		}
		a.daemonPause(50 * time.Millisecond)
	}
	var stopErr, managerErr error
	if options.OS == "Linux" {
		stopErr = a.env.Command("systemctl", "--user", "stop", systemdUnitName(options.Label)).Run()
		managerErr = a.env.Command("systemctl", "--user", "show-environment").Run()
	} else {
		stopErr = a.env.Command("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), options.Label)).Run()
		managerErr = a.env.Command("launchctl", "print", fmt.Sprintf("gui/%d", os.Getuid())).Run()
	}
	if stopErr != nil || managerErr != nil || a.supervisorMainPID(options) != 0 {
		return fmt.Errorf("daemon ownership handoff timed out; pending service could not be confirmed stopped (stop: %v; manager: %v); resolve its ownership before retrying", stopErr, managerErr)
	}
	return errors.New("daemon ownership handoff timed out; pending service stopped; inspect the service log")
}
