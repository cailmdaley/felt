// Package sysenv is the slice of the operating system a command reads:
// environment variables, the home and working directories, executable
// lookup, child processes, and the standard streams.
//
// The felt and shuttle command trees read all of these through an *Env
// handed down from their entry point instead of from package os. The binaries
// build it from the live process with OS; a test builds an isolated one with
// New, so many command invocations can run side by side in one test process
// without sharing PATH, HOME, the working directory or stdout.
//
// The package depends on nothing in this module, so both the felt and the
// shuttle sides may import it.
package sysenv

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Env is one command's view of the process it runs in. The zero value is not
// usable; build one with OS or New.
type Env struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer

	// live reads and executes through the real process; otherwise vars and
	// dir are the whole environment.
	live bool

	mu   sync.RWMutex
	vars map[string]string
	dir  string
}

// OS is the live process: every read goes to package os at the time it is
// made, and child processes inherit the process environment and directory
// exactly as exec.Command gives them.
func OS() *Env {
	return &Env{live: true, Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr}
}

// New is an isolated environment holding environ ("KEY=value" entries, as
// os.Environ returns them) and the working directory dir. Nothing it does
// reads or writes process-wide state: lookups search its own PATH, children
// get its variables and start in dir, and its streams default to an empty
// stdin and discarded output until the caller sets them.
func New(dir string, environ []string) *Env {
	vars := make(map[string]string, len(environ))
	for _, entry := range environ {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		vars[key] = value
	}
	return &Env{
		Stdin:  strings.NewReader(""),
		Stdout: io.Discard,
		Stderr: io.Discard,
		vars:   vars,
		dir:    dir,
	}
}

// Live reports whether e reads the real process.
func (e *Env) Live() bool { return e.live }

// Getenv is os.Getenv.
func (e *Env) Getenv(key string) string {
	value, _ := e.LookupEnv(key)
	return value
}

// LookupEnv is os.LookupEnv.
func (e *Env) LookupEnv(key string) (string, bool) {
	if e.live {
		return os.LookupEnv(key)
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	value, ok := e.vars[key]
	return value, ok
}

// Environ is os.Environ: the "KEY=value" entries a child process receives.
func (e *Env) Environ() []string {
	if e.live {
		return os.Environ()
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]string, 0, len(e.vars))
	for key, value := range e.vars {
		out = append(out, key+"="+value)
	}
	sort.Strings(out)
	return out
}

// Set assigns one variable of an isolated environment. The live process
// environment is never written through an Env.
func (e *Env) Set(key, value string) {
	e.mustIsolate("Set")
	e.mu.Lock()
	defer e.mu.Unlock()
	e.vars[key] = value
}

// Unset removes one variable of an isolated environment.
func (e *Env) Unset(key string) {
	e.mustIsolate("Unset")
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.vars, key)
}

// Chdir moves an isolated environment's working directory. A relative dir
// resolves against the current one.
func (e *Env) Chdir(dir string) {
	e.mustIsolate("Chdir")
	abs, err := e.Abs(dir)
	if err != nil {
		abs = dir
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.dir = abs
}

// Clone is an isolated copy of e, streams included, that later Set, Unset and
// Chdir calls on either side do not reach. Cloning the live process snapshots
// its variables and working directory.
func (e *Env) Clone() *Env {
	if e.live {
		dir, _ := os.Getwd()
		clone := New(dir, os.Environ())
		clone.Stdin, clone.Stdout, clone.Stderr = e.Stdin, e.Stdout, e.Stderr
		return clone
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	vars := make(map[string]string, len(e.vars))
	for key, value := range e.vars {
		vars[key] = value
	}
	return &Env{Stdin: e.Stdin, Stdout: e.Stdout, Stderr: e.Stderr, vars: vars, dir: e.dir}
}

func (e *Env) mustIsolate(op string) {
	if e.live {
		panic("sysenv: " + op + " on the live process environment")
	}
}

// UserHomeDir is os.UserHomeDir: $HOME, or an error when it is unset.
func (e *Env) UserHomeDir() (string, error) {
	if e.live {
		return os.UserHomeDir()
	}
	if home := e.Getenv("HOME"); home != "" {
		return home, nil
	}
	return "", errors.New("$HOME is not defined")
}

// Getwd is os.Getwd.
func (e *Env) Getwd() (string, error) {
	if e.live {
		return os.Getwd()
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.dir == "" {
		return "", errors.New("sysenv: no working directory")
	}
	return e.dir, nil
}

// Abs is filepath.Abs against e's working directory.
func (e *Env) Abs(path string) (string, error) {
	if e.live || filepath.IsAbs(path) {
		return filepath.Abs(path)
	}
	wd, err := e.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(wd, path), nil
}

// Resolve is path as package os must open it for e: a relative path joins e's
// working directory. The live process's working directory is already the one
// package os uses, so there path is returned unchanged.
func (e *Env) Resolve(path string) string {
	if e.live || path == "" || filepath.IsAbs(path) {
		return path
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	return filepath.Join(e.dir, path)
}

// LookPath is exec.LookPath against e's PATH. A relative name or PATH entry
// is probed from e's working directory, where Command starts the child, and
// the result keeps exec.LookPath's spelling and its ErrDot refusal.
func (e *Env) LookPath(file string) (string, error) {
	if e.live {
		return exec.LookPath(file)
	}
	if strings.Contains(file, string(filepath.Separator)) {
		if err := findExecutable(e.Resolve(file)); err != nil {
			return "", &exec.Error{Name: file, Err: err}
		}
		return file, nil
	}
	for _, dir := range filepath.SplitList(e.Getenv("PATH")) {
		if dir == "" {
			dir = "."
		}
		path := filepath.Join(dir, file)
		if findExecutable(e.Resolve(path)) == nil {
			if !filepath.IsAbs(path) {
				return path, &exec.Error{Name: file, Err: exec.ErrDot}
			}
			return path, nil
		}
	}
	return "", &exec.Error{Name: file, Err: exec.ErrNotFound}
}

func findExecutable(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if mode := info.Mode(); !mode.IsDir() && mode&0o111 != 0 {
		return nil
	}
	return fs.ErrPermission
}

// Command is exec.Command run inside e: the name resolves against e's PATH,
// and the child receives e's variables and starts in e's working directory
// unless the caller sets Env or Dir itself.
func (e *Env) Command(name string, args ...string) *exec.Cmd {
	return e.adopt(exec.Command(name, args...), name)
}

// CommandContext is exec.CommandContext run inside e, as Command.
func (e *Env) CommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return e.adopt(exec.CommandContext(ctx, name, args...), name)
}

func (e *Env) adopt(cmd *exec.Cmd, name string) *exec.Cmd {
	if e.live {
		return cmd
	}
	if !strings.Contains(name, string(filepath.Separator)) {
		path, err := e.LookPath(name)
		cmd.Path, cmd.Err = path, err
		if err != nil && path == "" {
			cmd.Path = name
		}
	}
	cmd.Env = e.Environ()
	e.mu.RLock()
	cmd.Dir = e.dir
	e.mu.RUnlock()
	return cmd
}
