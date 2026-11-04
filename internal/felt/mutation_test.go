package felt

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestMutationAddsNestedAndRootFieldsAtTheSameBoundary(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeFiberFile(t, s, "f", "---\nid: fixture-f\nname: F\ncustom:\n  nested: keep\n---\n\nBody.\n")
	_, err := s.Update("f", func(f *Felt) error {
		if err := f.SetExtraField("z-field", "root"); err != nil {
			return err
		}
		child := f.ExtraFields["custom"]
		child.Content = append(child.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: "added"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "child"})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Read("f")
	if err != nil {
		t.Fatal(err)
	}
	if got.ExtraFields["z-field"].Value != "root" || MappingValueNode(got.ExtraFields["custom"], "added").Value != "child" {
		t.Fatalf("fields lost: %+v", got)
	}
	raw, _ := os.ReadFile(s.Path("f"))
	if !strings.Contains(string(raw), "  added: child\nz-field: root\n") {
		t.Fatalf("nested insertion crossed its mapping boundary:\n%s", raw)
	}
}
