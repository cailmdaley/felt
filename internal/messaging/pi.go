package messaging

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type piAdapter struct{}
type piReply struct {
	OK                               bool
	Delivery, Error                  string
	Phase, JobID, RequestID, RPCType string
}

func decodePiReply(b []byte) (piReply, error) {
	if len(b) > 64<<10 {
		return piReply{}, fmt.Errorf("reply exceeds 65536 bytes")
	}
	var wire struct {
		OK        *bool  `json:"ok"`
		Delivery  string `json:"delivery"`
		Error     string `json:"error"`
		Phase     string `json:"phase"`
		JobID     string `json:"jobId"`
		RequestID string `json:"requestId"`
		RPCType   string `json:"rpcType"`
	}
	d := json.NewDecoder(bytes.NewReader(b))
	if err := d.Decode(&wire); err != nil {
		return piReply{}, err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return piReply{}, fmt.Errorf("trailing JSON data")
	}
	if wire.OK == nil {
		return piReply{}, fmt.Errorf("missing boolean ok")
	}
	if *wire.OK && wire.Delivery != "steer" && wire.Delivery != "follow_up" {
		return piReply{}, fmt.Errorf("unsupported delivery acknowledgement")
	}
	return piReply{OK: *wire.OK, Delivery: wire.Delivery, Error: wire.Error, Phase: wire.Phase, JobID: wire.JobID, RequestID: wire.RequestID, RPCType: wire.RPCType}, nil
}

type piJob struct {
	ID, Name, Status, Phase, CWD, SocketPath string
	WorkerPID                                int    `json:"workerPid"`
	Host                                     string `json:"host"`
	SessionID                                string `json:"sessionId"`
	PiSessionID                              string `json:"piSessionId"`
}

func mergePiSessions(primary, additions []Session) []Session {
	seen := make(map[string]bool, len(primary)+len(additions))
	merged := make([]Session, 0, len(primary)+len(additions))
	for _, session := range append(primary, additions...) {
		if seen[session.Address] {
			continue
		}
		seen[session.Address] = true
		merged = append(merged, session)
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].Address < merged[j].Address })
	return merged
}

