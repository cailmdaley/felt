package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// writeFiber announces successful local writes without making the daemon a dependency.
func (a *app) writeFiber(st *felt.Storage, f *felt.Felt) error {
	if st == nil {
		return fmt.Errorf("fiber %s has no local storage; route the write to its execution owner", f.ID)
	}
	if a.localMirror {
		if err := shuttle.SetRuntimeField(f, "mirrored_at", time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}
	if err := st.Write(f); err != nil {
		return err
	}
	if a.localMirror {
		fmt.Fprintln(a.env.Stdout, "Saved a local exit copy. This write travels by Git; no execution request was sent.")
	}
	endpoint, err := a.daemonEndpoint("/api/v1/document-changed")
	if err != nil {
		return nil
	}
	body, err := json.Marshal(map[string]string{"fiber_id": f.UID})
	if err != nil {
		return nil
	}
	resp, err := a.daemonHTTPClient(500*time.Millisecond).Post(endpoint, "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
	return nil
}
