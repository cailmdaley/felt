package shuttle

import (
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestRoleAndSeatResolution(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		fields map[string]any
		role   string
		seat   bool
	}{
		{"unassigned", map[string]any{"kind": "oneshot"}, "", false},
		{"office", map[string]any{"kind": "oneshot", "role": "vizier"}, "vizier", false},
		{"seat", map[string]any{"kind": "oneshot", "role": "vizier", "seat": true}, "vizier", true},
		{"string seat is not an office", map[string]any{"kind": "oneshot", "seat": "vizier"}, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := shuttleFiber(t, tc.fields)
			if err := f.SetExtraField("collaboration", map[string]any{"vizier": []string{"astra"}}); err != nil {
				t.Fatal(err)
			}
			if err := Resolve(f, nil, time.Now()); err != nil {
				t.Fatal(err)
			}
			out := marshalShuttle(t, f)
			facet := out[FacetKey].(map[string]any)
			if facet["role"] != tc.role || facet["seat"] != tc.seat {
				t.Fatalf("wrong office projection: %#v", facet)
			}
			if _, exists := facet["collaboration"]; exists {
				t.Fatalf("unexpected roster in facet: %#v", facet)
			}
			if tc.name == "string seat is not an office" {
				if _, _, err := BlockOf(f); err == nil {
					t.Fatal("BlockOf accepted a string-valued seat")
				}
			}
		})
	}
}

// A synchronized card can still carry a string seat. Its read projection must
// remain addressable even though lifecycle writes require boolean seats.
func TestResolve_StringSeatKeepsWorkerAddressable(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "seat": "chief-of-staff",
		"runtime": map[string]any{"session_uuid": "live-conversation"},
	})
	facet := marshalShuttle(t, f)[FacetKey].(map[string]any)
	resolved, ok := facet["resolved"].(map[string]any)
	if !ok {
		t.Fatalf("worker harness missing from read projection: %#v", facet)
	}
	agent, ok := resolved["agent"].(map[string]any)
	if !ok || agent["cli"] != "claude" {
		t.Fatalf("worker harness = %#v, want claude", resolved["agent"])
	}
	if facet["seat"] != false || facet["role"] != "" {
		t.Fatalf("unexpected office projection: %#v", facet)
	}
	if got := facet["runtime"].(map[string]any)["session_uuid"]; got != "live-conversation" {
		t.Fatalf("conversation = %v", got)
	}
	if got := felt.MappingValueNode(f.ExtraFields[FacetKey], "seat").Value; got != "chief-of-staff" {
		t.Fatalf("read changed stored seat: %q", got)
	}
	if _, _, err := BlockOf(f); err == nil {
		t.Fatal("lifecycle validation accepted a string seat")
	}
}

func TestBlockOf_OfficeFieldTypes(t *testing.T) {
	t.Parallel()
	for _, fields := range []map[string]any{
		{"kind": "oneshot", "role": 123},
		{"kind": "oneshot", "role": true},
		{"kind": "oneshot", "role": []string{"vizier"}},
		{"kind": "oneshot", "seat": "true"},
		{"kind": "oneshot", "seat": "vizier"},
		{"kind": "oneshot", "seat": 1},
	} {
		if _, _, err := BlockOf(shuttleFiber(t, fields)); err == nil {
			t.Fatalf("accepted office fields with wrong types: %#v", fields)
		}
	}
}

func TestSetConfig_MovesRoleToTopLevel(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{"kind": "oneshot", "role": "vizier", "seat": true})
	block, _, err := BlockOf(f)
	if err != nil || block.Role != "vizier" {
		t.Fatalf("legacy block role not read: %+v, %v", block, err)
	}
	block.Agent = "claude-sonnet"
	if err := SetConfig(f, block); err != nil {
		t.Fatal(err)
	}
	count := map[string]int{}
	node := f.ExtraFields[FacetKey]
	for i := 0; i < len(node.Content); i += 2 {
		count[node.Content[i].Value]++
	}
	if count["role"] != 0 || count["seat"] != 1 || f.Role != "vizier" {
		t.Fatalf("role not moved out of the block: keys %v, role %q", count, f.Role)
	}
	if got, _, err := BlockOf(f); err != nil || got.Role != "vizier" || !got.Seat {
		t.Fatalf("office did not round-trip: %+v, %v", got, err)
	}
	block.Seat = false
	if err := SetConfig(f, block); err != nil {
		t.Fatal(err)
	}
	if felt.MappingValueNode(f.ExtraFields[FacetKey], "seat") != nil {
		t.Fatal("SetConfig retained a cleared seat")
	}
	if err := SetRole(f, ""); err != nil || f.Role != "" {
		t.Fatalf("SetRole did not clear: %q %v", f.Role, err)
	}
}

func TestTopLevelRoleWinsAndProjectsOfficeAndPerson(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		top, block, office, person string
	}{
		{"analyst/sam", "", "analyst", "sam"},
		{"analyst/sam", "editor", "analyst", "sam"},
		{"", "editor", "editor", "editor"},
		{"sam", "", "sam", "sam"},
		{"", "", "", ""},
	} {
		fields := map[string]any{"kind": "oneshot"}
		if tc.block != "" {
			fields["role"] = tc.block
		}
		f := shuttleFiber(t, fields)
		f.Role = tc.top
		block, _, err := BlockOf(f)
		if err != nil {
			t.Fatal(err)
		}
		want := tc.top
		if want == "" {
			want = tc.block
		}
		if block.Role != want {
			t.Fatalf("BlockOf role = %q, want %q", block.Role, want)
		}
		facet := marshalShuttle(t, f)[FacetKey].(map[string]any)
		if facet["role"] != tc.office || facet["person"] != tc.person {
			t.Fatalf("top %q block %q projected %#v", tc.top, tc.block, facet)
		}
	}
}

func TestValidRoleOfficeAndPerson(t *testing.T) {
	t.Parallel()
	for role, want := range map[string]bool{
		"analyst": true, "analyst/sam": true, "data-lead/sam-2": true,
		"": false, "a/b/c": false, "roles/analyst/sam": false, "Analyst": false, "analyst/": false,
	} {
		if ValidRole(role) != want {
			t.Errorf("ValidRole(%q) != %v", role, want)
		}
	}
	if OfficeOf("analyst/sam") != "analyst" || PersonOf("analyst/sam") != "sam" || OfficeOf("sam") != "sam" || PersonOf("sam") != "sam" {
		t.Fatal("OfficeOf/PersonOf are not the first and last segments")
	}
}
