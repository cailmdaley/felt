package shuttlecli

import (
	"bytes"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func runScheduledMessage(t *testing.T, a *app, args ...string) (string, string, error) {
	t.Helper()
	var out, stderr bytes.Buffer
	a.env.Stdout, a.env.Stderr = &out, &stderr
	cmd := a.messageCmd(&messageOptions{})
	cmd.SetOut(&out)
	cmd.SetErr(&stderr)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), stderr.String(), err
}

func TestResolveMessageTime(t *testing.T) {
	paris, _ := time.LoadLocation("Europe/Paris")
	now := time.Date(2026, 11, 15, 16, 0, 0, 0, time.UTC)
	for _, tc := range []struct{ in, at, want string }{
		{"90m", "", "2026-11-15T17:30:00Z"}, {"2d", "", "2026-11-17T16:00:00Z"},
		{"", "18:00", "2026-11-15T17:00:00Z"}, {"", "17:00", "2026-11-16T16:00:00Z"},
		{"", "2026-11-16 09:00", "2026-11-16T08:00:00Z"}, {"", "2026-11-16T09:00:00-08:00", "2026-11-16T17:00:00Z"},
	} {
		got, err := resolveMessageTime(tc.in, tc.at, now, paris)
		if err != nil || got.Format(time.RFC3339) != tc.want {
			t.Fatalf("%+v: %s %v", tc, got, err)
		}
	}
	for _, tc := range [][2]string{{"-1h", ""}, {"0s", ""}, {"", "2026-11-15 16:00"}, {"", "nonsense"}} {
		if _, err := resolveMessageTime(tc[0], tc[1], now, paris); err == nil {
			t.Fatal(tc)
		}
	}
}

func TestMessageScheduleRetryKeepsInstant(t *testing.T) {
	a := newApp(testEnv(t))
	first, err := a.messageSchedule("same", "8h", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.messageSchedule("same", "8h", "")
	if err != nil || first != second {
		t.Fatalf("%s %s %v", first, second, err)
	}
	if _, err := a.messageSchedule("same", "9h", ""); err == nil {
		t.Fatal("changed publication accepted")
	}
}

func TestDelayedMessageContractAndWire(t *testing.T) {
	for _, levels := range [][2]int{{44, 45}, {45, 40}, {45, 45}} {
		t.Run(fmt.Sprint(levels), func(t *testing.T) {
			env := testEnv(t)
			store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
			isolateMessageFiberStore(env, store)
			deliver, requests := dormantDeliverStub(202, `{"queued":true,"status":"scheduled"}`)
			daemonStub(t, env, map[string]http.HandlerFunc{
				"/api/v1/version": func(w http.ResponseWriter, r *http.Request) {
					host, level := "hub", levels[0]
					if r.URL.Query().Get("origin") != "" {
						host, level = "worker-node", levels[1]
					}
					fmt.Fprintf(w, `{"host":%q,"contract_level":%d}`, host, level)
				},
				"/api/v1/deliver": deliver,
			})
			out, _, err := runScheduledMessage(t, newApp(env), "work/worker", "check the fit", "--in", "8h", "--message-id", "later")
			if levels[0] < 45 || levels[1] < 45 {
				if err == nil || !strings.Contains(err.Error(), "contract") || len(requests()) != 0 {
					t.Fatalf("%s %v %+v", out, err, requests())
				}
				return
			}
			if err != nil || !strings.Contains(out, "scheduled") || !strings.Contains(out, "UTC") {
				t.Fatalf("%s %v", out, err)
			}
			got := requests()
			if len(got) != 1 || got[0]["not_before"] == "" || got[0]["turn"] != "ask" {
				t.Fatal(got)
			}
		})
	}
}

func TestDelayedMessageRefusals(t *testing.T) {
	for _, args := range [][]string{
		{"shuttle://hub/pi/session", "later", "--in", "8h"},
		{"fiber", "later", "--in", "8h", "--fresh"},
		{"later", "--in", "8h"},
		{"fiber", "later", "--in", "8h", "--at", "18:00"},
	} {
		_, _, err := runScheduledMessage(t, newApp(testEnv(t)), args...)
		if err == nil {
			t.Fatal(args)
		}
	}
}
