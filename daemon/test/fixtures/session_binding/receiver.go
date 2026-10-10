// Synthetic harness: invokes the real hook writer from two receiver processes.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

func hook(id, kind string) {
	payload := fmt.Sprintf(`{"harness":"claude","session_id":%q,"hook_event_name":%q}`, id, kind)
	cmd := exec.Command(os.Args[1], "hook", "event")
	cmd.Stdin = strings.NewReader(payload)
	if out, err := cmd.CombinedOutput(); err != nil {
		panic(string(out) + err.Error())
	}
	time.Sleep(5 * time.Millisecond)
}

func main() {
	if len(os.Args) > 2 {
		hook("nested", "SessionStart")
		hook("nested", "Notification")
		return
	}
	hook("anchor", "PreToolUse")
	cmd := exec.Command(os.Args[0], os.Args[1], "nested")
	if out, err := cmd.CombinedOutput(); err != nil {
		panic(string(out) + err.Error())
	}
	hook("switched", "SessionStart")
	hook("switched", "Stop")
}
