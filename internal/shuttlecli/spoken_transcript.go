package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func (a *app) spokenTranscript(cmd *cobra.Command) error {
	query := url.Values{}
	for _, flag := range []string{"date", "fiber", "since", "recorder"} {
		if cmd.Flags().Changed(flag) {
			value, _ := cmd.Flags().GetString(flag)
			query.Set(flag, value)
		}
	}
	endpoint, err := a.daemonEndpoint("/api/v1/voice/transcript")
	if err != nil {
		return err
	}
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	body, err := a.getDaemon(endpoint, daemonRoutedPostTimeout)
	if err != nil {
		return err
	}
	if a.json {
		a.printDaemonBody(body)
		return nil
	}
	var answer struct {
		Rows []struct {
			Time    time.Time `json:"t"`
			Speaker string    `json:"speaker"`
			Text    string    `json:"text"`
			FiberID string    `json:"fiber_id"`
			Slug    string    `json:"slug"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		return fmt.Errorf("decoding spoken transcript: %w", err)
	}
	lineBreaks := strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ")
	for _, row := range answer.Rows {
		card := "—"
		if row.Slug != "" {
			card = row.Slug[strings.LastIndex(row.Slug, "/")+1:]
		} else if row.FiberID != "" {
			card = row.FiberID[strings.LastIndex(row.FiberID, "/")+1:]
		}
		text := lineBreaks.Replace(row.Text)
		fmt.Fprintf(a.env.Stdout, "%s %s → %s: %s\n", row.Time.Format("15:04:05"), row.Speaker, card, text)
	}
	return nil
}
