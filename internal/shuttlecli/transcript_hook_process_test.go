//go:build !windows

package shuttlecli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// Each helper is re-executed in a real process. Arguments carry the scoped
// environment through TestMain's fresh process fence without global writes.
func hookProcessArgs() []string {
	for i, arg := range os.Args {
		if arg == "--" {
			return os.Args[i+1:]
		}
	}
	return nil
}
func TestTranscriptHookProcessHelper(t *testing.T) {
	args := hookProcessArgs()
	if len(args) != 2 {
		return
	}
	var environ []string
	if err := json.Unmarshal([]byte(args[0]), &environ); err != nil {
		t.Fatal(err)
	}
	env := sysenv.New("/", environ)
	env.Stdin = strings.NewReader(args[1])
	if err := newApp(env).runEventAndMessageHook(env.Stdin, io.Discard); err != nil {
		t.Fatal(err)
	}
}
func TestTranscriptHookIndexChildHelper(t *testing.T) {
	args := hookProcessArgs()
	if len(args) < 2 {
		return
	}
	conn, err := net.Dial("unix", args[0])
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err = fmt.Fprintln(conn, strings.Join(args[1:], " ")); err != nil {
		t.Fatal(err)
	}
	// The parent releases this child only after the hook process has exited.
	var release [1]byte
	if _, err = io.ReadFull(conn, release[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Write([]byte("finished\n")); err != nil {
		t.Fatal(err)
	}
}
func TestSessionEndHookExitsBeforeIndexChildIsReleased(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_MESSAGES", "off")
	env.Set("SHUTTLE_EVENTS", "off")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("/tmp", "ts-hook-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "signal.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	deadline := time.Now().Add(10 * time.Second)
	_ = listener.SetDeadline(deadline)
	shim := fmt.Sprintf("#!/bin/sh\nexec %q -test.run='^TestTranscriptHookIndexChildHelper$' -- %q \"$@\"\n", exe, socket)
	if err = os.WriteFile(filepath.Join(dir, "shuttle"), []byte(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", dir)
	environ, _ := json.Marshal(env.Environ())
	payload := `{"hook_event_name":"SessionEnd","harness":"codex","session_id":"test-session","transcript_path":"/transcripts/rollout.jsonl"}`
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	cmd := env.CommandContext(ctx, exe, "-test.run=^TestTranscriptHookProcessHelper$", "--", string(environ), payload)
	done := make(chan error, 1)
	go func() {
		output, e := cmd.CombinedOutput()
		if e != nil {
			e = fmt.Errorf("%w: %s", e, output)
		}
		done <- e
	}()
	conn, err := listener.AcceptUnix()
	if err != nil {
		t.Fatalf("index child did not connect: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)
	reader := bufio.NewReader(conn)
	args, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(args) != "transcript index --file /transcripts/rollout.jsonl --harness codex" {
		t.Fatalf("child indexed more than one transcript: %q", args)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("hook waited for the blocked indexing child")
	}
	if _, err = conn.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if done, err := reader.ReadString('\n'); err != nil || done != "finished\n" {
		t.Fatalf("index child didn't survive hook exit: %q %v", done, err)
	}
}
