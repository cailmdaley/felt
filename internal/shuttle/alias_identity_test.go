package shuttle

import (
	"reflect"
	"testing"
	"time"
)

func TestResolvedAliasIdentityReappliesOverlays(t *testing.T) {
	t.Parallel()
	reg := loadReg(t)
	for _, env := range []AgentEnv{nil, {}, {"CACHE_TTL": "5m"}} {
		reg.agents = append(reg.agents, AgentRecord{
			ID: "selected-alias", AliasOf: "claude-opus", Env: env,
			Axes: &Axes{Effort: "high", Chrome: true, Headless: true},
		})
		rec, axes, err := reg.Resolve("selected-alias", "", false)
		if err != nil {
			t.Fatal(err)
		}
		if rec.ID != "selected-alias" || axes != (Axes{Effort: "high", Chrome: true, Headless: true}) {
			t.Fatalf("env %v: got %s / %+v", env, rec.ID, axes)
		}
		persisted := reg.NewResolvedAgent(rec, axes)
		// Capture and session ledgers persist the resolved id. Re-resolving that
		// id must restore every alias overlay, not only the environment map.
		resumed, resumedAxes, err := reg.Resolve(persisted.ID, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if got := reg.NewResolvedAgent(resumed, resumedAxes); !reflect.DeepEqual(got, persisted) {
			t.Fatalf("env %v: resume %+v != launch %+v", env, got, persisted)
		}
		captured, err := ResolveBlock(&Block{Agent: persisted.ID}, reg, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(captured.Agent, persisted) {
			t.Fatalf("env %v: capture %+v != launch %+v", env, captured.Agent, persisted)
		}
		reg.agents = reg.agents[:len(reg.agents)-1]
	}
}
