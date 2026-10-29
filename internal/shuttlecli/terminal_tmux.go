package shuttlecli

import (
	"context"
	"fmt"
	"strings"
	"time"
)

type tmuxTerminal struct{ a *app }

func (*tmuxTerminal) ID() string { return "tmux" }

func (t *tmuxTerminal) Has(name string) (bool, error) {
	return t.a.env.Command("tmux", "has-session", "-t", "="+name).Run() == nil, nil
}

func (t *tmuxTerminal) Kill(name string) error {
	return t.a.env.Command("tmux", "kill-session", "-t", name).Run()
}

func (t *tmuxTerminal) LiveWorkers() (map[string]bool, error) {
	out, err := t.a.env.Command("tmux", "ls", "-F", "#{session_name}").Output()
	if err != nil {
		return map[string]bool{}, nil
	}
	result := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if isShuttleTmuxSessionName(line) {
			result[line] = true
		}
	}
	return result, nil
}

func (a *app) tmuxCurrentSession() (string, error) {
	if a.env.Getenv("TMUX") == "" {
		return "", fmt.Errorf("this terminal is outside tmux")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	pane := a.env.Getenv("TMUX_PANE")
	if pane == "" {
		return "", fmt.Errorf("the current tmux pane is unknown")
	}
	out, err := a.env.CommandContext(ctx, "tmux", "display-message", "-p", "-t", pane, "#{session_name}").Output()
	if err != nil {
		return "", err
	}
	name := strings.TrimSpace(string(out))
	if name == "" {
		return "", fmt.Errorf("tmux returned no session name")
	}
	return name, nil
}
