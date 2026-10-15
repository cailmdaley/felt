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

func TestSetConfig_OfficeRoundTripHasNoDuplicateKeys(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{"kind": "oneshot", "role": "vizier", "seat": true})
	block, _, err := BlockOf(f)
	if err != nil {
		t.Fatal(err)
	}
	block.Agent = "claude-sonnet"
	if err := SetConfig(f, block); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"role", "seat"} {
		node := f.ExtraFields[FacetKey]
		count := 0
		for i := 0; i < len(node.Content); i += 2 {
			if node.Content[i].Value == key {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("%s appears %d times", key, count)
		}
	}
	if got, _, err := BlockOf(f); err != nil || got.Role != "vizier" || !got.Seat {
		t.Fatalf("office did not round-trip: %+v, %v", got, err)
	}
	block.Role, block.Seat = "", false
	if err := SetConfig(f, block); err != nil {
		t.Fatal(err)
	}
	if felt.MappingValueNode(f.ExtraFields[FacetKey], "role") != nil || felt.MappingValueNode(f.ExtraFields[FacetKey], "seat") != nil {
		t.Fatal("SetConfig retained cleared office fields")
	}
}
