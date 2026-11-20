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

	"github.com/cailmdaley/felt/internal/felt"
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
	// Files are the absolute paths a post attaches, each also recorded as a sent file.
	Files []string `json:"files,omitempty"`
	// Keys are the channel keys an `ordered` record lists, in the human's order.
	Keys []string `json:"keys,omitempty"`
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

// appendBoard appends a board record to the event ledger, under its own ID
// when it has one.
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
	if record.ID == "" {
		record.ID = "brd-" + id.String()
	}
	record.Type, record.Timestamp, record.OriginName = "board", now.UnixMilli(), origin
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
	if strings.EqualFold(strings.TrimSpace(from), "human") {
		return a.humanParty()
	}
	by := &boardParty{}
	if _, err := messaging.ParseAddress(from); err != nil {
		by.Label = from
	} else {
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
	if !strings.HasPrefix(target, "shuttle://") && !sessionUUIDPattern.MatchString(target) {
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
	Summary   string `json:"-"`
}

// foldHumanTurns replaces each unbroken stretch of the human's turns with one
// row that counts them per worker, typed or spoken alike, so the board says who
// they talked to and not what. The words stay with that worker.
func foldHumanTurns(rows []boardRow) []boardRow {
	var out []boardRow
	for i := 0; i < len(rows); {
		if rows[i].Kind != "human" {
			out = append(out, rows[i])
			i++
			continue
		}
		end := i
		for end < len(rows) && rows[end].Kind == "human" {
			end++
		}
		out = append(out, turnSummary(rows[i:end]))
		i = end
	}
	return out
}

func turnSummary(run []boardRow) boardRow {
	counts, order := map[string]int{}, []string{}
	for _, row := range run {
		if counts[row.Member] == 0 {
			order = append(order, row.Member)
		}
		counts[row.Member]++
	}
	parts := make([]string, 0, len(order))
	for _, member := range order {
		n, noun := counts[member], "messages"
		if n == 1 {
			noun = "message"
		}
		if member == "" {
			member = "someone"
		}
		parts = append(parts, fmt.Sprintf("%d %s to %s", n, noun, member))
	}
	last := run[len(run)-1]
	actor := last.Actor
	if actor == "" {
		actor = "someone"
	}
	return boardRow{boardRecord: boardRecord{ID: last.ID, Timestamp: last.Timestamp, Kind: "human"},
		Summary: actor + " sent " + strings.Join(parts, ", ")}
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
	// ReachMs is how far back the board reaches (its retention).
	ReachMs int64 `json:"reach_ms"`
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
		if r.Summary != "" {
			return r.Summary
		}
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
	case "run_tempered":
		return actor + " tempered " + member + "'s run"
	case "unblocked":
		return member + " unblocked"
	default:
		return actor + " " + r.Kind + " " + member
	}
}

func (a *app) boardCmd() *cobra.Command {
	var since string
	var all, turns bool
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
			if now := a.eventNow(); at.After(now) {
				return fmt.Errorf("--since %s is in the future: it is now %s", since, now.Local().Format(time.RFC3339))
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
		visible := response.Records[:0]
		for _, row := range response.Records {
			if row.Kind != "dismissed" && row.Kind != "pinned" {
				visible = append(visible, row)
			}
		}
		response.Records = visible
		rows := foldHumanTurns(response.Records)
		if turns {
			rows = rows[:0]
			for _, row := range response.Records {
				if row.Kind == "human" {
					rows = append(rows, row)
				}
			}
		}
		for _, row := range rows {
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
	cmd.Flags().BoolVar(&turns, "turns", false, "Show the human's turns in full instead of counted")
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

// humanParty is the human as a board address: a label with no fiber or
// session names a person.
func (a *app) humanParty() *boardParty {
	return &boardParty{Label: a.humanLabel()}
}

// upParty addresses what f says up: to its orchestrator, or nil when nothing
// stands above it.
func (a *app) upParty(st *felt.Storage, f *felt.Felt) *boardParty {
	if parent := orchestratorOf(st, f); parent != nil && parent.UID != "" {
		return &boardParty{Fiber: parent.UID}
	}
	return nil
}

// upOrHuman addresses a question or a close for review: to f's orchestrator,
// who reviews it, else to the human.
func (a *app) upOrHuman(st *felt.Storage, f *felt.Felt) *boardParty {
	if up := a.upParty(st, f); up != nil {
		return up
	}
	return a.humanParty()
}

// boardAddress resolves a --to address: "human" or the human's name, else a fiber.
func (a *app) boardAddress(to string) (*boardParty, error) {
	to = strings.TrimSpace(to)
	if strings.EqualFold(to, "human") || strings.EqualFold(to, a.humanLabel()) {
		return a.humanParty(), nil
	}
	f, _, _, err := a.shuttleResolveFiberRef(to, false)
	if err != nil {
		return nil, fmt.Errorf("--to %q names neither the human (%s) nor a fiber: %w", to, a.humanLabel(), err)
	}
	if f.UID == "" {
		return nil, fmt.Errorf("--to %q: fiber has no uid", to)
	}
	return &boardParty{Fiber: f.UID}, nil
}

func (a *app) postCmd() *cobra.Command {
	var fiber, to string
	var attach []string
	cmd := &cobra.Command{
		Use:   "post <text|->",
		Short: "Post to a family board, addressed to someone, without waking anyone",
		Long: `Records a post on the family board, readable by everyone. Its address says
whose attention it asks for: --to the human (by name, or "human") or a fiber;
without --to, the poster's orchestrator (unaddressed at the top level). A
post addressed to the human waits on them until they reply or clear it, or the
poster says something newer. A post wakes no one.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var f *felt.Felt
			var st *felt.Storage
			if fiber != "" {
				var err error
				if f, st, _, err = a.shuttleResolveFiberRef(fiber, false); err != nil {
					return err
				}
			} else {
				var err error
				if f, err = a.currentWorkerFiber(); err != nil {
					return fmt.Errorf("name a fiber with --fiber")
				}
				st = felt.NewStorage(workerStoreRoot(f.Path))
			}
			if f.UID == "" {
				return fmt.Errorf("fiber has no uid")
			}
			address := a.upParty(st, f)
			if cmd.Flags().Changed("to") {
				var err error
				if address, err = a.boardAddress(to); err != nil {
					return err
				}
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
			var files []string
			if len(attach) > 0 {
				var err error
				if files, err = a.sendFiles(attach, "", ""); err != nil {
					return err
				}
			}
			if err := a.appendBoard(boardRecord{Kind: "post", Fiber: f.UID, By: &boardParty{Fiber: f.UID}, To: address, Text: text, Files: files}); err != nil {
				return err
			}
			receipt := "posted as " + f.ID
			if address != nil && address.Label != "" {
				receipt += " to " + address.Label
			} else if to != "" {
				receipt += " to " + to
			}
			if len(files) > 0 {
				receipt += fmt.Sprintf(" with %d file(s)", len(files))
			}
			fmt.Fprintln(a.env.Stdout, receipt)
			return nil
		},
	}
	cmd.Flags().StringVar(&fiber, "fiber", "", "Post as the named family member")
	cmd.Flags().StringVar(&to, "to", "", "Whose attention it asks for: the human (by name, or \"human\") or a fiber (default: the poster's orchestrator)")
	cmd.Flags().StringArrayVar(&attach, "file", nil, "Attach a file to the post (repeatable); it is also recorded as a sent file")
	return cmd
}
