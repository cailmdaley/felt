package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A new test subprocess models each hook invocation, including its empty
// process-local memory. The failing owner probe must happen only once.
func TestThreadValidationBackoffSurvivesFreshHooks(t *testing.T) {
	if os.Getenv("SHUTTLE_VALIDATION_CHILD") == "1" {
		env := testEnv(t)
		env.Set("SHUTTLE_DATA_DIR", os.Getenv("SHUTTLE_VALIDATION_DATA"))
		env.Set("PATH", os.Getenv("SHUTTLE_VALIDATION_BIN"))
		env.Set("SHUTTLE_VALIDATION_ATTEMPTS", os.Getenv("SHUTTLE_VALIDATION_ATTEMPTS"))
		request := Request{MessageID: "thread-test", Text: "thread host/child asked: question", ThreadSignal: &ThreadSignal{Owner: "unreachable", UID: "id", Verb: "asked", Stamp: "stamp"}}
		if _, err := currentThreadSignalWithBackoff(context.Background(), env, request); err == nil {
			t.Fatal("unreachable owner validated")
		}
		return
	}
	env := testEnv(t)
	bin := t.TempDir()
	attempts := filepath.Join(bin, "attempts")
	stub := "#!/bin/sh\necho probe >> \"$SHUTTLE_VALIDATION_ATTEMPTS\"\n/bin/sleep 0.2\nexit 1\n"
	if err := os.WriteFile(filepath.Join(bin, "shuttle"), []byte(stub), 0700); err != nil {
		t.Fatal(err)
	}
	var durations []time.Duration
	for i := 0; i < 3; i++ {
		cmd := exec.Command(os.Args[0], "-test.run=^TestThreadValidationBackoffSurvivesFreshHooks$")
		cmd.Env = append(os.Environ(), "SHUTTLE_VALIDATION_CHILD=1", "SHUTTLE_VALIDATION_DATA="+dataDir(env), "SHUTTLE_VALIDATION_BIN="+bin, "SHUTTLE_VALIDATION_ATTEMPTS="+attempts)
		start := time.Now()
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("hook %d: %v: %s", i, err, out)
		}
		durations = append(durations, time.Since(start))
	}
	bytes, err := os.ReadFile(attempts)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fresh hook elapsed: %v", durations)
	if string(bytes) != "probe\n" {
		t.Fatalf("owner probed repeatedly across fresh hooks: %q", bytes)
	}
}

func TestThreadValidationBackoffIsPerOwnerAndExpires(t *testing.T) {
	env := testEnv(t)
	request := Request{MessageID: "thread-test", ThreadSignal: &ThreadSignal{Owner: "offline"}}
	calls := 0
	unavailable := errors.New("unreachable")
	check := func(context.Context, Request) (bool, error) { calls++; return false, unavailable }
	if _, err := validateThreadSignalWithBackoff(context.Background(), env, request, check); !errors.Is(err, unavailable) {
		t.Fatalf("initial error = %v", err)
	}
	if _, err := validateThreadSignalWithBackoff(context.Background(), env, request, check); err == nil || calls != 1 {
		t.Fatalf("cached failure: calls=%d, err=%v", calls, err)
	}
	healthy := request
	healthy.ThreadSignal = &ThreadSignal{Owner: "online"}
	successCalls := 0
	success := func(context.Context, Request) (bool, error) { successCalls++; return true, nil }
	for i := 0; i < 2; i++ {
		if current, err := validateThreadSignalWithBackoff(context.Background(), env, healthy, success); !current || err != nil {
			t.Fatalf("healthy owner = %v, %v", current, err)
		}
	}
	if successCalls != 2 {
		t.Fatal("successful checks were cached")
	}
	path := filepath.Join(dataDir(env), "thread-validation", mailboxKey("offline")+".json")
	bytes, _ := json.Marshal(threadValidationFailure{RetryAt: time.Now().Add(-time.Second)})
	if err := mailboxWrite(path, bytes, false); err != nil {
		t.Fatal(err)
	}
	if current, err := validateThreadSignalWithBackoff(context.Background(), env, request, success); !current || err != nil {
		t.Fatalf("expired owner = %v, %v", current, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("successful retry left failure: %v", err)
	}
}

func TestConcurrentThreadValidationSharesFailedProbe(t *testing.T) {
	env := testEnv(t)
	request := Request{MessageID: "thread-test", ThreadSignal: &ThreadSignal{Owner: "offline"}}
	var calls atomic.Int32
	check := func(context.Context, Request) (bool, error) {
		calls.Add(1)
		time.Sleep(20 * time.Millisecond)
		return false, errors.New("unreachable")
	}
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := validateThreadSignalWithBackoff(context.Background(), env, request, check); err == nil {
				t.Error("unreachable owner validated")
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("owner probed %d times concurrently", calls.Load())
	}
}
