package feltcli

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// newPersonStore is a store in a git repository whose checkout works for
// alice, holding open work that is alice's, sam's and nobody's, and closed
// work that is sam's.
func newPersonStore(t *testing.T) string {
	t.Helper()
	dir, storage := newStore(t)
	for _, args := range [][]string{{"init", "-q"}, {"config", felt.PersonConfigKey, "alice"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	at := mustParseTime(t, "2026-04-10T09:00:00Z")
	for _, f := range []*felt.Felt{
		{ID: "mine", Name: "Mine", Status: felt.StatusOpen, Role: "analyst/alice", CreatedAt: at},
		{ID: "theirs", Name: "Theirs", Status: felt.StatusActive, Role: "sam", CreatedAt: at},
		{ID: "nobodys", Name: "Nobodys", Status: felt.StatusOpen, CreatedAt: at},
		{ID: "done", Name: "Done", Status: felt.StatusClosed, Role: "analyst/sam", CreatedAt: at},
	} {
		if err := storage.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestLsHidesOtherPeoplesOpenWork(t *testing.T) {
	t.Parallel()
	dir := newPersonStore(t)
	listed := func(args ...string) string {
		t.Helper()
		out, err := runCommand(t, dir, append([]string{"ls"}, args...)...)
		if err != nil {
			t.Fatalf("ls %v: %v\n%s", args, err, out)
		}
		return out
	}
	shows := func(out string, want map[string]bool) {
		t.Helper()
		for id, shown := range want {
			if strings.Contains(out, " "+id+"\n") != shown {
				t.Fatalf("%s shown=%v expected %v:\n%s", id, !shown, shown, out)
			}
		}
	}

	bare := listed()
	shows(bare, map[string]bool{"mine": true, "nobodys": true, "theirs": false})
	if !strings.Contains(bare, "(1 open fiber is other people's — add --person all)") {
		t.Fatalf("bare ls lacks the other-people hint:\n%s", bare)
	}
	if !strings.Contains(bare, "(1 more —") {
		t.Fatalf("other people's fibers counted twice:\n%s", bare)
	}

	all := listed("--person", "all")
	shows(all, map[string]bool{"mine": true, "nobodys": true, "theirs": true})
	if strings.Contains(all, "other people's") {
		t.Fatalf("--person all still hints:\n%s", all)
	}
	shows(listed("--person", "sam"), map[string]bool{"mine": false, "nobodys": false, "theirs": true})
	shows(listed("Theirs"), map[string]bool{"theirs": true})
	shows(listed("-s", "active"), map[string]bool{"theirs": true})

	var rows []map[string]any
	out := listed("--json")
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("--json filtered by person: %s", out)
	}
	roleOf := map[string]any{}
	for _, row := range rows {
		roleOf[row["id"].(string)] = row["role"]
	}
	if roleOf["theirs"] != "sam" || roleOf["nobodys"] != nil {
		t.Fatalf("--json role = %v", roleOf)
	}
	if err := json.Unmarshal([]byte(listed("--json", "--person", "sam")), &rows); err != nil || len(rows) != 1 {
		t.Fatalf("--json --person sam = %v (%v)", rows, err)
	}
}

func TestFindByPerson(t *testing.T) {
	t.Parallel()
	dir := newPersonStore(t)
	out, err := runCommand(t, dir, "find", "--no-body", "--person", "sam", "e")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, " theirs\n") || !strings.Contains(out, " done\n") || strings.Contains(out, " mine\n") {
		t.Fatalf("find --person sam:\n%s", out)
	}
	out, err = runCommand(t, dir, "find", "--no-body", "e")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, " theirs\n") || !strings.Contains(out, " mine\n") {
		t.Fatalf("find without --person filtered by person:\n%s", out)
	}
}

func TestSessionContextLeavesOutOtherPeoplesWork(t *testing.T) {
	t.Parallel()
	dir := newPersonStore(t)
	inFlight := sectionBody(sessionContextFor(t, dir), "## Active / Open")
	if strings.Contains(inFlight, "theirs") || !strings.Contains(inFlight, "mine") {
		t.Fatalf("Active / Open:\n%s", inFlight)
	}
}

func TestAddShowAndEditRole(t *testing.T) {
	t.Parallel()
	dir := newPersonStore(t)
	show := func(id string) string {
		t.Helper()
		out, err := runCommand(t, dir, "show", id)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	if out := show("theirs"); !strings.Contains(out, "Role:     sam\n") {
		t.Fatalf("show:\n%s", out)
	}
	for _, args := range [][]string{
		{"add", "fresh", "Fresh", "-s", "open"},
		{"add", "given", "Given", "-s", "open", "-R", "analyst/sam"},
		{"add", "note", "Note"},
	} {
		if out, err := runCommand(t, dir, args...); err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
	}
	if out := show("fresh"); !strings.Contains(out, "Role:     alice\n") {
		t.Fatalf("open add did not stamp alice:\n%s", out)
	}
	if out := show("given"); !strings.Contains(out, "Role:     analyst/sam\n") {
		t.Fatalf("add -R:\n%s", out)
	}
	if out := show("note"); strings.Contains(out, "Role:") {
		t.Fatalf("a note without status got a role:\n%s", out)
	}
	if out, err := runCommand(t, dir, "edit", "mine", "--role", "sam"); err != nil {
		t.Fatalf("edit --role: %v\n%s", err, out)
	}
	if out := show("mine"); !strings.Contains(out, "Role:     sam\n") {
		t.Fatalf("role not handed over:\n%s", out)
	}
	if out, err := runCommand(t, dir, "edit", "mine", "--role", ""); err != nil {
		t.Fatalf("edit --role '': %v\n%s", err, out)
	}
	if out := show("mine"); strings.Contains(out, "Role:") {
		t.Fatalf("role not cleared:\n%s", out)
	}
	for _, args := range [][]string{
		{"edit", "mine", "--role", "a/b/c"},
		{"edit", "mine", "--set", "role=sam"},
		{"add", "bad", "Bad", "-R", "Sam"},
	} {
		if _, err := runCommand(t, dir, args...); err == nil {
			t.Fatalf("%v accepted", args)
		}
	}
}

// An office with nobody named, `role: editor`, is on nobody's list: bare ls
// and the session context count it as other people's, and --person all
// shows it.
func TestOfficeAloneIsNotMine(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)
	for _, args := range [][]string{{"init", "-q"}, {"config", felt.PersonConfigKey, "alice"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	at := mustParseTime(t, "2026-04-10T09:00:00Z")
	for _, f := range []*felt.Felt{
		{ID: "roles/editor", Name: "Editor", CreatedAt: at},
		{ID: "desk", Name: "Desk", Status: felt.StatusOpen, Role: "alice", CreatedAt: at},
		{ID: "office", Name: "Office", Status: felt.StatusOpen, Role: "editor", CreatedAt: at},
	} {
		if err := storage.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	bare, err := runCommand(t, dir, "ls")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(bare, " desk\n") || strings.Contains(bare, " office\n") || !strings.Contains(bare, "(1 open fiber is other people's") {
		t.Fatalf("bare ls:\n%s", bare)
	}
	all, err := runCommand(t, dir, "ls", "--person", "all")
	if err != nil || !strings.Contains(all, " office\n") {
		t.Fatalf("ls --person all: %v\n%s", err, all)
	}
	inFlight := sectionBody(sessionContextFor(t, dir), "## Active / Open")
	if strings.Contains(inFlight, "office") || !strings.Contains(inFlight, "desk") {
		t.Fatalf("Active / Open:\n%s", inFlight)
	}
}
