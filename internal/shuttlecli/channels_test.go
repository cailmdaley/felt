package shuttlecli

import "testing"

func TestChannelsDismissWritesBoardRecord(t *testing.T) {
	t.Parallel()
	env, sink, _ := sendFileTestEnv(t)
	if _, _, err := executeIn(t, env, "", "channels", "dismiss", "office:role:vizier:1", "--fiber", "UID"); err != nil {
		t.Fatal(err)
	}
	records := readBoardRecords(t, sink)
	if len(records) != 1 || records[0].Kind != "dismissed" || records[0].Text != "office:role:vizier:1" || records[0].Fiber != "UID" || records[0].ID == "" {
		t.Fatalf("records: %+v", records)
	}
}

func TestChannelsPinWritesBoardRecord(t *testing.T) {
	t.Parallel()
	env, sink, _ := sendFileTestEnv(t)
	if _, _, err := executeIn(t, env, "", "channels", "pin", "role:vizier", "--fiber", "UID"); err != nil {
		t.Fatal(err)
	}
	records := readBoardRecords(t, sink)
	if len(records) != 1 || records[0].Kind != "pinned" || records[0].Text != "role:vizier" || records[0].Fiber != "UID" || records[0].ID == "" {
		t.Fatalf("records: %+v", records)
	}
}
