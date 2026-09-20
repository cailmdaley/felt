package messaging

import (
	"context"
	"os"
	"testing"
)

func TestPiWakeAcknowledgements(t *testing.T) {
	for _, tc := range []struct {
		name, reply, status string
	}{
		{"steer", `{"ok":true,"delivery":"steer"}`, StatusAccepted},
		{"follow up", `{"ok":true,"delivery":"follow_up"}`, StatusAccepted},
		{"unsupported delivery", `{"ok":true,"delivery":"queued"}`, StatusUnknown},
		{"ack timeout", `{"ok":false,"delivery":"follow_up","error":"Timed out waiting for Pi to acknowledge prompt."}`, StatusUnknown},
		{"undifferentiated error", `{"ok":false,"error":"worker exited"}`, StatusUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, socket := piFixture(t, tc.reply+"\n")
			t.Setenv("SHUTTLE_CONFER_STATE_DIR", root)
			t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
			req := Request{Address: "shuttle://h/pi/job-1", Text: "do work", MessageID: "pi-wake", Wake: true}
			receipt, err := Send(context.Background(), "h", req)
			if receipt.Status != tc.status || (err != nil) != (tc.status == StatusUnknown) {
				t.Fatalf("%#v, %v", receipt, err)
			}
			if tc.status == StatusUnknown && ErrorCode(err) != "ambiguous_delivery" {
				t.Fatalf("error = %v", err)
			}
			// Removing the endpoint proves that retry reads the durable receipt
			// instead of attempting another prompt, even for unknown outcomes.
			if err := os.Remove(socket); err != nil {
				t.Fatal(err)
			}
			retry, retryErr := Send(context.Background(), "h", req)
			if retry.Status != receipt.Status || ErrorCode(retryErr) != ErrorCode(err) {
				t.Fatalf("retry: %#v, %v", retry, retryErr)
			}
		})
	}
}