func conferStateDir() string {
	if p := os.Getenv("SHUTTLE_CONFER_STATE_DIR"); p != "" {
		return p
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".local/state/confer-agent")
}
func liveSocket(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode()&os.ModeSocket != 0
}
func (piAdapter) discover(ctx context.Context, host string) ([]Session, error) {
	hookSessions := MailboxSessions("pi", host)
	nativeSessions := piNativeSessions(host)
	nativeIDs := make(map[string]bool, len(nativeSessions))
	for _, session := range nativeSessions {
		nativeIDs[session.ID] = true
	}
	root := conferStateDir()
	ss := mergeNativeAndHookSessions(nativeSessions, hookSessions)
	var conferSessions []Session
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if err != nil {
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(path, ".json") || filepath.Base(filepath.Dir(path)) != "jobs" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		b, e := readBoundedFile(path, 512<<10)
		if e != nil {
			return nil
		}
		var j piJob
		if json.Unmarshal(b, &j) != nil || j.ID == "" || j.SocketPath == "" || !liveSocket(j.SocketPath) {
			return nil
		}
		if nativeIDs[j.SessionID] || nativeIDs[j.PiSessionID] {
			return nil
		}
		addr, _ := FormatAddress(host, "pi", j.ID)
		state := j.Phase
		if state == "" {
			state = j.Status
		}
		conferSessions = append(conferSessions, Session{Address: addr, Host: host, Harness: "pi", ID: j.ID, Title: j.Name, CWD: j.CWD, State: state, Capabilities: []string{"wake"}})
		return nil
	})
	if os.IsNotExist(err) {
		return ss, nil
	}
	return mergePiSessions(ss, conferSessions), err
}
func findPi(ctx context.Context, id string) (piJob, error) {
	var matches []piJob
	err := filepath.WalkDir(conferStateDir(), func(path string, d os.DirEntry, err error) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if err != nil {
			return nil
		}
		if d.IsDir() || filepath.Base(path) != id+".json" || filepath.Base(filepath.Dir(path)) != "jobs" {
			return nil
		}
		b, e := readBoundedFile(path, 512<<10)
		if e != nil {
			return nil
		}
		var j piJob
		if json.Unmarshal(b, &j) == nil && j.ID == id && liveSocket(j.SocketPath) {
			matches = append(matches, j)
		}
		return nil
	})
	if err != nil {
		return piJob{}, err
	}
	if len(matches) == 0 {
		return piJob{}, fmt.Errorf("live Confer job %q not found", id)
	}
	if len(matches) > 1 {
		return piJob{}, fmt.Errorf("Confer job id %q is ambiguous across %d live workspaces", id, len(matches))
	}
	return matches[0], nil
}
func readBoundedFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err == nil && int64(len(b)) > limit {
		return nil, fmt.Errorf("file exceeds %d bytes", limit)
	}
	return b, err
}
func (piAdapter) send(ctx context.Context, a Address, r Request) (Receipt, error) {
	if !r.Wake {
		if MailboxAvailable("pi", a.ID, a.Host) {
			return QueueMailbox(a, r)
		}
		return rejected(r, "pi-rpc+unix-socket", "Confer messages can start a turn; wake is required"), errCode("wake_required", "Confer requires wake=true")
	}
	if piNativeAvailable(a.ID, a.Host) {
		return sendPiNative(ctx, a, r)
	}
	j, err := findPi(ctx, a.ID)
	if err != nil {
		return rejected(r, "pi-rpc+unix-socket", err.Error()), errCode("session_not_found", "%v", err)
	}
	d := net.Dialer{Timeout: 2 * time.Second}
	c, err := d.DialContext(ctx, "unix", j.SocketPath)
	if err != nil {
		return rejected(r, "pi-rpc+unix-socket", "worker socket unavailable"), errCode("preflight_failed", "worker socket unavailable: %v", err)
	}
	defer c.Close()
	deadline := time.Now().Add(5 * time.Second)
	if x, ok := ctx.Deadline(); ok && x.Before(deadline) {
		deadline = x
	}
	c.SetDeadline(deadline)
	if err = json.NewEncoder(c).Encode(map[string]any{"type": "msg", "message": labeled(r)}); err != nil {
		return Receipt{}, err
	}
	line, err := bufio.NewReaderSize(io.LimitReader(c, (64<<10)+1), 4096).ReadBytes('\n')
	if err != nil {
		return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusUnknown, Transport: "pi-rpc+unix-socket", Detail: "worker reply was not received"}, errCode("ambiguous_delivery", "Confer delivery outcome unknown: %v", err)
	}
	if len(line) > 64<<10 {
		return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusUnknown, Transport: "pi-rpc+unix-socket", Detail: "worker reply exceeded limit"}, errCode("ambiguous_delivery", "Confer reply exceeded limit")
	}
	resp, decodeErr := decodePiReply(line)
	if decodeErr != nil {
		return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusUnknown, Transport: "pi-rpc+unix-socket", Detail: "worker returned malformed reply"}, errCode("ambiguous_delivery", "Confer returned malformed reply")
	}
	if resp.JobID != "" && resp.JobID != j.ID {
		return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusUnknown, Transport: "pi-rpc+unix-socket", Detail: "worker reply identified a different session"}, errCode("ambiguous_delivery", "Confer reply session identity mismatch")
	}
	if !resp.OK {
		if resp.JobID == j.ID && resp.RequestID != "" && resp.RPCType == "prompt" {
			if resp.Phase == "preflight" {
				return rejected(r, "pi-rpc+unix-socket", resp.Error), errCode("preflight_failed", "Confer refused before sending: %s", resp.Error)
			}
			if resp.Phase == "rpc_rejected" {
				return rejected(r, "pi-rpc+unix-socket", resp.Error), errCode("native_rejected", "Pi rejected prompt: %s", resp.Error)
			}
		}
		// Undifferentiated errors and missing receiver evidence cannot prove
		// that no turn ran, including replies from workers without phase fields.
		return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusUnknown, Transport: "pi-rpc+unix-socket", Detail: "worker did not confirm delivery: " + resp.Error}, errCode("ambiguous_delivery", "Confer delivery outcome unknown: %s", resp.Error)
	}
	if resp.Phase != "rpc_acknowledged" || resp.JobID != j.ID || resp.RequestID == "" || resp.RPCType != "prompt" {
		detail := "worker acknowledgement lacks correlated native evidence; update Confer workers before sending further task handoffs; this message may have run"
		return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusUnknown, Transport: "pi-rpc+unix-socket", Detail: detail}, errCode("ambiguous_delivery", "%s", detail)
	}
	return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusAccepted, Transport: "pi-rpc+unix-socket", Detail: resp.Delivery}, nil
}
