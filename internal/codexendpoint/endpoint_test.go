package codexendpoint

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedEndpointFixtures(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../daemon/test/fixtures/codex_endpoints.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Hostname, Override, Want string
		UID                            int
		Error                          bool
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			got, err := Resolve(tc.Override, tc.UID, tc.Hostname)
			if (err != nil) != tc.Error || got != tc.Want {
				t.Fatalf("got %q, %v; want %q, error=%v", got, err, tc.Want, tc.Error)
			}
		})
	}
}
