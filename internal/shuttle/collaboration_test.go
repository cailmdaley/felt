package shuttle

import (
	"encoding/json"
	"strings"
	"testing"
)

const collaborationTestUID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

func TestParseCollaborationJSON_AcceptsLocalAndLegacyReferences(t *testing.T) {
	c, err := ParseCollaborationJSON(`{"collaborator":{"uid":"01ARZ3NDEKTSV4RRFFQ69G5FAV","origin":"hub-1"},"role":{"uid":"01ARZ3NDEKTSV4RRFFQ69G5FAV","origin":"remote_2"}}`)
	if err != nil {
		t.Fatalf("ParseCollaborationJSON: %v", err)
	}
	if c.Collaborator == nil || c.Role == nil || c.Collaborator.Origin != "hub-1" || c.Role.Origin != "remote_2" {
		t.Fatalf("parsed collaboration = %#v", c)
	}
}

func TestParseCollaborationJSON_AcceptsUIDOnlyLocalReferences(t *testing.T) {
	c, err := ParseCollaborationJSON(`{"role":{"uid":"` + collaborationTestUID + `"}}`)
	if err != nil {
		t.Fatalf("ParseCollaborationJSON: %v", err)
	}
	if c.Role == nil || c.Role.UID != collaborationTestUID || c.Role.Origin != "" {
		t.Fatalf("parsed collaboration = %#v", c)
	}
}

func TestParseCollaborationJSON_RosterAndLegacySnapshotsRoundTrip(t *testing.T) {
	roster, err := ParseCollaborationJSON(`{"vizier":["fable","astra"],"role":[],"collaborator":[]}`)
	if err != nil {
		t.Fatalf("parse roster: %v", err)
	}
	encoded, err := json.Marshal(roster)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip map[string][]string
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if len(roundTrip) != 3 || len(roundTrip["vizier"]) != 2 || roundTrip["role"] == nil || roundTrip["collaborator"] == nil {
		t.Fatalf("roster round trip = %s", encoded)
	}

	legacyJSON := `{"role":{"uid":"` + collaborationTestUID + `","origin":"remote_2"},"collaborator":{"uid":"` + collaborationTestUID + `"}}`
	legacy, err := ParseCollaborationJSON(legacyJSON)
	if err != nil {
		t.Fatalf("parse legacy snapshot: %v", err)
	}
	legacyEncoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	decodedLegacy, err := ParseCollaborationJSON(string(legacyEncoded))
	if err != nil || decodedLegacy.Role == nil || decodedLegacy.Collaborator == nil || decodedLegacy.Role.Origin != "remote_2" {
		t.Fatalf("legacy snapshot round trip = %s, err %v", legacyEncoded, err)
	}
}

func TestParseCollaborationJSON_RejectsAmbiguousOrMalformedInput(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"empty", `{}`, "must include"},
		{"null", `{"role":null}`, "cannot be null"},
		{"blank origin", `{"role":{"uid":"` + collaborationTestUID + `","origin":" "}}`, "cannot contain whitespace"},
		{"local", `{"role":{"uid":"` + collaborationTestUID + `","origin":"local"}}`, "normalized host"},
		{"url", `{"role":{"uid":"` + collaborationTestUID + `","origin":"https://host"}}`, "normalized host"},
		{"lower uid", `{"role":{"uid":"01arz3ndektsv4rrffq69g5fav","origin":"host"}}`, "canonical uppercase"},
		{"unknown", `{"extra":true,"role":{"uid":"` + collaborationTestUID + `","origin":"host"}}`, "unknown field"},
		{"mixed shape", `{"role":{"uid":"` + collaborationTestUID + `"},"vizier":[]}`, "unknown field"},
		{"null roster", `{"vizier":null}`, "cannot be null"},
		{"duplicate participant", `{"vizier":["fable","fable"]}`, "repeats collaborator"},
		{"bad slug", `{"roles/vizier":["fable"]}`, "role slug"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseCollaborationJSON(tc.raw)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("ParseCollaborationJSON(%s) error = %v, want %q", tc.raw, err, tc.want)
			}
		})
	}
}

func FuzzParseCollaborationJSON(f *testing.F) {
	for _, seed := range []string{
		`{"role":{"uid":"` + collaborationTestUID + `"}}`,
		`{"collaborator":{"uid":"` + collaborationTestUID + `","origin":"old-host"}}`,
		`{"vizier":["fable","astra"],"organizer":[]}`,
		`{"role":[],"collaborator":[]}`,
		`{}`, `null`, `[]`, `{"role":null}`, `{"role":{"uid":"../x"}}`,
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		c, err := ParseCollaborationJSON(raw)
		if err == nil {
			if e := c.Validate(); e != nil {
				t.Fatalf("accepted invalid value: %v", e)
			}
		}
	})
}
