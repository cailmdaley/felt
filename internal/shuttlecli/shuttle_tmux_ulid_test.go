package shuttlecli

import "testing"

func TestShuttleTmuxSessionNameRequiresULID(t *testing.T) {
	const ulid = "01M3PGXMZSRH00ZCNWZ63XWZDF"
	cases := map[string]string{
		ulid:                         "leaf-" + ulid + "-shuttle",
		"":                           "",
		"shuttle":                    "",
		"01m3pgxmzsrh00zcnwz63xwzdf": "",
		ulid + "X":                   "",
		"01M3PGXMZSRH00ZCNWZ63XWZDI": "",
	}
	for uid, want := range cases {
		if got := shuttleTmuxSessionName("a/leaf", uid); got != want {
			t.Errorf("shuttleTmuxSessionName(%q) = %q, want %q", uid, got, want)
		}
	}
}
