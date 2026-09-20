package cmd

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

var (
	sessionsDiscoveryLocal   bool
	sessionsDiscoveryHost    string
	sessionsDiscoveryHarness string

	messageLocal       bool
	messageFile        string
	messageWake        bool
	messageFrom        string
	messageID          string
	messageRequestJSON bool
	messageAttachments []string
)

const maxMessageRequestFrame = messaging.MaxRequestFrame
const maxMessageReceiptBytes = 512 << 10

func runShuttleSessionDiscovery(ctx context.Context) error {
	var (
		directory messaging.Directory
		err       error
	)
	if sessionsDiscoveryLocal {
		host, hostErr := resolveOwnHost("")
		if hostErr != nil {
			return hostErr
		}
		directory = messaging.Discover(ctx, host)
	} else {
		u, parseErr := url.Parse(daemonURL() + "/api/v1/peers")
		if parseErr != nil {
			return parseErr
		}
		q := u.Query()
		if sessionsDiscoveryHost != "" {
			q.Set("host", sessionsDiscoveryHost)
		}
		if sessionsDiscoveryHarness != "" {
			q.Set("harness", sessionsDiscoveryHarness)
		}
		u.RawQuery = q.Encode()
		directory, err = getDaemonJSON[messaging.Directory](u.String(), "parsing peer directory")
	}
	if err != nil {
		return fmt.Errorf("discovering sessions: %w", err)
	}
	directory = filterPeerDirectory(directory, sessionsDiscoveryHost, sessionsDiscoveryHarness)
	if jsonOutput {
		return outputJSON(directory)
	}
	printPeerDirectory(directory)
	return nil
}

func filterPeerDirectory(directory messaging.Directory, host, harness string) messaging.Directory {
	host = strings.TrimSpace(host)
	harness = strings.TrimSpace(harness)
	filtered := directory.Sessions[:0]
	for _, session := range directory.Sessions {
		if host != "" && session.Host != host {
			continue
		}
		if harness != "" && session.Harness != harness {
			continue
		}
		filtered = append(filtered, session)
	}
	directory.Sessions = filtered
	if host != "" || harness != "" {
		gaps := directory.Gaps[:0]
		for _, gap := range directory.Gaps {
			if host != "" && gap.Host != host {
				continue
			}
			if harness != "" && gap.Harness != "" && gap.Harness != "*" && gap.Harness != harness {
				continue
			}
			gaps = append(gaps, gap)
		}
		directory.Gaps = gaps
	}
	sort.Slice(directory.Sessions, func(i, j int) bool {
		return directory.Sessions[i].Address < directory.Sessions[j].Address
	})
	return directory
}

func printPeerDirectory(directory messaging.Directory) {
	for _, session := range directory.Sessions {
		detail := session.Title
		if detail == "" {
			detail = session.CWD
		}
		fmt.Printf("%s\t%s\t%s\n", session.Address, session.State, detail)
	}
	for _, gap := range directory.Gaps {
		fmt.Fprintf(os.Stderr, "warning: %s/%s discovery failed: %s\n", gap.Host, gap.Harness, gap.Error)
	}
}

var shuttleMessageCmd = &cobra.Command{
	Use:   "message <address> [text|-]",
	Short: "Send a message and files to an existing session",
	Args: func(cmd *cobra.Command, args []string) error {
		if messageRequestJSON {
			if !messageLocal {
				return fmt.Errorf("--request-json requires --local")
			}
			if len(args) != 0 || messageFile != "" || messageWake || messageFrom != "" || messageID != "" || len(messageAttachments) != 0 {
				return fmt.Errorf("--request-json cannot be combined with positional text, --file, --attach, --wake, --from, or --message-id")
			}
			return nil
		}
		if len(args) < 1 || len(args) > 2 {
			return fmt.Errorf("expected an address and text, '-' for stdin, or --file <path>")
		}
		if messageFile == "" && len(args) != 2 && len(messageAttachments) == 0 {
			return fmt.Errorf("expected text, '-' for stdin, --file <path>, or --attach <path>")
		}
		if messageFile != "" && len(args) == 2 {
			return fmt.Errorf("text and --file are mutually exclusive")
		}
		return nil
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		request, err := buildMessageRequest(cmd.InOrStdin(), args)
		if err != nil {
			return err
		}
		id := request.MessageID
		var receipt messaging.Receipt
		if messageLocal {
			host, hostErr := resolveOwnHost("")
			if hostErr != nil {
				return hostErr
			}
			receipt, err = messaging.Send(cmd.Context(), host, request)
		} else {
			receipt, err = postMessage(request)
		}
		if receipt.MessageID == "" {
			receipt.MessageID = id
		}
		if receipt.Address == "" {
			receipt.Address = request.Address
		}
		if receipt.Status == "" && err != nil {
			receipt.Status = messaging.StatusUnknown
			if receipt.Transport == "" {
				receipt.Transport = "daemon"
			}
			if receipt.Detail == "" {
				receipt.Detail = err.Error()
			}
		}
		if messageRequestJSON {
			if outputErr := json.NewEncoder(cmd.OutOrStdout()).Encode(receipt); outputErr != nil {
				return outputErr
			}
		} else if jsonOutput {
			if outputErr := outputJSON(receipt); outputErr != nil {
				return outputErr
			}
		} else {
			fmt.Printf("%s %s (%s)\n", receipt.Status, receipt.Address, receipt.MessageID)
		}
		if err != nil {
			return fmt.Errorf("message %s: %w", id, err)
		}
		if receipt.Status == "unknown" || receipt.Status == "rejected" || receipt.Status == "" {
			return fmt.Errorf("message %s: %s", id, receipt.Status)
		}
		return nil
	},
}

