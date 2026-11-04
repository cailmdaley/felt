package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestUIDCandidateParseFailureIsNotAbsence(t *testing.T) {
	t.Parallel()
	root, st := newStore(t)
	uid := "01ARZ3NDEKTSV4RRFFQ69G5FAX"
	path := st.Path("a/worker")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nid: "+uid+"\nname: Worker\n<<<<<<< HEAD\nstatus: open\n=======\nstatus: active\n>>>>>>> branch\n---\nBody\n"), 0644); err != nil {
		t.Fatal(err)
	}
	out, _, err := executeCLI(t, root, "show", uid, "--exact", "-j")
	if err == nil {
		t.Fatal("unparseable identity resolved")
	}
	var response map[string]any
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		t.Fatal(err)
	}
	if response["error_code"] == "not_found" {
		t.Fatalf("matching corrupt UID reported absent: %s", out)
	}
	if _, err := st.FindMetadataInScope("", uid); err == nil {
		t.Fatal("convenient UID lookup swallowed parse failure")
	}
}
