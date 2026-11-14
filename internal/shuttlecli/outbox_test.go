package shuttlecli

import "testing"

func TestOutboxDismissWritesBoardRecord(t *testing.T) {
	t.Parallel()
	env, sink, _ := sendFileTestEnv(t)
	if _, _, err := executeIn(t, env, "", "outbox", "dismiss", "ask:UID:2026-11-14", "--fiber", "UID"); err != nil {
		t.Fatal(err)
	}
	records := readBoardRecords(t, sink)
	if len(records) != 1 || records[0].Kind != "dismissed" || records[0].Text != "ask:UID:2026-11-14" || records[0].Fiber != "UID" || records[0].ID == "" {
		t.Fatalf("records: %+v", records)
	}
}