func buildMessageRequest(stdin io.Reader, args []string) (messaging.Request, error) {
	if messageRequestJSON {
		return readMessageRequestFrame(stdin)
	}
	text, err := readMessageText(stdin, args)
	if err != nil {
		return messaging.Request{}, err
	}
	attachments, err := messaging.ReadAttachments(messageAttachments)
	if err != nil {
		return messaging.Request{}, err
	}
	id := strings.TrimSpace(messageID)
	if id == "" {
		id, err = newMessageID()
		if err != nil {
			return messaging.Request{}, err
		}
	}
	return messaging.Request{Address: args[0], Text: text, From: resolveMessageSender(messageFrom), Wake: messageWake, MessageID: id, Attachments: attachments}, nil
}

func readMessageRequestFrame(reader io.Reader) (messaging.Request, error) {
	var request messaging.Request
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maxMessageRequestFrame)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return request, fmt.Errorf("reading message request frame (maximum %d bytes): %w", maxMessageRequestFrame, err)
		}
		return request, fmt.Errorf("reading message request frame: empty stdin")
	}
	decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return request, fmt.Errorf("decoding message request frame: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return request, fmt.Errorf("decoding message request frame: trailing JSON value")
		}
		return request, fmt.Errorf("decoding message request frame: %w", err)
	}
	if strings.TrimSpace(request.MessageID) == "" {
		return request, fmt.Errorf("decoding message request frame: message_id is required")
	}
	return request, nil
}

func readMessageText(stdin io.Reader, args []string) (string, error) {
	if messageFile != "" {
		if messageFile == "-" {
			return readMessageInput(stdin)
		}
		file, err := os.Open(messageFile)
		if err != nil {
			return "", fmt.Errorf("reading message file: %w", err)
		}
		defer file.Close()
		return readMessageInput(file)
	}
	if len(args) < 2 {
		return "", nil
	}
	if args[1] == "-" {
		return readMessageInput(stdin)
	}
	return args[1], nil
}

func readMessageInput(reader io.Reader) (string, error) {
	data, err := io.ReadAll(io.LimitReader(reader, (64<<10)+1))
	if err != nil {
		return "", fmt.Errorf("reading message stdin: %w", err)
	}
	if len(data) > 64<<10 {
		return "", fmt.Errorf("message exceeds 65536 bytes")
	}
	return string(data), nil
}

func newMessageID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generating message id: %w", err)
	}
	return "msg-" + hex.EncodeToString(raw[:]), nil
}

func resolveMessageSender(explicit string) string {
	if explicit = strings.TrimSpace(explicit); explicit != "" {
		return explicit
	}
	for _, candidate := range []struct {
		key, label string
	}{
		{"CODEX_THREAD_ID", "codex"},
		{"CLAUDE_SESSION_ID", "claude"},
	} {
		if value := strings.TrimSpace(os.Getenv(candidate.key)); value != "" {
			if host, err := resolveOwnHost(""); err == nil {
				if address, err := messaging.FormatAddress(host, candidate.label, value); err == nil {
					return address
				}
			}
			return candidate.label + ":" + value
		}
	}
	return "external"
}

