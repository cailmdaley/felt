package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

// writeFiber announces successful local writes without making the daemon a dependency.
func (a *app) writeFiber(st *felt.Storage, f *felt.Felt) error {
	if st == nil {
		return fmt.Errorf("fiber %s has no local storage; route the write to its execution owner", f.ID)
	}
	if err := st.Write(f); err != nil {
		return err
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
