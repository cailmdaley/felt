package shuttlecli

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestInstallAnnouncesLocalWrite(t *testing.T) {
	env := testEnv(t)
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")
	id := mustRead(t, storage, "task").UID
	var got string
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/document-changed" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			return
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		got = body["fiber_id"]
	}))
	if out, err := runIn(t, env, dir, "install", "task", "--host", "testhost", "--disabled"); err != nil {
		t.Fatalf("install: %v\n%s", err, out)
	}
	if got != id {
		t.Fatalf("announced %q, want %q", got, id)
	}
}
