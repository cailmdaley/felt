package shuttlecli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
)

type rexTerminal struct{ a *app }

type rexBinding struct {
	SessionID string `json:"session_id"`
	BlockID   string `json:"block_id"`
	CreatedAt string `json:"created_at"`
}

type rexBindingIndex struct {
	Version  int                   `json:"version"`
	Server   *string               `json:"server"`
	Bindings map[string]rexBinding `json:"bindings"`
}

type rexSession struct {
	SessionID string `json:"session_id"`
	Label     string `json:"label"`
}

func (*rexTerminal) ID() string { return "rex" }

func validRexRef(sid, bid string) bool {
	return strings.HasPrefix(sid, "session:") && len(sid) > len("session:") && strings.HasPrefix(bid, "block:") && len(bid) > len("block:")
}

// bindings is read-only. The daemon owns both the file and recovery by label.
func (r *rexTerminal) bindings() (rexBindingIndex, error) {
	empty := rexBindingIndex{Version: 1, Bindings: map[string]rexBinding{}}
	dir, err := shuttle.DataDir(r.a.env)
	if err != nil {
		return empty, err
	}
	path := filepath.Join(dir, "terminals", "rex.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return empty, err
	}
	var doc rexBindingIndex
	if err := json.Unmarshal(data, &doc); err != nil {
		return empty, fmt.Errorf("%s: %w", path, err)
	}
	if doc.Version != 1 || doc.Bindings == nil {
		return empty, fmt.Errorf("%s: invalid Rex binding index", path)
	}
	for _, binding := range doc.Bindings {
		if !validRexRef(binding.SessionID, binding.BlockID) || binding.CreatedAt == "" {
			return empty, fmt.Errorf("%s: invalid Rex binding", path)
		}
	}
	return doc, nil
}

func (a *app) rexBin() (string, error) {
	if bin := a.env.Getenv("SHUTTLE_REX_BIN"); bin != "" {
		return bin, nil
	}
	if bin, err := a.env.LookPath("rex"); err == nil {
		return bin, nil
	}
	home, err := a.env.UserHomeDir()
	if err != nil {
		return "", err
	}
	return a.env.LookPath(filepath.Join(home, "Library", "Application Support", "com.superlogical.rex", "RexServer", "Versions", "Current", "Rex Server.app", "Contents", "MacOS", "rex"))
}

var errRexAbsent = errors.New("Rex server absent")
var errRexNotFound = errors.New("Rex target not found")

func (r *rexTerminal) command(input string, args ...string) ([]byte, error) {
	bin, err := r.a.rexBin()
	if err != nil {
		return nil, err
	}
	flags := []string{"--autostart=false", "--timeout", "5s"}
	if server := r.a.env.Getenv("SHUTTLE_REX_SERVER"); server != "" {
		flags = append(flags, "-S", server)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	cmd := r.a.env.CommandContext(ctx, bin, append(flags, args...)...)
	cmd.Stdin = strings.NewReader(input)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return out, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		text := strings.ToLower(string(out))
		if exit.ExitCode() == 4 || strings.Contains(text, "server is not running") || strings.Contains(text, "connect: no such file") || strings.Contains(text, "connection refused") {
			return nil, errRexAbsent
		}
		if exit.ExitCode() == 3 || strings.Contains(text, "not found") {
			return nil, errRexNotFound
		}
	}
	return nil, fmt.Errorf("Rex: %w: %s", err, strings.TrimSpace(string(out)))
}

func (r *rexTerminal) sessions() ([]rexSession, error) {
	out, err := r.command("", "ls", "--json")
	if errors.Is(err, errRexAbsent) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var doc struct {
		Sessions *[]rexSession `json:"sessions"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return nil, err
	}
	if doc.Sessions == nil {
		return nil, fmt.Errorf("Rex returned no session list")
	}
	for _, session := range *doc.Sessions {
		if !strings.HasPrefix(session.SessionID, "session:") {
			return nil, fmt.Errorf("Rex returned an invalid session ID")
		}
	}
	return *doc.Sessions, nil
}

func (r *rexTerminal) Has(name string) (bool, error) {
	doc, err := r.bindings()
	if err != nil {
		return false, err
	}
	binding, ok := doc.Bindings[name]
	if !ok {
		return false, nil
	}
	sessions, err := r.sessions()
	if err != nil {
		return false, err
	}
	for _, session := range sessions {
		if session.SessionID == binding.SessionID {
			return r.boundBlockPresent(binding)
		}
	}
	return false, nil
}

// The daemon retains a missing-block binding while human panes survive in the
// session. That negative evidence must not become permission to close them.
func (r *rexTerminal) boundBlockPresent(binding rexBinding) (bool, error) {
	blocks, err := r.blocks(binding.SessionID)
	if err != nil {
		return false, err
	}
	for _, block := range blocks {
		if block.BlockID == binding.BlockID {
			return true, nil
		}
	}
	return false, nil
}

type rexBlock struct {
	BlockID string `json:"block_id"`
	Label   string `json:"label"`
}

func (r *rexTerminal) blocks(sid string) ([]rexBlock, error) {
	out, err := r.command("{}", "api", "call", "-s", sid, "session.list_blocks", "-")
	if errors.Is(err, errRexAbsent) || errors.Is(err, errRexNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var doc struct {
		Blocks *[]rexBlock `json:"blocks"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return nil, err
	}
	if doc.Blocks == nil {
		return nil, fmt.Errorf("Rex returned no block list")
	}
	return *doc.Blocks, nil
}

func (r *rexTerminal) Kill(name string) error {
	doc, err := r.bindings()
	if err != nil {
		return err
	}
	binding, ok := doc.Bindings[name]
	if !ok {
		return fmt.Errorf("no Rex binding for %q", name)
	}
	return r.closeBound(binding)
}

func (r *rexTerminal) closeBound(binding rexBinding) error {
	present, err := r.boundBlockPresent(binding)
	if err != nil {
		return err
	}
	if !present {
		return nil
	}
	return r.destroy(binding.SessionID)
}

func (r *rexTerminal) destroy(sid string) error {
	_, err := r.command("{}", "api", "call", "-s", sid, "session.destroy", "-")
	if errors.Is(err, errRexAbsent) || errors.Is(err, errRexNotFound) {
		return nil
	}
	return err
}

func (r *rexTerminal) LiveWorkers() (map[string]bool, error) {
	live := map[string]bool{}
	doc, err := r.bindings()
	if err != nil {
		return live, err
	}
	sessions, err := r.sessions()
	if err != nil {
		return live, err
	}
	for _, session := range sessions {
		bound := map[string]rexBinding{}
		for name, binding := range doc.Bindings {
			if binding.SessionID == session.SessionID {
				bound[name] = binding
			}
		}
		blocks, err := r.blocks(session.SessionID)
		if err != nil {
			return live, err
		}
		for name, binding := range bound {
			for _, block := range blocks {
				if block.BlockID == binding.BlockID && isShuttleTmuxSessionName(name) {
					live[name] = true
				}
			}
		}
		// A bound session's label is display, never a second worker identity.
		// Lost-binding discovery uses the block's recovery index independently
		// of the session's tree display. It never grants mutation authority.
		if len(bound) == 0 {
			for _, block := range blocks {
				if isShuttleTmuxSessionName(block.Label) {
					live[block.Label] = true
				}
			}
		}
	}
	return live, nil
}
