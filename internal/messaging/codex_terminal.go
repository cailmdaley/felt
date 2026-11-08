package messaging

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv"
)

const codexTerminalInputRoute = "/api/v1/sessions/input"
const codexTerminalReceiverRoute = "/api/v1/sessions/receiver"

func discoverCodexTerminalReceiver(ctx context.Context, env *sysenv.Env, address Address) error {
	if MailboxAvailable(env, "codex", address.ID, address.Host) {
		return nil
	}
	return discoverCodexTerminalReceiverWithClient(ctx, env, address, nil)
}

func discoverCodexTerminalReceiverWithClient(ctx context.Context, env *sysenv.Env, address Address, client *http.Client) error {
	endpoint, socket, err := codexDaemonEndpoint(env)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(struct {
		SessionUUID string `json:"session_uuid"`
	}{address.ID})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+codexTerminalReceiverRoute, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if client == nil {
		client = codexTerminalHTTPClient(socket)
		defer client.CloseIdleConnections()
	}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("resolving the live Codex receiver: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 16<<10))
	if err != nil {
		return fmt.Errorf("reading live Codex receiver receipt: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			detail = response.Status
		}
		return fmt.Errorf("live Codex receiver unavailable: %s", detail)
	}
	var result struct {
		SessionUUID  string `json:"session_uuid"`
		PID          int    `json:"pid"`
		ProcessStart string `json:"process_start"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.SessionUUID != address.ID || result.PID <= 0 || result.ProcessStart == "" {
		return fmt.Errorf("daemon returned an invalid live Codex receiver identity")
	}
	if processStartToken(result.PID) != result.ProcessStart {
		return fmt.Errorf("live Codex receiver process changed during lookup")
	}
	if err := RegisterMailbox(env, "codex", address.ID, address.Host, "", result.PID, true); err != nil {
		return fmt.Errorf("registering live Codex receiver: %w", err)
	}
	registered, err := mailboxRegistrationFor(env, "codex", address.ID)
	if err != nil || registered.PID != result.PID || registered.Start != result.ProcessStart || registered.Host != address.Host || registered.Ended {
		return fmt.Errorf("live Codex receiver identity changed during registration")
	}
	return nil
}

func submitCodexTerminalInput(ctx context.Context, env *sysenv.Env, address Address, request Request) (Receipt, error) {
	return submitCodexTerminalInputWithClient(ctx, env, address, request, nil)
}

func submitCodexTerminalInputWithClient(ctx context.Context, env *sysenv.Env, address Address, request Request, client *http.Client) (Receipt, error) {
	receipt := Receipt{MessageID: request.MessageID, Address: request.Address, Transport: "codex-terminal"}
	endpoint, socket, err := codexDaemonEndpoint(env)
	if err != nil {
		return rejected(request, receipt.Transport, err.Error()), errCode("preflight_failed", "%v", err)
	}
	payload, err := json.Marshal(struct {
		SessionUUID string `json:"session_uuid"`
		Text        string `json:"text"`
	}{address.ID, Labeled(request)})
	if err != nil {
		return rejected(request, receipt.Transport, err.Error()), err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+codexTerminalInputRoute, bytes.NewReader(payload))
	if err != nil {
		return rejected(request, receipt.Transport, err.Error()), err
	}
	req.Header.Set("Content-Type", "application/json")
	if client == nil {
		client = codexTerminalHTTPClient(socket)
		defer client.CloseIdleConnections()
	}
	response, err := client.Do(req)
	if err != nil {
		receipt.Status = StatusUnknown
		receipt.Detail = "terminal input outcome is unknown: " + err.Error()
		return receipt, errCode("ambiguous_delivery", "%s", receipt.Detail)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		receipt.Status = StatusUnknown
		receipt.Detail = "terminal input outcome is unknown: could not read daemon receipt"
		return receipt, errCode("ambiguous_delivery", "%s", receipt.Detail)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			detail = response.Status
		}
		return rejected(request, receipt.Transport, detail), errCode("preflight_failed", "terminal input refused: %s", detail)
	}
	var result struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.Status != StatusSubmitted {
		receipt.Status = StatusUnknown
		receipt.Detail = "terminal input returned no confirmed submission receipt"
		return receipt, errCode("ambiguous_delivery", "%s", receipt.Detail)
	}
	receipt.Status = StatusSubmitted
	receipt.Detail = "message pasted into the Codex terminal"
	return receipt, nil
}

// codexDaemonEndpoint is the local daemon's base URL, and the socket to dial
// for it when it listens on one: SHUTTLE_DAEMON_URL when set, else the host's
// listener (shuttle.ResolveHostConfig).
func codexDaemonEndpoint(env *sysenv.Env) (string, string, error) {
	if override := strings.TrimRight(env.Getenv("SHUTTLE_DAEMON_URL"), "/"); override != "" {
		u, err := url.Parse(override)
		if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || !loopbackHost(u.Hostname()) {
			return "", "", fmt.Errorf("SHUTTLE_DAEMON_URL must be a loopback http URL")
		}
		return override, "", nil
	}
	config, err := shuttle.ResolveHostConfig(env)
	if err != nil {
		return "", "", fmt.Errorf("resolving the Shuttle daemon listener: %w", err)
	}
	if config.Listen.Network == "unix" {
		return config.Listen.BaseURL(), config.Listen.Address, nil
	}
	return config.Listen.BaseURL(), "", nil
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func codexTerminalHTTPClient(socket string) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	if socket != "" {
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socket)
		}
	}
	return &http.Client{Timeout: 10 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return fmt.Errorf("Shuttle daemon redirected terminal input")
	}}
}
