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
	"strings"
	"sync"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
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

func conferStateDir(env *sysenv.Env) string {
	if p := env.Getenv("SHUTTLE_CONFER_STATE_DIR"); p != "" {
		return p
	}
	h, _ := env.UserHomeDir()
	return filepath.Join(h, ".local/state/confer-agent")
}
func liveSocket(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode()&os.ModeSocket != 0
}
func (piAdapter) discover(ctx context.Context, env *sysenv.Env, host string) ([]Session, error) {
	hookSessions := mailboxSessions(env, "pi", host)
	nativeSessions := piNativeSessions(env, host)
	nativeIDs := make(map[string]bool, len(nativeSessions))
	for _, session := range nativeSessions {
		nativeIDs[session.ID] = true
	}
	ss := mergeSessions(nativeSessions, hookSessions)
	jobs, err := liveConferJobs(ctx, conferStateDir(env), func(string) bool { return true })
	var conferSessions []Session
	for _, j := range jobs {
		if nativeIDs[j.SessionID] || nativeIDs[j.PiSessionID] {
			continue
		}
		addr, _ := FormatAddress(host, "pi", j.ID)
		state := j.Phase
		if state == "" {
			state = j.Status
		}
		conferSessions = append(conferSessions, Session{Address: addr, Host: host, Harness: "pi", ID: j.ID, Title: j.Name, CWD: j.CWD, State: state, Capabilities: []string{"wake"}})
	}
	return mergeSessions(ss, conferSessions), err
}

func findPi(ctx context.Context, env *sysenv.Env, id string) (piJob, error) {
	jobs, err := liveConferJobs(ctx, conferStateDir(env), func(name string) bool { return name == id+".json" })
	if err != nil {
		return piJob{}, err
	}
	var matches []piJob
	for _, j := range jobs {
		if j.ID == id {
			matches = append(matches, j)
		}
	}
	if len(matches) == 0 {
		return piJob{}, fmt.Errorf("live Confer job %q not found", id)
	}
	if len(matches) > 1 {
		return piJob{}, fmt.Errorf("Confer job id %q is ambiguous across %d live workspaces", id, len(matches))
	}
	return matches[0], nil
}

// conferReadConcurrency bounds parallel job-record reads. On a network home
// directory each open costs a round trip, so reads overlap rather than queue.
const conferReadConcurrency = 16

// liveConferJobs returns the Confer jobs under root whose records parse and
// whose socket is live. Confer keeps one record per job at
// <root>/<workspace>/jobs/<job>.json, beside a <job>/ directory of session
// state that discovery never needs, so only those two directory levels are
// listed. keep filters record file names before they are read. A missing root
// is no jobs; a cancelled context returns what was read with its error.
func liveConferJobs(ctx context.Context, root string, keep func(string) bool) ([]piJob, error) {
	workspaces, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var paths []string
	for _, ws := range workspaces {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !ws.IsDir() {
			continue
		}
		dir := filepath.Join(root, ws.Name(), "jobs")
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") && keep(e.Name()) {
				paths = append(paths, filepath.Join(dir, e.Name()))
			}
		}
	}
	results := make([]*piJob, len(paths))
	sem := make(chan struct{}, conferReadConcurrency)
	var wg sync.WaitGroup
	for i, path := range paths {
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			if ctx.Err() != nil {
				return
			}
			b, err := readBounded(path, 512<<10)
			if err != nil {
				return
			}
			var j piJob
			if json.Unmarshal(b, &j) != nil || j.ID == "" || j.SocketPath == "" || !liveSocket(j.SocketPath) {
				return
			}
			results[i] = &j
		}()
	}
	wg.Wait()
	var jobs []piJob
	for _, j := range results {
		if j != nil {
			jobs = append(jobs, *j)
		}
	}
	return jobs, ctx.Err()
}
func (piAdapter) send(ctx context.Context, env *sysenv.Env, a Address, r Request) (Receipt, error) {
	if !r.Wake {
		if MailboxAvailable(env, "pi", a.ID, a.Host) {
			return queueMailbox(env, a, r)
		}
		return rejected(r, "pi-rpc+unix-socket", "Confer messages can start a turn; wake is required"), errCode("wake_required", "Confer requires wake=true")
	}
	if piNativeAvailable(env, a.ID, a.Host) {
		return sendPiNative(ctx, env, a, r)
	}
	j, err := findPi(ctx, env, a.ID)
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
	if err := publishOwnerDeadline(ctx, deadline); err != nil {
		return rejected(r, "pi-rpc+unix-socket", "cannot persist delivery deadline"), errCode("preflight_failed", "cannot persist Pi delivery deadline")
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
