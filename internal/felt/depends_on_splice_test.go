package felt

import (
	"reflect"
	"testing"
)

func TestSpliceOutOfQueuesClosesTheGap(t *testing.T) {
	t.Parallel()
	s := NewStorage(t.TempDir())
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	write := func(id string, deps any) *Felt {
		t.Helper()
		f := &Felt{ID: id, Name: id}
		if deps != nil {
			if err := f.SetExtraField("depends_on", deps); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.Write(f); err != nil {
			t.Fatal(err)
		}
		return f
	}
	write("proj/head", nil)
	target := write("proj/mid", "proj/head")
	write("proj/next", "mid") // by slug
	write("proj/fan", []string{"proj/other", "proj/mid"})
	write("proj/other", nil)
	write("proj/viauid", []string{target.UID})
	write("proj/unrelated", "proj/head")

	got, err := s.SpliceOutOfQueues(target)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"proj/fan", "proj/next", "proj/viauid"}; !reflect.DeepEqual(sorted(got), want) {
		t.Fatalf("rewrote %v, want %v", got, want)
	}
	if _, ok := target.ExtraFields["depends_on"]; ok {
		t.Fatal("target kept its depends_on")
	}
	deps := func(id string) any {
		t.Helper()
		f, err := s.Read(id)
		if err != nil {
			t.Fatal(err)
		}
		n := f.ExtraFields["depends_on"]
		if n == nil {
			return nil
		}
		var v any
		if err := n.Decode(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	if v := deps("proj/next"); v != "proj/head" {
		t.Errorf("next depends_on = %v, want proj/head", v)
	}
	if v := deps("proj/fan"); !reflect.DeepEqual(v, []any{"proj/other", "proj/head"}) {
		t.Errorf("fan depends_on = %v", v)
	}
	if v := deps("proj/viauid"); v != "proj/head" {
		t.Errorf("viauid depends_on = %v", v)
	}
	if v := deps("proj/unrelated"); v != "proj/head" {
		t.Errorf("unrelated changed: %v", v)
	}
}

func TestSpliceOutOfQueuesHeadFreesFollowers(t *testing.T) {
	t.Parallel()
	s := NewStorage(t.TempDir())
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	head := &Felt{ID: "head", Name: "head"}
	if err := s.Write(head); err != nil {
		t.Fatal(err)
	}
	f := &Felt{ID: "follower", Name: "follower"}
	_ = f.SetExtraField("depends_on", "head")
	if err := s.Write(f); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SpliceOutOfQueues(head); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Read("follower")
	if _, ok := got.ExtraFields["depends_on"]; ok {
		t.Fatal("follower still waits on a head that left")
	}
}

func sorted(in []string) []string {
	out := append([]string(nil), in...)
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}
