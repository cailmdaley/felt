package shuttlecli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/oklog/ulid/v2"
	"github.com/spf13/cobra"
)

type boardParty struct {
	Fiber   string `json:"fiber,omitempty"`
	Session string `json:"session,omitempty"`
	Label   string `json:"label,omitempty"`
}

type boardRecord struct {
	ID         string      `json:"id,omitempty"`
	Type       string      `json:"type,omitempty"`
	Timestamp  int64       `json:"timestamp,omitempty"`
	OriginName string      `json:"originName,omitempty"`
	Kind       string      `json:"kind"`
	By         *boardParty `json:"by,omitempty"`
	Fiber      string      `json:"fiber,omitempty"`
	To         *boardParty `json:"to,omitempty"`
	Text       string      `json:"text,omitempty"`
	Wake       bool        `json:"wake,omitempty"`
	Verdict    string      `json:"verdict,omitempty"`
}

func boardText(text string) string {
	text = strings.ToValidUTF8(strings.TrimSpace(text), "�")
	if len(text) <= 2000 {
		return text
	}
	text = text[:1997]
	for !utf8.ValidString(text) {
		text = text[:len(text)-1]
	}
	return text + "…"
}

func (a *app) appendBoard(record boardRecord) error {
	now := a.eventNow()
	id, err := ulid.New(ulid.Timestamp(now), a.boardEntropy)
	if err != nil {
		return fmt.Errorf("generate board id: %w", err)
	}
	origin, err := a.resolveOwnHost("")
	if err != nil {
		return err
	}
	record.ID, record.Type, record.Timestamp, record.OriginName = "brd-"+id.String(), "board", now.UnixMilli(), origin
	record.Text = boardText(record.Text)
	line, err := encodeJSONLine(record)
	if err != nil {
		return err
	}
	if len(line) > eventMaxLineBytes {
		return fmt.Errorf("board record exceeds %d bytes", eventMaxLineBytes)
	}
	sink, enabled := a.eventsSink()
	if !enabled {
		return fmt.Errorf("event recording is disabled or its state directory is missing")
	}
	return a.appendEventLine(sink, line)
}

func (a *app) boardWorkerParty() *boardParty {
	f, err := a.currentWorkerFiber()
	if err != nil || f.UID == "" {
		return nil
	}
	return &boardParty{Fiber: f.UID}
}

func (a *app) boardMessageActor(from string) *boardParty {
	by := &boardParty{Label: from}
	if _, err := messaging.ParseAddress(from); err == nil {
		by.Session = from
		if target := a.messageReplyTarget(from); target != "" {
			if isSessionULID(target) {
				by.Fiber = target
			} else if lookup, err := a.lookupShuttleAddressFibers(target); err == nil && !lookup.refused() && len(lookup.Fibers) == 1 {
				by.Fiber = lookup.Fibers[0].UID
			}
		}
	}
	return by
}

func (a *app) recordBoardMessage(target string, request messaging.Request) {
	by := a.boardMessageActor(request.From)
	to := &boardParty{}
	if _, err := messaging.ParseAddress(request.Address); err == nil {
		to.Session = request.Address
	}
	if !strings.HasPrefix(target, "shuttle://") && !looksLikeNativeSessionID(target) {
		if lookup, err := a.lookupShuttleAddressFibers(target); err == nil && !lookup.refused() && len(lookup.Fibers) == 1 {
			to.Fiber = lookup.Fibers[0].UID
		}
	}
	member := to.Fiber
	if member == "" {
		member = by.Fiber
	}
	if to.Fiber == "" && to.Session == "" {
		to = nil
	}
	a.recordBoard(boardRecord{Kind: "message", By: by, Fiber: member, To: to, Text: request.Text, Wake: request.Wake})
}

func (a *app) recordBoard(record boardRecord) {
	if err := a.appendBoard(record); err != nil {
		fmt.Fprintf(a.env.Stderr, "warning: could not record family board: %v\n", err)
	}
}

type boardRow struct {
	boardRecord
	Member    string `json:"member"`
	ToMember  string `json:"to_member"`
	Actor     string `json:"actor"`
	Delivered bool   `json:"delivered"`
}

type boardFamily struct {
	RootUID string `json:"root_uid"`
	RootID  string `json:"root_id"`
	Name    string `json:"name"`
	Label   string `json:"label"`
}
type boardResponse struct {
	Family  *boardFamily `json:"family"`
	Viewer  *string      `json:"viewer"`
	Records []boardRow   `json:"records"`
}

func boardSingleLine(text string) string {
	return strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ").Replace(text)
}

