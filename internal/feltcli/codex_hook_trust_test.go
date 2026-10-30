package feltcli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// The executable fake is this test binary behind a LinkScript launcher. It
// persists requests and hook state outside the process so separate inspectors
// exercise the same list/write/list contract as Codex.
func TestCodexTrustRPCProcess(t *testing.T) {
	if os.Getenv("FELT_TRUST_RPC_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var req struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			os.Exit(2)
		}
		log, err := os.OpenFile(os.Getenv("TRUST_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			os.Exit(2)
		}
		fmt.Fprintln(log, scanner.Text())
		log.Close()
		var result any = map[string]any{}
		var rpcError any
		switch req.Method {
		case "initialized":
			continue
		case "hooks/list":
			data, err := os.ReadFile(os.Getenv("TRUST_HOOKS"))
			if err != nil {
				os.Exit(2)
			}
			if json.Unmarshal(data, &result) != nil {
				os.Exit(2)
			}
			if os.Getenv("TRUST_FAIL") == "list" {
				rpcError = map[string]any{"code": -1, "message": "list refused"}
			}
		case "config/batchWrite":
			if os.Getenv("TRUST_FAIL") == "write" {
				rpcError = map[string]any{"code": -1, "message": "write refused"}
				break
			}
			var request struct {
				Edits []struct {
					KeyPath string `json:"keyPath"`
				} `json:"edits"`
			}
			json.Unmarshal(req.Params, &request)
			var state struct {
				Data []struct {
					Hooks []codexTrustHook `json:"hooks"`
				} `json:"data"`
			}
			data, _ := os.ReadFile(os.Getenv("TRUST_HOOKS"))
			json.Unmarshal(data, &state)
			for i := range state.Data {
				for j, h := range state.Data[i].Hooks {
					quoted, _ := json.Marshal(h.Key)
					for _, edit := range request.Edits {
						if edit.KeyPath == "hooks.state."+string(quoted) && os.Getenv("TRUST_FAIL") != "verify" {
							state.Data[i].Hooks[j].TrustStatus = "trusted"
						}
					}
				}
			}
			data, _ = json.Marshal(state)
			if os.WriteFile(os.Getenv("TRUST_HOOKS"), data, 0600) != nil {
				os.Exit(2)
			}
			result = map[string]any{"status": "ok"}
		}
		response := map[string]any{"id": req.ID, "result": result}
		if rpcError != nil {
			delete(response, "result")
			response["error"] = rpcError
		}
		if json.NewEncoder(os.Stdout).Encode(response) != nil {
			os.Exit(2)
		}
	}
	os.Exit(0)
}

