package shuttlecli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAmbientSessionStartInjection(t *testing.T) {
	t.Parallel()

	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/version" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"dev"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(daemon.Close)

	runHook := func(t *testing.T, envMap map[string]string, hostJSON string, input eventHookInput) string {
		t.Helper()
		env := messageHookEnv(t, "fir")
		env.Set("SHUTTLE_DAEMON_URL", daemon.URL)
		if hostJSON != "" {
			hostPath := filepath.Join(t.TempDir(), "host.json")
			if err := os.WriteFile(hostPath, []byte(hostJSON), 0o600); err != nil {
				t.Fatal(err)
			}
			env.Set("SHUTTLE_HOST_CONFIG_FILE", hostPath)
		}
		for k, v := range envMap {
			env.Set(k, v)
		}
		b, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := newApp(env).runEventAndMessageHook(bytes.NewReader(b), &out); err != nil {
			t.Fatalf("runEventAndMessageHook: %v", err)
		}
		return out.String()
	}

	storeDir, _ := newStore(t)

	t.Run("off by default", func(t *testing.T) {
		t.Parallel()
		out := runHook(t, nil, "", eventHookInput{
			HookEventName: "SessionStart",
			Harness:       "claude",
			SessionID:     "sess-1",
			CWD:           storeDir,
		})
		if out != "" {
			t.Fatalf("expected no output when ambient is off, got %q", out)
		}
	})

	t.Run("enabled via host.json emits ambient context", func(t *testing.T) {
		t.Parallel()
		out := runHook(t, map[string]string{
			"REX_SESSION": "session:human",
			"REX_BLOCK":   "block:human",
		}, `{"ambient": true}`, eventHookInput{
			HookEventName: "SessionStart",
			Harness:       "claude",
			SessionID:     "sess-ambient",
			CWD:           storeDir,
		})
		var env sessionEnvelope
		if err := json.Unmarshal([]byte(out), &env); err != nil {
			t.Fatalf("unmarshal envelope (%q): %v", out, err)
		}
		ctx := env.HookSpecificOutput.AdditionalContext
		for _, want := range []string{
			"Ambient Shuttle mode is active",
			"sess-ambient",
			"fir",
			storeDir,
			"shuttle adopt <parent>/<slug>",
			"--rex-session session:human",
			"--rex-block block:human",
		} {
			if !strings.Contains(ctx, want) {
				t.Fatalf("ambient context missing %q:\n%s", want, ctx)
			}
		}
	})

	t.Run("SHUTTLE_AMBIENT=0 disables even when host.json has ambient true", func(t *testing.T) {
		t.Parallel()
		out := runHook(t, map[string]string{
			"SHUTTLE_AMBIENT": "0",
		}, `{"ambient": true}`, eventHookInput{
			HookEventName: "SessionStart",
			Harness:       "claude",
			SessionID:     "sess-off",
			CWD:           storeDir,
		})
		if out != "" {
			t.Fatalf("expected no output when SHUTTLE_AMBIENT=0, got %q", out)
		}
	})

	t.Run("SHUTTLE_AMBIENT=1 enables without host.json", func(t *testing.T) {
		t.Parallel()
		out := runHook(t, map[string]string{
			"SHUTTLE_AMBIENT": "1",
		}, "", eventHookInput{
			HookEventName: "SessionStart",
			Harness:       "codex",
			SessionID:     "sess-codex",
			CWD:           storeDir,
		})
		if !strings.Contains(out, "Ambient Shuttle mode is active") || !strings.Contains(out, "sess-codex") {
			t.Fatalf("expected ambient context for codex, got %q", out)
		}
	})

	t.Run("skipped when SHUTTLE_FIBER is set", func(t *testing.T) {
		t.Parallel()
		out := runHook(t, map[string]string{
			"SHUTTLE_AMBIENT": "1",
			"SHUTTLE_FIBER":   "work/existing",
		}, "", eventHookInput{
			HookEventName: "SessionStart",
			Harness:       "claude",
			SessionID:     "sess-attached",
			CWD:           storeDir,
		})
		if out != "" {
			t.Fatalf("expected no ambient output for attached worker, got %q", out)
		}
	})

	t.Run("skipped when SHUTTLE_FIBER_PATH is set", func(t *testing.T) {
		t.Parallel()
		out := runHook(t, map[string]string{
			"SHUTTLE_AMBIENT":    "1",
			"SHUTTLE_FIBER_PATH": "/tmp/fiber.md",
		}, "", eventHookInput{
			HookEventName: "SessionStart",
			Harness:       "claude",
			SessionID:     "sess-attached-path",
			CWD:           storeDir,
		})
		if out != "" {
			t.Fatalf("expected no ambient output when SHUTTLE_FIBER_PATH set, got %q", out)
		}
	})

	t.Run("skipped silently when daemon is unreachable", func(t *testing.T) {
		t.Parallel()
		dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		dead.Close()
		out := runHook(t, map[string]string{
			"SHUTTLE_AMBIENT":    "1",
			"SHUTTLE_DAEMON_URL": dead.URL,
		}, "", eventHookInput{
			HookEventName: "SessionStart",
			Harness:       "claude",
			SessionID:     "sess-no-daemon",
			CWD:           storeDir,
		})
		if out != "" {
			t.Fatalf("expected no output when daemon unreachable, got %q", out)
		}
	})

	t.Run("skipped on non-SessionStart hooks", func(t *testing.T) {
		t.Parallel()
		out := runHook(t, map[string]string{
			"SHUTTLE_AMBIENT": "1",
		}, "", eventHookInput{
			HookEventName: "PostToolUse",
			Harness:       "claude",
			SessionID:     "sess-post",
			CWD:           storeDir,
		})
		if out != "" {
			t.Fatalf("expected no ambient output on PostToolUse, got %q", out)
		}
	})

	t.Run("quotes spaces and single quotes in paths and sanitizes newlines", func(t *testing.T) {
		t.Parallel()
		specialDir := filepath.Join(t.TempDir(), "my project's dir")
		if err := os.MkdirAll(filepath.Join(specialDir, ".felt"), 0o755); err != nil {
			t.Fatal(err)
		}
		out := runHook(t, map[string]string{
			"SHUTTLE_AMBIENT": "1",
			"REX_SESSION":     "session:a b",
			"REX_BLOCK":       "block:it's",
		}, "", eventHookInput{
			HookEventName: "SessionStart",
			Harness:       "claude",
			SessionID:     "sess\nnewline",
			CWD:           specialDir,
		})
		var env sessionEnvelope
		if err := json.Unmarshal([]byte(out), &env); err != nil {
			t.Fatalf("unmarshal envelope (%q): %v", out, err)
		}
		ctx := env.HookSpecificOutput.AdditionalContext
		wantQuoted := shellQuoteArg(specialDir)
		if !strings.Contains(wantQuoted, `'"'"'`) {
			t.Fatalf("expected single-quote escaping in %q", wantQuoted)
		}
		for _, want := range []string{
			"- session_uuid: sess newline\n",
			"--project-dir " + wantQuoted,
			"--store " + wantQuoted,
			"--rex-session 'session:a b'",
			"--rex-block 'block:it'\"'\"'s'",
		} {
			if !strings.Contains(ctx, want) {
				t.Fatalf("ambient context missing %q:\n%s", want, ctx)
			}
		}
	})
}
