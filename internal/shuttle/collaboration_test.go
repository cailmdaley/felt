package shuttle

import (
	"strings"
	"testing"
)

const collaborationTestUID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

func TestParseCollaborationJSON_ValidatesOwnerAddressedReferences(t *testing.T) {
	c, err := ParseCollaborationJSON(`{"collaborator":{"uid":"01ARZ3NDEKTSV4RRFFQ69G5FAV","origin":"hub-1"},"role":{"uid":"01ARZ3NDEKTSV4RRFFQ69G5FAV","origin":"remote_2"}}`)
	if err != nil {
		t.Fatalf("ParseCollaborationJSON: %v", err)
	}
	if c.Collaborator == nil || c.Role == nil || c.Collaborator.Origin != "hub-1" || c.Role.Origin != "remote_2" {
		t.Fatalf("parsed collaboration = %#v", c)
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
		{"missing origin", `{"role":{"uid":"` + collaborationTestUID + `"}}`, "origin is required"},
		{"local", `{"role":{"uid":"` + collaborationTestUID + `","origin":"local"}}`, "normalized host"},
		{"url", `{"role":{"uid":"` + collaborationTestUID + `","origin":"https://host"}}`, "normalized host"},
		{"lower uid", `{"role":{"uid":"01arz3ndektsv4rrffq69g5fav","origin":"host"}}`, "canonical uppercase"},
		{"unknown", `{"extra":true,"role":{"uid":"` + collaborationTestUID + `","origin":"host"}}`, "unknown field"},
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
