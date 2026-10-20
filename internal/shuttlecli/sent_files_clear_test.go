package shuttlecli

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

const clearTestUID = "01KTS261GJMMRDRHS2QDMEFV3K"

func TestSentFilesClearResolvesCanonicalUID(t *testing.T) {
	t.Parallel()
	for _, host := range []string{"", "test-host"} {
		t.Run("host="+host, func(t *testing.T) {
			t.Parallel()
			env, sink, artifact := sendFileTestEnv(t)
			dir, storage := newStore(t)
			var block map[string]any
			if host != "" {
				block = oneshot()
				block["host"] = host
			}
			seedFiber(t, storage, "work/reports", clearTestUID, "", block, nil)
			before, err := os.ReadFile(storage.Path("work/reports"))
			if err != nil {
				t.Fatal(err)
			}
			if out, err := runIn(t, env, dir, "sent-files", "clear", "work/reports"); err != nil {
				t.Fatalf("clear: %v\n%s", err, out)
			}
			raw, err := os.ReadFile(sink)
			if err != nil {
				t.Fatal(err)
			}
			var event map[string]any
			if err := json.Unmarshal(raw, &event); err != nil {
				t.Fatal(err)
			}
			if event["type"] != "sent_files_cleared" || event["uid"] != clearTestUID || event["originName"] != "test-host" || event["timestamp"].(float64) <= 0 || event["id"] == "" {
				t.Fatalf("bad clear: %s", raw)
			}
			if event["path"] != nil {
				t.Fatalf("whole-fiber clear must omit path: %s", raw)
			}
			if event["sessionId"] != "" || event["tool"] != nil {
				t.Fatalf("invented session activity: %s", raw)
			}
			after, err := os.ReadFile(storage.Path("work/reports"))
			if err != nil || string(after) != string(before) {
				t.Fatalf("changed fiber: %v", err)
			}
			if _, err := os.Stat(artifact); err != nil {
				t.Fatalf("changed artifact: %v", err)
			}
		})
	}
}

func TestSentFilesClearRefusesRemoteEvenWithLocal(t *testing.T) {
	t.Parallel()
	for _, local := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal", true: "local"}[local], func(t *testing.T) {
			t.Parallel()
			env, sink, _ := sendFileTestEnv(t)
			dir, storage := newStore(t)
			block := oneshot()
			block["host"] = "remote-host"
			seedFiber(t, storage, "work/remote", clearTestUID, "", block, nil)
			args := []string{"sent-files", "clear", "work/remote"}
			if local {
				args = append(args, "--local")
			}
			if _, err := runIn(t, env, dir, args...); err == nil || !strings.Contains(err.Error(), "remote-host") {
				t.Fatalf("expected owner refusal: %v", err)
			}
			if _, err := os.Stat(sink); !os.IsNotExist(err) {
				t.Fatalf("recorded remote clear: %v", err)
			}
		})
	}
}

func TestSentFilesClearRawUIDRequiresLocalAndValidUID(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{clearTestUID, "--uid"}, {"not-a-uid", "--uid", "--local"}, {strings.ToLower(clearTestUID), "--uid", "--local"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			t.Parallel()
			env, sink, _ := sendFileTestEnv(t)
			if _, err := runIn(t, env, t.TempDir(), append([]string{"sent-files", "clear"}, args...)...); err == nil {
				t.Fatal("expected refusal")
			}
			if _, err := os.Stat(sink); !os.IsNotExist(err) {
				t.Fatalf("recorded invalid clear: %v", err)
			}
		})
	}
	env, sink, _ := sendFileTestEnv(t)
	if _, err := runIn(t, env, t.TempDir(), "sent-files", "clear", clearTestUID, "--uid", "--local"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(sink); err != nil {
		t.Fatal(err)
	}
}

func TestSentFilesClearPathFlag(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"", "relative.html", "~/report.html", "/tmp/missing/../report.html"} {
		t.Run("path="+path, func(t *testing.T) {
			t.Parallel()
			env, sink, _ := sendFileTestEnv(t)
			_, err := runIn(t, env, t.TempDir(), "sent-files", "clear", clearTestUID, "--uid", "--local", "--path", path)
			if !strings.HasPrefix(path, "/") {
				if err == nil || !strings.Contains(err.Error(), "absolute path") {
					t.Fatalf("expected invalid path refusal: %v", err)
				}
				if _, err := os.Stat(sink); !os.IsNotExist(err) {
					t.Fatalf("recorded invalid clear: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(sink)
			if err != nil {
				t.Fatal(err)
			}
			var event map[string]any
			if err := json.Unmarshal(raw, &event); err != nil {
				t.Fatal(err)
			}
			if event["path"] != path || event["uid"] != clearTestUID {
				t.Fatalf("path was changed or omitted: %s", raw)
			}
		})
	}
}

func TestSentFilesClearUsesEventSinkAndRotation(t *testing.T) {
	t.Parallel()
	env, sink, artifact := sendFileTestEnv(t)
	env.Set("SHUTTLE_EVENTS_MAX_BYTES", "1")
	if err := os.WriteFile(sink, []byte("old-event\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a := newApp(env)
	a.eventNow = func() time.Time { return time.UnixMilli(123456) }
	if err := a.clearSentFiles(clearTestUID, ""); err != nil {
		t.Fatal(err)
	}
	rotated, err := os.ReadFile(sink + ".1")
	if err != nil || string(rotated) != "old-event\n" {
		t.Fatalf("did not rotate: %s %v", rotated, err)
	}
	raw, err := os.ReadFile(sink)
	if err != nil || !strings.Contains(string(raw), `"timestamp":123456`) {
		t.Fatalf("bad event: %s %v", raw, err)
	}
	env.Set("SHUTTLE_EVENTS", "off")
	if err := a.clearSentFiles(clearTestUID, ""); err == nil {
		t.Fatal("recorded with recording disabled")
	}
	after, _ := os.ReadFile(sink)
	if string(raw) != string(after) {
		t.Fatal("disabled clear changed stream")
	}
	env.Set("SHUTTLE_EVENTS", "")
	env.Set("SHUTTLE_EVENTS_FILE", artifact+"/events.jsonl")
	if err := a.clearSentFiles(clearTestUID, ""); err == nil {
		t.Fatal("ignored write failure")
	}
}
