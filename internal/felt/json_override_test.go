package felt

import (
	"encoding/json"
	"testing"
)

func TestSetJSONFieldOverridesTopLevelValueWithoutChangingFrontmatter(t *testing.T) {
	fiber, err := New("plain", "Plain")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := fiber.SetExtraField("custom", map[string]any{"stored": true}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	fiber.SetJSONField("custom", map[string]any{"projected": true})
	fiber.SetJSONField("computed", "read-only")

	data, err := json.Marshal(fiber)
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	var encoded map[string]any
	if err := json.Unmarshal(data, &encoded); err != nil {
		t.Fatalf("Unmarshal JSON: %v", err)
	}
	if got := encoded["custom"].(map[string]any)["projected"]; got != true {
		t.Fatalf("custom JSON field = %v, want projected override", encoded["custom"])
	}
	if encoded["computed"] != "read-only" {
		t.Fatalf("computed JSON field = %v, want override", encoded["computed"])
	}
	if got, ok := fiber.JSONField("custom"); !ok || got.(map[string]any)["projected"] != true {
		t.Fatalf("JSONField(custom) = %v, %v", got, ok)
	}

	frontmatter, err := fiber.Marshal()
	if err != nil {
		t.Fatalf("Marshal frontmatter: %v", err)
	}
	parsed, err := Parse(fiber.ID, frontmatter)
	if err != nil {
		t.Fatalf("Parse frontmatter: %v", err)
	}
	stored, ok := parsed.ExtraFields["custom"]
	if !ok {
		t.Fatal("custom frontmatter field was not persisted")
	}
	var value map[string]any
	if err := stored.Decode(&value); err != nil {
		t.Fatalf("decode persisted custom field: %v", err)
	}
	if value["stored"] != true || value["projected"] != nil {
		t.Fatalf("persisted custom field = %#v, want original frontmatter", value)
	}
}