func postMessage(request messaging.Request) (messaging.Receipt, error) {
	var receipt messaging.Receipt
	payload, err := json.Marshal(request)
	if err != nil {
		return receipt, fmt.Errorf("encoding message: %w", err)
	}
	endpoint := daemonURL() + "/api/v1/messages"
	timeout := 30 * time.Second
	if len(request.Attachments) > 0 {
		// A distinct route makes old daemons refuse the entire send instead of
		// accepting text while silently discarding unsupported attachments.
		endpoint += "/files"
		timeout = 120 * time.Second
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Post(endpoint, "application/json", bytes.NewReader(payload))
	if err != nil {
		return receipt, fmt.Errorf("reaching daemon at %s: %w", daemonURL(), err)
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxMessageReceiptBytes+1))
	if readErr != nil {
		return receipt, fmt.Errorf("reading message receipt: %w", readErr)
	}
	if len(body) > maxMessageReceiptBytes {
		return receipt, fmt.Errorf("reading message receipt: body exceeds %d bytes", maxMessageReceiptBytes)
	}
	if len(body) != 0 {
		if decodeErr := json.Unmarshal(body, &receipt); decodeErr != nil {
			return messaging.Receipt{}, fmt.Errorf("parsing message receipt: %w", decodeErr)
		}
	}
	if receipt.MessageID == "" && resp.StatusCode >= 400 {
		return messaging.Receipt{}, daemonStatusError{url: endpoint, status: resp.StatusCode, body: strings.TrimSpace(string(body))}
	}
	if receipt.MessageID != request.MessageID || receipt.Address != request.Address || receipt.Transport == "" {
		return messaging.Receipt{}, fmt.Errorf("daemon returned a mismatched or incomplete message receipt; delivery is unknown")
	}
	switch receipt.Status {
	case messaging.StatusQueued, messaging.StatusAccepted, messaging.StatusContextAdded, messaging.StatusSubmitted, messaging.StatusUnknown, messaging.StatusRejected:
	default:
		return messaging.Receipt{}, fmt.Errorf("daemon returned an unsupported receipt status %q; delivery is unknown", receipt.Status)
	}
	if !validMessageFilesReceipt(request, receipt) {
		return messaging.Receipt{}, fmt.Errorf("daemon returned mismatched or incomplete file receipts; delivery is unknown")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return receipt, daemonStatusError{url: endpoint, status: resp.StatusCode, body: strings.TrimSpace(string(body))}
	}
	return receipt, nil
}

func validMessageFilesReceipt(request messaging.Request, receipt messaging.Receipt) bool {
	if len(receipt.Files) == 0 && (receipt.Status == messaging.StatusRejected || receipt.Status == messaging.StatusUnknown) {
		return true
	}
	if len(receipt.Files) != len(request.Attachments) {
		return false
	}
	for i, file := range receipt.Files {
		want := request.Attachments[i]
		if file.Name != want.Name || file.SHA256 != want.SHA256 || file.Size != int64(len(want.Data)) || !filepath.IsAbs(file.Path) || strings.ContainsAny(file.Path, "\x00\r\n") {
			return false
		}
	}
	return true
}

func init() {
	shuttleSessionsCmd.Flags().BoolVar(&sessionsDiscoveryLocal, "local", false, "query this host's native harness adapters directly")
	_ = shuttleSessionsCmd.Flags().MarkHidden("local")
	shuttleSessionsCmd.Flags().StringVar(&sessionsDiscoveryHost, "host", "", "limit live session discovery to one host")
	shuttleSessionsCmd.Flags().StringVar(&sessionsDiscoveryHarness, "harness", "", "limit live session discovery to one harness")

	shuttleMessageCmd.Flags().StringVar(&messageFile, "file", "", "read message text from a file ('-' for stdin)")
	shuttleMessageCmd.Flags().StringArrayVar(&messageAttachments, "attach", nil, "copy a file to the recipient's host (repeat for multiple files)")
	shuttleMessageCmd.Flags().BoolVar(&messageWake, "wake", false, "request that the native harness wake the addressed session")
	shuttleMessageCmd.Flags().StringVar(&messageFrom, "from", "", "label the sender (default: detected harness thread or external)")
	shuttleMessageCmd.Flags().StringVar(&messageID, "message-id", "", "supply an idempotency key for a safe retry")
	shuttleMessageCmd.Flags().BoolVar(&messageLocal, "local", false, "send through this host's native adapter without daemon routing")
	_ = shuttleMessageCmd.Flags().MarkHidden("local")
	shuttleMessageCmd.Flags().BoolVar(&messageRequestJSON, "request-json", false, "read one message request JSON frame from stdin")
	_ = shuttleMessageCmd.Flags().MarkHidden("request-json")
	shuttleCmd.AddCommand(shuttleMessageCmd)
}
