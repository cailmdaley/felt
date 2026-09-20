package messaging

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestPiWakeAcknowledgements(t *testing.T) {
	for _, tc := range []struct {
		name, reply, status string
	}{
		{"old steer", `{"ok":true,"delivery":"steer"}`, StatusUnknown},
		{"old follow up", `{"ok":true,"delivery":"follow_up"}`, StatusUnknown},
		{"unsupported delivery", `{"ok":true,"delivery":"queued"}`, StatusUnknown},
		{"ack timeout", `{"ok":false,"delivery":"follow_up","error":"Timed out waiting for Pi to acknowledge prompt."}`, StatusUnknown},
		{"undifferentiated error", `{"ok":false,"error":"worker exited"}`, StatusUnknown},
		{"correlated refusal", `{"ok":false,"phase":"rpc_rejected","jobId":"job-1","requestId":"rpc-1","rpcType":"prompt","error":"held"}`, StatusRejected},
		{"correlated timeout", `{"ok":false,"phase":"after_send","jobId":"job-1","requestId":"rpc-1","rpcType":"prompt","error":"timeout"}`, StatusUnknown},
		{"missing evidence", `{"ok":false,"phase":"rpc_rejected","error":"held"}`, StatusUnknown},
		{"wrong job refusal", `{"ok":false,"phase":"rpc_rejected","jobId":"another","requestId":"rpc-1","rpcType":"prompt"}`, StatusUnknown},
		{"wrong command refusal", `{"ok":false,"phase":"rpc_rejected","jobId":"job-1","requestId":"rpc-1","rpcType":"abort"}`, StatusUnknown},
		{"correlated accepted", `{"ok":true,"phase":"rpc_acknowledged","jobId":"job-1","requestId":"rpc-1","rpcType":"prompt","delivery":"follow_up"}`, StatusAccepted},
		{"correlated steer", `{"ok":true,"phase":"rpc_acknowledged","jobId":"job-1","requestId":"rpc-1","rpcType":"prompt","delivery":"steer"}`, StatusAccepted},
		{"missing accepted phase", `{"ok":true,"jobId":"job-1","requestId":"rpc-1","rpcType":"prompt","delivery":"follow_up"}`, StatusUnknown},
		{"missing accepted job", `{"ok":true,"phase":"rpc_acknowledged","requestId":"rpc-1","rpcType":"prompt","delivery":"follow_up"}`, StatusUnknown},
		{"missing accepted request", `{"ok":true,"phase":"rpc_acknowledged","jobId":"job-1","rpcType":"prompt","delivery":"follow_up"}`, StatusUnknown},
		{"missing accepted command", `{"ok":true,"phase":"rpc_acknowledged","jobId":"job-1","requestId":"rpc-1","delivery":"follow_up"}`, StatusUnknown},
		{"wrong accepted command", `{"ok":true,"phase":"rpc_acknowledged","jobId":"job-1","requestId":"rpc-1","rpcType":"abort","delivery":"follow_up"}`, StatusUnknown},
		{"wrong job accepted", `{"ok":true,"phase":"rpc_acknowledged","jobId":"another","requestId":"rpc-1","rpcType":"prompt","delivery":"follow_up"}`, StatusUnknown},
		{"old worker wrong job", `{"ok":true,"jobId":"another","delivery":"follow_up"}`, StatusUnknown},
		{"wrong accepted phase", `{"ok":true,"phase":"after_send","jobId":"job-1","requestId":"rpc-1","rpcType":"prompt","delivery":"follow_up"}`, StatusUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, socket := piFixture(t, tc.reply+"\n")
			t.Setenv("SHUTTLE_CONFER_STATE_DIR", root)
			t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
			req := Request{Address: "shuttle://h/pi/job-1", Text: "do work", MessageID: "pi-wake", Wake: true}
			data := []byte{0, 255, 42}
			req.Attachments = []Attachment{testAttachment("input.bin", data)}
			receipt, err := Send(context.Background(), "h", req)
			if receipt.Status != tc.status || (err != nil) != (tc.status != StatusAccepted) {
				t.Fatalf("%#v, %v", receipt, err)
			}
			if tc.status == StatusUnknown && ErrorCode(err) != "ambiguous_delivery" {
				t.Fatalf("error = %v", err)
			}
			if tc.status == StatusRejected && ErrorCode(err) != "native_rejected" {
				t.Fatalf("error = %v", err)
			}
			if (tc.name == "old steer" || tc.name == "old follow up") && !strings.Contains(receipt.Detail, "update Confer workers") {
				t.Fatalf("missing upgrade guidance: %#v", receipt)
			}
			// Removing the endpoint proves that retry reads the durable receipt
			// instead of attempting another prompt, even for unknown outcomes.
			if err := os.Remove(socket); err != nil {
				t.Fatal(err)
			}
			retry, retryErr := Send(context.Background(), "h", req)
			if !reflect.DeepEqual(retry, receipt) || ErrorCode(retryErr) != ErrorCode(err) {
				t.Fatalf("retry: %#v, %v", retry, retryErr)
			}
		})
	}
}

func TestPiPreflightEvidence(t *testing.T) {
	for _, tc := range []struct{ reply, status, code string }{
		{`{"ok":false,"phase":"preflight","jobId":"job-1","requestId":"rpc-1","rpcType":"prompt","error":"closed"}`, StatusRejected, "preflight_failed"},
		{`{"ok":false,"phase":"preflight","jobId":"wrong","requestId":"rpc-1","rpcType":"prompt","error":"closed"}`, StatusUnknown, "ambiguous_delivery"},
	} {
		root, _ := piFixture(t, tc.reply+"\n")
		t.Setenv("SHUTTLE_CONFER_STATE_DIR", root)
		req := Request{Address: "shuttle://h/pi/job-1", Text: "do work", MessageID: "preflight", Wake: true}
		receipt, err := (piAdapter{}).send(context.Background(), Address{ID: "job-1"}, req)
		if receipt.Status != tc.status || ErrorCode(err) != tc.code {
			t.Fatalf("receipt=%#v err=%v", receipt, err)
		}
	}
}
