package shuttlecli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

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

func (a *app) recordBoard(record boardRecord) {
	if err := a.appendBoard(record); err != nil {
		fmt.Fprintf(a.env.Stderr, "warning: could not record family board: %v\n", err)
	}
}

func (a *app) boardCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "board", Short: "Read the family board"}
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
