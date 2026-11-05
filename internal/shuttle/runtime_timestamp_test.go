package shuttle

import (
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestRuntimeTimestamp(t *testing.T) {
	t.Parallel()
	want, _ := time.Parse(time.RFC3339Nano, "2026-11-02T08:00:00.123456Z")
	for _, doc := range []string{
		"dispatched_at: 2026-11-02T08:00:00.123456Z\n",
		"dispatched_at: \"2026-11-02T08:00:00.123456Z\"\n",
	} {
		var runtime map[string]any
		if err := yaml.Unmarshal([]byte(doc), &runtime); err != nil {
			t.Fatal(err)
		}
		if got := RuntimeTimestamp(runtime["dispatched_at"]); !got.Equal(want) {
			t.Fatalf("%q: got %v, want %v", doc, got, want)
		}
	}
	for _, value := range []any{nil, "", "not a timestamp", 42} {
		if got := RuntimeTimestamp(value); !got.IsZero() {
			t.Fatalf("%#v: invalid value became %v", value, got)
		}
	}
}