func fakeCodexTrust(t *testing.T, env *sysenv.Env, hooks []codexTrustHook) func() []map[string]json.RawMessage {
	t.Helper()
	dir := t.TempDir()
	env.Set("FELT_TRUST_RPC_HELPER", "1")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	env.Set("TRUST_TEST_BINARY", binary)
	env.Set("TRUST_LOG", filepath.Join(dir, "log"))
	env.Set("TRUST_HOOKS", filepath.Join(dir, "hooks.json"))
	data, err := json.Marshal(map[string]any{"data": []any{map[string]any{"hooks": hooks}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.Getenv("TRUST_HOOKS"), data, 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(sysenvtest.FakeBin(t, env), "codex")
	sysenvtest.LinkScript(t, path, `exec "$TRUST_TEST_BINARY" '-test.run=^TestCodexTrustRPCProcess$'`)
	return func() []map[string]json.RawMessage {
		t.Helper()
		data, _ := os.ReadFile(env.Getenv("TRUST_LOG"))
		var requests []map[string]json.RawMessage
		scanner := bufio.NewScanner(strings.NewReader(string(data)))
		for scanner.Scan() {
			var req map[string]json.RawMessage
			if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
				t.Fatal(err)
			}
			requests = append(requests, req)
		}
		return requests
	}
}

func trustHook(plugin, key, status string) codexTrustHook {
	return codexTrustHook{PluginID: plugin, Key: key, Source: "plugin", CurrentHash: "sha256:" + strings.Repeat("a", 64) + "/sha256:" + strings.Repeat("b", 64), TrustStatus: status}
}

// Negative control: remove the pluginId filter; the request assertion catches
// approval of another plugin and the before/after state check catches mutation.
func TestCodexHookTrustOnlyWritesFeltAndIsIdempotent(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	felt := trustHook(codexPluginRef, codexPluginRef+":hooks/hooks.json:session_start:0:0", "modified")
	other := trustHook("another@market", "another@market:hooks/hooks.json:0:0", "untrusted")
	user := trustHook("", "user:/hooks.json:0:0", "untrusted")
	user.Source = "user"
	project := user
	project.Key = "project:/hooks.json:0:0"
	project.Source = "project"
	// A felt-looking key without felt's pluginId is never authority to approve.
	impostor := other
	impostor.Key = codexPluginRef + ":hooks/hooks.json:stop:9:9"
	requests := fakeCodexTrust(t, env, []codexTrustHook{felt, other, user, project, impostor})
	a := testApp(t, env)
	if err := a.codexHookTrust(true); err != nil {
		t.Fatal(err)
	}
	if err := a.codexHookTrust(true); err != nil {
		t.Fatal(err)
	}
	writes := 0
	lists := 0
	for _, req := range requests() {
		var method string
		json.Unmarshal(req["method"], &method)
		if method == "hooks/list" {
			lists++
		}
		if method != "config/batchWrite" {
			continue
		}
		writes++
		if lists != 1 {
			t.Fatalf("write preceded by %d lists", lists)
		}
		var params struct {
			Edits []struct {
				KeyPath string            `json:"keyPath"`
				Value   map[string]string `json:"value"`
				Merge   string            `json:"mergeStrategy"`
			} `json:"edits"`
			Reload bool `json:"reloadUserConfig"`
		}
		if err := json.Unmarshal(req["params"], &params); err != nil {
			t.Fatal(err)
		}
		if len(params.Edits) != 1 || params.Edits[0].KeyPath != `hooks.state."`+felt.Key+`"` || !params.Reload {
			t.Fatalf("unsafe trust params: %s", req["params"])
		}
		edit := params.Edits[0]
		if edit.Merge != "upsert" || edit.Value["trusted_hash"] != "sha256:"+strings.Repeat("a", 64) || edit.Value["trusted_content_hash"] != "sha256:"+strings.Repeat("b", 64) {
			t.Fatalf("hashes not copied from Codex: %#v", edit)
		}
	}
	if writes != 1 || lists != 3 {
		t.Fatalf("writes=%d lists=%d", writes, lists)
	}
	data, _ := os.ReadFile(env.Getenv("TRUST_HOOKS"))
	var state struct {
		Data []struct {
			Hooks []codexTrustHook `json:"hooks"`
		} `json:"data"`
	}
	json.Unmarshal(data, &state)
	for _, h := range state.Data[0].Hooks[1:] {
		if h.TrustStatus != "untrusted" {
			t.Fatalf("unrelated hook changed: %#v", h)
		}
	}
}

func TestCodexHookTrustFailuresWarnAndReceiptRejects(t *testing.T) {
	for _, failure := range []string{"write", "list", "verify", "hash", "missing", "identity"} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			env, streams := testEnv(t)
			h := trustHook(codexPluginRef, codexPluginRef+":hooks/hooks.json:session_start:0:0", "modified")
			hooks := []codexTrustHook{h}
			switch failure {
			case "hash":
				hooks[0].CurrentHash = "sha256:old"
			case "missing":
				hooks = nil
			case "identity":
				hooks[0].Key = "other:0:0"
			}
			fakeCodexTrust(t, env, hooks)
			env.Set("TRUST_FAIL", failure)
			a := testApp(t, env)
			a.refreshCodexHookTrust()
			if !strings.Contains(streams.Stderr.String(), "Warning:") || !strings.Contains(streams.Stderr.String(), "felt setup codex --trust-hooks") {
				t.Fatalf("missing warning: %s", streams.Stderr.String())
			}
			root := filepath.Join(repoRoot(t), "claude-plugin")
			receipt := a.collectHookReceipt([]ReceiptBundle{{Harness: "codex", Path: root, Status: receiptHealthy}})
			if receipt.Status == receiptHealthy || !strings.Contains(receipt.Repair, "felt setup codex --trust-hooks") {
				t.Fatalf("failure reported healthy: %#v", receipt)
			}
		})
	}
}

func TestCodexHookReceiptIsReadOnlyAndChecksEveryHook(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	hooks := []codexTrustHook{trustHook(codexPluginRef, codexPluginRef+":session_start:0:0", "trusted"), trustHook(codexPluginRef, codexPluginRef+":pre_tool_use:0:0", "trusted"), trustHook(codexPluginRef, codexPluginRef+":stop:0:0", "modified")}
	requests := fakeCodexTrust(t, env, hooks)
	a := testApp(t, env)
	if err := a.codexHookTrust(false); err == nil || !strings.Contains(err.Error(), ":stop:") {
		t.Fatalf("modified stop hook not detected: %v", err)
	}
	for _, req := range requests() {
		if string(req["method"]) == `"config/batchWrite"` {
			t.Fatal("receipt wrote trust")
		}
	}
}

func TestCodexHookTrustAbsentCodexSkipsQuietly(t *testing.T) {
	t.Parallel()
	env, streams := testEnv(t)
	sysenvtest.OnlyPath(env)
	a := testApp(t, env)
	a.refreshCodexHookTrust()
	if err := a.codexHookTrust(false); err != nil {
		t.Fatal(err)
	}
	if streams.Stderr.String() != "" || streams.Stdout.String() != "" {
		t.Fatal("absent Codex was not quiet")
	}
}
