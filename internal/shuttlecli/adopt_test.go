package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func firBlock(extra map[string]any) map[string]any {
	block := map[string]any{"kind": "oneshot", "host": "fir", "agent": "claude-opus", "project_dir": "/srv/work"}
	for key, value := range extra {
		block[key] = value
	}
	return block
}

// writeCarriedDocument marshals f as a caller's document and returns its path.
func writeCarriedDocument(t *testing.T, f *felt.Felt) string {
	t.Helper()
	data, err := f.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "carried.md")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAdopt(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name        string
		localBlock  map[string]any
		carried     func(t *testing.T, f *felt.Felt)
		carry       bool
		wantOut     string
		wantErr     string
		wantAdopted bool
		check       func(t *testing.T, got *felt.Felt)
	}{
		{
			name:       "held and the same",
			localBlock: firBlock(map[string]any{"runtime": map[string]any{"session": "owner-session"}}),
			carried: func(t *testing.T, f *felt.Felt) {
				// Volatile keys, runtime and ask are not differences.
				f.Status = felt.StatusOpen
				if err := shuttle.SetNodeField(f, "runtime", map[string]any{"session": "stale"}); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:       "held and different",
			localBlock: firBlock(nil),
			carried: func(t *testing.T, f *felt.Felt) {
				f.Body = "the caller's body"
				f.Outcome = "the caller's outcome"
			},
			wantOut: "note: fir's copy of task differs from the caller's (body, outcome) and stands; --carry sends the caller's version\n",
		},
		{
			name:       "held, carried with --carry",
			localBlock: firBlock(map[string]any{"runtime": map[string]any{"session": "owner-session"}}),
			carried: func(t *testing.T, f *felt.Felt) {
				f.Body = "the caller's body"
				f.Status = felt.StatusClosed
				if err := shuttle.SetNodeField(f, "runtime", map[string]any{"session": "stale"}); err != nil {
					t.Fatal(err)
				}
			},
			carry:       true,
			wantOut:     "fir took the caller's version of task (was: its own constitution, overridden by --carry; differs: body)\n",
			wantAdopted: true,
			check: func(t *testing.T, got *felt.Felt) {
				if session := shuttleRuntimeMap(t, got)["session"]; session != "owner-session" {
					t.Fatalf("runtime session = %v, want the owner's", session)
				}
				if got.Status == felt.StatusClosed {
					t.Fatal("the caller's status replaced the owner's")
				}
			},
		},
		{
			name: "no block",
			carried: func(t *testing.T, f *felt.Felt) {
				f.Body = "the caller's body"
				if err := f.SetExtraField("shuttle", firBlock(map[string]any{"runtime": map[string]any{"session": "stale"}})); err != nil {
					t.Fatal(err)
				}
			},
			wantOut:     "fir took the caller's version of task (was: no shuttle: block; differs: body, shuttle)\n",
			wantAdopted: true,
			check: func(t *testing.T, got *felt.Felt) {
				node := felt.MappingValueNode(got.ExtraFields["shuttle"], "runtime")
				if node != nil {
					t.Fatalf("carried runtime kept: %#v", node)
				}
			},
		},
		{
			name:       "block for another host",
			localBlock: map[string]any{"kind": "oneshot", "host": "oak", "agent": "claude-opus", "project_dir": "/srv/work", "runtime": map[string]any{"session": "oak-session"}},
			carried: func(t *testing.T, f *felt.Felt) {
				if err := shuttle.SetField(f, "host", "fir"); err != nil {
					t.Fatal(err)
				}
				if err := shuttle.SetNodeField(f, "runtime", nil); err != nil {
					t.Fatal(err)
				}
			},
			wantOut:     "fir took the caller's version of task (was: a shuttle: block for host \"oak\"; differs: shuttle)\n",
			wantAdopted: true,
			check: func(t *testing.T, got *felt.Felt) {
				if felt.MappingValueNode(got.ExtraFields["shuttle"], "runtime") != nil {
					t.Fatal("another host's runtime kept")
				}
			},
		},
		{
			name: "carried document names another host",
			carried: func(t *testing.T, f *felt.Felt) {
				if err := f.SetExtraField("shuttle", map[string]any{"kind": "oneshot", "host": "oak"}); err != nil {
					t.Fatal(err)
				}
			},
			wantErr: `names host "oak"; this host is "fir"`,
		},
		{
			name:       "carried document has another id",
			localBlock: firBlock(nil),
			carried: func(t *testing.T, f *felt.Felt) {
				f.UID = felt.NewULID()
				f.Body = "the caller's body"
			},
			carry:   true,
			wantErr: "has id",
		},
		{
			name:    "carried document has no block",
			carried: func(t *testing.T, f *felt.Felt) {},
			wantErr: "has no shuttle: block",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			ownHost(t, env, "fir")
			dir, st := newStore(t)
			seedFiber(t, st, "task", "", felt.StatusActive, tc.localBlock, nil)
			local := mustRead(t, st, "task")
			local.Body = "the owner's body"
			if err := st.Write(local); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(local.Path)
			if err != nil {
				t.Fatal(err)
			}
			caller := mustRead(t, st, "task")
			tc.carried(t, caller)
			path := writeCarriedDocument(t, caller)

			args := []string{"adopt", "task", "--document-file", path}
			if tc.carry {
				args = append(args, "--carry")
			}
			out, _, err := executeIn(t, env, dir, args...)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("adopt error = %v, want %q", err, tc.wantErr)
				}
			} else if err != nil {
				t.Fatalf("adopt: %v", err)
			}
			if out != tc.wantOut {
				t.Fatalf("adopt output = %q, want %q", out, tc.wantOut)
			}
			after, err := os.ReadFile(local.Path)
			if err != nil {
				t.Fatal(err)
			}
			if !tc.wantAdopted {
				if string(after) != string(before) {
					t.Fatalf("owner's copy changed:\n%s", after)
				}
				return
			}
			got := mustRead(t, st, "task")
			block, ok, err := shuttle.BlockOf(got)
			if err != nil || !ok || block.Host != "fir" {
				t.Fatalf("adopted block = %#v, %v, %v", block, ok, err)
			}
			if got.UID != local.UID || got.Body != caller.Body {
				t.Fatalf("adopted uid %q body %q; want uid %q body %q", got.UID, got.Body, local.UID, caller.Body)
			}
			if tc.check != nil {
				tc.check(t, got)
			}
		})
	}
}
