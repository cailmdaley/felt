package shuttlecli

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestNamespacePreflightRefusalsDoNotClaimMutationUncertainty(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"old-owner", 200, `{"host":"worker","contract":{"expected":30}}`, "level 30"},
		{"wrong-owner", 200, `{"host":"hub","contract_level":31}`, `reported host "hub"`},
		{"missing-contract", 200, `{"host":"worker"}`, "level 0"},
		{"forward-failure", 502, `{"reason":"forward_failed","origin":"worker","error":"peer down"}`, "peer down"},
		{"refused-version", 400, `{"error":"version refused"}`, "version refused"},
		{"invalid-version", 200, `not JSON`, "cannot verify namespace contract"},
		{"version-not-fiber-miss", 404, `{"error_code":"fiber_not_found","host":"worker"}`, "fiber_not_found"},
	}
	for _, operation := range []string{"thread", "resume-project"} {
		t.Run(operation, func(t *testing.T) {
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					env := remoteLifecycleEnv(t)
					env.Set("SHUTTLE_TEST_OWNER_CONTRACT", "")
					dir, st := newStore(t)
					seedShuttleRole(t, st, "hub", felt.StatusOpen, remoteShuttleBlock("/remote/project"), nil)
					posts, gets := 0, 0
					serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path == "/api/v1/version" {
							gets++
							w.WriteHeader(tc.status)
							fmt.Fprint(w, tc.body)
							return
						}
						if r.Method == "POST" {
							posts++
						}
						fmt.Fprint(w, `{}`)
					}))
					args := []string{"thread", "hub", "Measure"}
					if operation == "resume-project" {
						args = []string{"resume", "hub", "--project-dir", "/remote/project"}
					}
					_, _, err := executeIn(t, env, dir, args...)
					if err == nil {
						t.Fatal("preflight refusal succeeded")
					}
					text := err.Error()
					if !strings.Contains(text, tc.want) || !strings.Contains(text, "the guarded write request was not sent") {
						t.Fatalf("inaccurate preflight error: %s", text)
					}
					for _, wrong := range []string{"the local shuttle daemon is unreachable", "may have been applied", "may already exist"} {
						if strings.Contains(text, wrong) {
							t.Fatalf("pre-write failure claims %q: %s", wrong, text)
						}
					}
					if posts != 0 || gets != 1 {
						t.Fatalf("preflight sent posts=%d gets=%d", posts, gets)
					}
					if _, err := st.Read("hub"); err != nil {
						t.Fatal("lost source", err)
					}
				})
			}
		})
	}
}
