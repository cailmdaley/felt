package shuttlecli

import (
	"errors"
	"fmt"
)

// terminalBackend observes and closes terminals; only the daemon launches them.
type terminalBackend interface {
	ID() string
	Has(name string) (bool, error)
	Kill(name string) error
	LiveWorkers() (map[string]bool, error)
}

type terminalRef struct {
	Backend, Name, NativeSession, NativePane string
}

func (a *app) terminalBackends() ([]terminalBackend, error) {
	if a.terminals != nil {
		return a.terminals, nil
	}
	primary, err := a.hostTerminal()
	if err != nil {
		var configErr hostConfigError
		if errors.As(err, &configErr) && configErr.Kind == "bad_terminal" {
			return nil, err
		}
		fmt.Fprintf(a.env.Stderr, "warning: cannot read terminal backend: %v; observing tmux only\n", err)
		primary = "tmux"
	}
	backends := []terminalBackend{}
	if primary == "rex" {
		backends = append(backends, &rexTerminal{a: a})
	}
	if _, err := a.env.LookPath("tmux"); err == nil {
		backends = append(backends, &tmuxTerminal{a: a})
	}
	a.terminals = backends
	return backends, nil
}

func (a *app) terminalHolder(name string) (terminalBackend, error) {
	backends, err := a.terminalBackends()
	if err != nil {
		return nil, err
	}
	var uncertain error
	for _, backend := range backends {
		present, err := backend.Has(name)
		if present {
			return backend, nil
		}
		if err != nil {
			uncertain = err
		}
	}
	return nil, uncertain
}

func (a *app) terminalSessionExists(name string) (bool, error) {
	holder, err := a.terminalHolder(name)
	return holder != nil, err
}

func (a *app) killTerminalSession(name string) error {
	holder, err := a.terminalHolder(name)
	if err != nil {
		return err
	}
	if holder == nil {
		return fmt.Errorf("no live terminal %q", name)
	}
	return holder.Kill(name)
}

func (a *app) liveTerminalSessions() (map[string]bool, error) {
	live := map[string]bool{}
	backends, err := a.terminalBackends()
	if err != nil {
		return nil, err
	}
	var failures []error
	for _, backend := range backends {
		names, err := backend.LiveWorkers()
		if err != nil {
			failures = append(failures, fmt.Errorf("%s listing: %w", backend.ID(), err))
		}
		for name, present := range names {
			if present {
				live[name] = true
			}
		}
	}
	return live, errors.Join(failures...)
}

// currentTerminalPane reads exact native coordinates without a backend probe.
func (a *app) currentTerminalPane() string {
	if a.env.Getenv("TMUX") != "" {
		return a.env.Getenv("TMUX_PANE")
	}
	if validRexRef(a.env.Getenv("REX_SESSION"), a.env.Getenv("REX_BLOCK")) {
		return a.env.Getenv("REX_BLOCK")
	}
	return ""
}

// currentTerminal uses the live pane before inherited Rex context. A tmux
// server forked from a Rex block can pass its REX_* variables to every pane.
// Rex lookup reads the binding index only, so hooks never need a Rex process.
func (a *app) currentTerminal() (terminalRef, error) {
	if a.env.Getenv("TMUX") != "" {
		name, err := a.tmuxCurrentSession()
		return terminalRef{Backend: "tmux", Name: name, NativeSession: name, NativePane: a.env.Getenv("TMUX_PANE")}, err
	}
	sid, bid := a.env.Getenv("REX_SESSION"), a.env.Getenv("REX_BLOCK")
	if sid == "" || bid == "" {
		return terminalRef{}, fmt.Errorf("this terminal is outside tmux and Rex")
	}
	ref := terminalRef{Backend: "rex", NativeSession: sid, NativePane: bid}
	if !validRexRef(sid, bid) {
		return ref, fmt.Errorf("invalid Rex session or block reference")
	}
	doc, err := (&rexTerminal{a: a}).bindings()
	if err != nil {
		return ref, err
	}
	for name, binding := range doc.Bindings {
		if binding.SessionID == sid && binding.BlockID == bid {
			if ref.Name != "" {
				ref.Name = ""
				return ref, fmt.Errorf("ambiguous Rex terminal binding")
			}
			ref.Name = name
		}
	}
	return ref, nil
}