func boardPhrase(r boardRow) string {
	actor, member := r.Actor, r.Member
	if actor == "" {
		actor = "someone"
	}
	if member == "" {
		member = "someone"
	}
	switch r.Kind {
	case "message":
		to := r.ToMember
		if to == "" {
			to = member
		}
		return actor + " → " + to
	case "post":
		return member + " posted"
	case "human":
		return actor + " wrote to " + member + " at the thread"
	case "answered":
		return actor + " answered " + member + "'s question at the thread"
	case "asked":
		return member + " asked"
	case "cleared":
		return actor + " cleared " + member + "'s question"
	case "closed":
		if r.Verdict != "" {
			return member + " closed (" + r.Verdict + ")"
		}
		return member + " closed"
	case "handed_off":
		return member + " handed off"
	case "rested":
		return member + " rested"
	case "unblocked":
		return member + " unblocked"
	default:
		return actor + " " + r.Kind + " " + member
	}
}

func (a *app) boardCmd() *cobra.Command {
	var since string
	var all bool
	cmd := &cobra.Command{Use: "board [fiber]", Short: "Read the family board", Args: cobra.MaximumNArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		q := url.Values{}
		if all {
			q.Set("all", "true")
		}
		if len(args) > 0 {
			q.Set("fiber", args[0])
		} else if !all {
			f, err := a.currentWorkerFiber()
			if err != nil {
				return fmt.Errorf("name a fiber to read its family board")
			}
			q.Set("fiber", f.UID)
		}
		if since != "" {
			var at time.Time
			if d, err := time.ParseDuration(since); err == nil {
				at = a.eventNow().Add(-d)
			} else {
				at, err = time.Parse(time.RFC3339, since)
				if err != nil {
					return fmt.Errorf("invalid --since: %w", err)
				}
			}
			q.Set("since_ms", strconv.FormatInt(at.UnixMilli(), 10))
		}
		endpoint, err := a.daemonEndpoint("/api/v1/board/family")
		if err != nil {
			return err
		}
		body, err := a.getDaemon(endpoint+"?"+q.Encode(), daemonReadTimeout)
		if err != nil {
			return err
		}
		if a.json {
			_, err = a.env.Stdout.Write(body)
			return err
		}
		var response boardResponse
		if err := json.Unmarshal(body, &response); err != nil {
			return fmt.Errorf("parsing family board: %w", err)
		}
		for _, row := range response.Records {
			line := time.UnixMilli(row.Timestamp).Local().Format("15:04") + "  " + boardPhrase(row)
			if row.Text != "" {
				line += ": " + boardSingleLine(row.Text)
			}
			fmt.Fprintln(a.env.Stdout, line)
		}
		return nil
	}}
	cmd.Flags().StringVar(&since, "since", "", "Show records since a duration or RFC3339 timestamp")
	cmd.Flags().BoolVar(&all, "all", false, "Show records across all families")
	cmd.AddCommand(&cobra.Command{
		Use: "append", Hidden: true, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var record boardRecord
			dec := json.NewDecoder(io.LimitReader(a.env.Stdin, 1<<20))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&record); err != nil {
				return err
			}
			var extra any
			if err := dec.Decode(&extra); err != io.EOF {
				return fmt.Errorf("expected one board record")
			}
			if record.Kind == "" {
				return fmt.Errorf("board kind is required")
			}
			return a.appendBoard(record)
		},
	})
	return cmd
}

func (a *app) postCmd() *cobra.Command {
	var fiber string
	cmd := &cobra.Command{Use: "post <text|->", Short: "Post to a family board without waking a worker", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		var uid string
		if fiber != "" {
			f, _, _, err := a.shuttleResolveFiberRef(fiber, false)
			if err != nil {
				return err
			}
			uid = f.UID
		} else {
			f, err := a.currentWorkerFiber()
			if err != nil {
				return fmt.Errorf("name a fiber with --fiber")
			}
			uid = f.UID
		}
		if uid == "" {
			return fmt.Errorf("fiber has no uid")
		}
		text := args[0]
		if text == "-" {
			b, err := io.ReadAll(io.LimitReader(a.env.Stdin, 1<<20))
			if err != nil {
				return err
			}
			text = string(b)
		}
		if strings.TrimSpace(text) == "" {
			return fmt.Errorf("post text is empty")
		}
		return a.appendBoard(boardRecord{Kind: "post", Fiber: uid, By: &boardParty{Fiber: uid}, Text: text})
	}}
	cmd.Flags().StringVar(&fiber, "fiber", "", "Post as the named family member")
	return cmd
}
