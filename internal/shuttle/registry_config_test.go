package shuttle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeUserRegistry points $FELT_AGENTS_FILE at a temp file holding body.
func writeUserRegistry(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agents.json")
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatalf("writing fixture: %v", err)
	}
	t.Setenv("FELT_AGENTS_FILE", path)
	return path
}

// find fails the test when the id is absent.
func find(t *testing.T, reg *AgentRegistry, id string) AgentRecord {
	t.Helper()
	rec, ok := reg.Find(id)
	if !ok {
		t.Fatalf("agent %q not in registry %v", id, reg.IDs())
	}
	return rec
}

func TestLoadAgentRegistry_NoUserFile(t *testing.T) {
	t.Setenv("FELT_AGENTS_FILE", filepath.Join(t.TempDir(), "absent.json"))

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if reg.UserPath() != "" {
		t.Fatalf("UserPath = %q, want empty", reg.UserPath())
	}
	if len(reg.Records()) != reg.BuiltinCount() {
		t.Fatalf("%d records from a %d-record built-in layer", len(reg.Records()), reg.BuiltinCount())
	}
	for _, a := range reg.Records() {
		if a.Source != SourceBuiltin {
			t.Fatalf("%s: source %q, want builtin", a.ID, a.Source)
		}
	}
	def, err := reg.Default()
	if err != nil || def.ID != "claude-opus" {
		t.Fatalf("Default = %+v, %v; want claude-opus", def, err)
	}
}

// The env var wins over ~/.config/felt/agents.json — asserted with a fake HOME
// carrying a registry that must NOT be read.
func TestLoadAgentRegistry_EnvFileWinsOverHome(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".config", "felt"), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	homeFile := filepath.Join(home, ".config", "felt", "agents.json")
	if err := os.WriteFile(homeFile, []byte(`{"version":1,"agents":[{"id":"from-home","cli":"x"}]}`), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	// With no env var, HOME is the source.
	t.Setenv("FELT_AGENTS_FILE", "")
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if reg.UserPath() != homeFile {
		t.Fatalf("UserPath = %q, want %q", reg.UserPath(), homeFile)
	}
	find(t, reg, "from-home")

	// The env var overrides it.
	envFile := writeUserRegistry(t, `{"version":1,"agents":[{"id":"from-env","cli":"x"}]}`)
	reg, err = LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if reg.UserPath() != envFile {
		t.Fatalf("UserPath = %q, want %q", reg.UserPath(), envFile)
	}
	find(t, reg, "from-env")
	if _, ok := reg.Find("from-home"); ok {
		t.Fatal("the home registry must not be read when $FELT_AGENTS_FILE is set")
	}
}

func TestLoadAgentRegistry_MergeAddsNewID(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[
	  {"id":"my-agent","cli":"mycli","effort_levels":["low","high"],"default_effort":"high"}
	]}`)

	builtin, _ := LoadBuiltinAgentRegistry()
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if len(reg.Records()) != builtin.BuiltinCount()+1 {
		t.Fatalf("%d records, want %d", len(reg.Records()), builtin.BuiltinCount()+1)
	}
	rec := find(t, reg, "my-agent")
	if rec.Source != SourceUser {
		t.Fatalf("source = %q, want user", rec.Source)
	}
	if rec.Wrapper != "mycli" {
		t.Fatalf("wrapper = %q, want the cli %q", rec.Wrapper, "mycli")
	}
	// A new user agent resolves like any other, constraints included.
	if _, axes, err := reg.Resolve("my-agent", "", false); err != nil || axes.Effort != "high" {
		t.Fatalf("Resolve(my-agent) = %+v, %v; want effort high", axes, err)
	}
	if _, _, err := reg.Resolve("my-agent", "xhigh", false); err == nil {
		t.Fatal("effort outside the user record's levels must be rejected")
	}
}

// An override replaces the built-in record wholesale and keeps its position, so
// listing order does not shuffle when a user pins one agent.
func TestLoadAgentRegistry_MergeOverridesInPlace(t *testing.T) {
	before, _ := LoadBuiltinAgentRegistry()
	writeUserRegistry(t, `{"version":1,"agents":[
	  {"id":"claude-opus","cli":"claude","model":"opus-4.5","effort_levels":["low"],"default_effort":"low"}
	]}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if len(reg.Records()) != before.BuiltinCount() {
		t.Fatalf("%d records, want %d (override, not append)", len(reg.Records()), before.BuiltinCount())
	}
	rec := find(t, reg, "claude-opus")
	if rec.Model != "opus-4.5" || rec.Source != SourceUser {
		t.Fatalf("record = %+v, want the user's model and source", rec)
	}
	// Whole-record replacement: fields the user omitted are gone, not inherited.
	if rec.ChromeCapable {
		t.Fatal("chrome_capable must not survive from the built-in record")
	}
	wantPos := indexOf(before.IDs(), "claude-opus")
	if gotPos := indexOf(reg.IDs(), "claude-opus"); gotPos != wantPos {
		t.Fatalf("claude-opus at %d, want its built-in position %d (%v)", gotPos, wantPos, reg.IDs())
	}
}

func TestLoadAgentRegistry_Restrict(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"builtins":"restrict","agents":[
	  {"id":"only-mine","cli":"x","default":true}
	]}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if got := reg.IDs(); len(got) != 1 {
		t.Fatalf("ids = %v, want only the user's record", got)
	}
}

func TestLoadAgentRegistry_RejectsLegacyReplace(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"builtins":"replace","agents":[]}`)

	if _, err := LoadAgentRegistry(); err == nil {
		t.Fatal("LoadAgentRegistry accepted legacy builtins=replace")
	}
}

func TestLoadAgentRegistry_UserDefaultRetiresBuiltinDefault(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[{"id":"mine","cli":"x","default":true}]}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	def, err := reg.Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	if def.ID != "mine" {
		t.Fatalf("default = %q, want mine", def.ID)
	}
	defaults := 0
	for _, a := range reg.Records() {
		if a.Default {
			defaults++
		}
	}
	if defaults != 1 {
		t.Fatalf("%d records marked default, want exactly 1", defaults)
	}
}

func TestLoadAgentRegistry_TwoUserDefaultsLastWinsWithWarning(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[
	  {"id":"first","cli":"x","default":true},
	  {"id":"second","cli":"x","default":true}
	]}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	def, _ := reg.Default()
	if def.ID != "second" {
		t.Fatalf("default = %q, want second (last wins)", def.ID)
	}
	if !warned(reg, "default") {
		t.Fatalf("expected a duplicate-default warning, got %v", reg.Warnings())
	}
}

func TestLoadAgentRegistry_BareArrayIsAMergeLayer(t *testing.T) {
	before, _ := LoadBuiltinAgentRegistry()
	writeUserRegistry(t, `[{"id":"bare","cli":"x"}]`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if len(reg.Records()) != before.BuiltinCount()+1 {
		t.Fatalf("%d records, want %d (bare array merges)", len(reg.Records()), before.BuiltinCount()+1)
	}
	if find(t, reg, "bare").Source != SourceUser {
		t.Fatal("bare-array records are the user layer")
	}
}

// A present-but-broken file is fatal, and the error names the path. Falling back
// to the built-ins would make a typo read as "my agents vanished".
func TestLoadAgentRegistry_MalformedIsFatal(t *testing.T) {
	cases := map[string]string{
		"bad json":        `{"version":1,"agents":[`,
		"bad version":     `{"version":2,"agents":[]}`,
		"bad builtins":    `{"version":1,"builtins":"clobber","agents":[]}`,
		"array of scalar": `["claude-opus"]`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeUserRegistry(t, body)
			_, err := LoadAgentRegistry()
			if err == nil {
				t.Fatal("expected a fatal error")
			}
			if !strings.Contains(err.Error(), path) {
				t.Fatalf("error %q does not name the path %q", err, path)
			}
		})
	}
}

// Provenance is the loader's to assign. A file claiming source:"builtin" for its
// own record cannot launder it into the built-in layer.
func TestLoadAgentRegistry_SourceCannotBeSpoofed(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[{"id":"sneaky","cli":"x","source":"builtin"}]}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if got := find(t, reg, "sneaky").Source; got != SourceUser {
		t.Fatalf("source = %q, want user", got)
	}
}

func TestLoadAgentRegistry_DanglingAliasWarnsThenErrorsOnResolve(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[{"id":"ghost","alias_of":"not-a-thing"}]}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("a dangling alias must load (and warn), not fail: %v", err)
	}
	if !warned(reg, "not-a-thing") {
		t.Fatalf("expected a dangling-alias warning, got %v", reg.Warnings())
	}
	if _, _, err := reg.Resolve("ghost", "", false); err == nil {
		t.Fatal("resolving a dangling alias must error")
	}
}

func TestLoadAgentRegistry_UnknownFieldWarnsButLoads(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[{"id":"mine","cli":"x","turbo":true}]}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("an unknown field must warn, not fail: %v", err)
	}
	find(t, reg, "mine")
	if !warned(reg, "turbo") {
		t.Fatalf("expected an unknown-field warning, got %v", reg.Warnings())
	}
}

func TestUserAgentsPath_ExpandsTilde(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("FELT_AGENTS_FILE", "~/somewhere/agents.json")

	got, err := UserAgentsPath()
	if err != nil {
		t.Fatalf("UserAgentsPath: %v", err)
	}
	if want := filepath.Join(home, "somewhere", "agents.json"); got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}

func warned(reg *AgentRegistry, substr string) bool {
	for _, w := range reg.Warnings() {
		if strings.Contains(w, substr) {
			return true
		}
	}
	return false
}

func indexOf(list []string, want string) int {
	for i, s := range list {
		if s == want {
			return i
		}
	}
	return -1
}

// ---- overrides ----------------------------------------------------------------

func TestOverrides_PatchBuiltinDefaultEffort(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[],"overrides":{"claude-opus":{"default_effort":"high"}}}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	opus := find(t, reg, "claude-opus")
	if opus.DefaultEffort != "high" || opus.DefaultEffortSource != DefaultEffortOverride {
		t.Fatalf("claude-opus default_effort = %q (%q), want high (override)", opus.DefaultEffort, opus.DefaultEffortSource)
	}
	if opus.Source != SourceBuiltin {
		t.Fatalf("an override must not move a record's layer: source %q", opus.Source)
	}
	if sonnet := find(t, reg, "claude-sonnet"); sonnet.DefaultEffortSource != "" {
		t.Fatalf("an unnamed agent must not be marked: %+v", sonnet)
	}
	_, axes, err := reg.Resolve("claude-opus", "", false)
	if err != nil || axes.Effort != "high" {
		t.Fatalf("Resolve effort = %q, %v; want high", axes.Effort, err)
	}
}

func TestOverrides_ReachUserRecords(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[{"id":"mine","cli":"x","effort_levels":["a","b"],"default_effort":"a"}],
		"overrides":{"mine":{"default_effort":"b"}}}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if got := find(t, reg, "mine").DefaultEffort; got != "b" {
		t.Fatalf("default_effort = %q, want b", got)
	}
}

func TestOverrides_AliasLandsOnCanonical(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[{"id":"deep","alias_of":"claude-opus","axes":{"chrome":true}}],
		"overrides":{"deep":{"default_effort":"max"},"gpt-6-astra":{"default_effort":"ultra"}}}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if got := find(t, reg, "claude-opus").DefaultEffort; got != "max" {
		t.Fatalf("alias record → claude-opus default_effort = %q, want max", got)
	}
	if got := find(t, reg, "codex-astra").DefaultEffort; got != "ultra" {
		t.Fatalf("aliases entry → codex-astra default_effort = %q, want ultra", got)
	}
	if find(t, reg, "deep").DefaultEffortSource != "" {
		t.Fatal("the alias record itself must stay untouched")
	}
}

func TestOverrides_LoudFailures(t *testing.T) {
	cases := map[string]string{
		"invalid level":      `{"overrides":{"claude-opus":{"default_effort":"ludicrous"}}}`,
		"unknown agent":      `{"overrides":{"no-such-agent":{"default_effort":"high"}}}`,
		"unknown field":      `{"overrides":{"claude-opus":{"default_effort":"high","model":"x"}}}`,
		"empty override":     `{"overrides":{"claude-opus":{}}}`,
		"no effort axis":     `{"agents":[{"id":"flat","cli":"x"}],"overrides":{"flat":{"default_effort":"high"}}}`,
		"two keys, one base": `{"overrides":{"codex-astra":{"default_effort":"high"},"gpt-6-astra":{"default_effort":"low"}}}`,
		"dangling alias":     `{"agents":[{"id":"ghost","alias_of":"nope"}],"overrides":{"ghost":{"default_effort":"high"}}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeUserRegistry(t, body)
			_, err := LoadAgentRegistry()
			if err == nil {
				t.Fatal("expected a load error")
			}
			if !strings.Contains(err.Error(), path) {
				t.Fatalf("error should name the file: %v", err)
			}
		})
	}
}

func TestOverrides_ProvenanceCannotBeSpoofed(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"agents":[{"id":"sneaky","cli":"x","default_effort_source":"override"}]}`)

	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if got := find(t, reg, "sneaky").DefaultEffortSource; got != "" {
		t.Fatalf("default_effort_source = %q, want empty", got)
	}
}

// ---- the override writer --------------------------------------------------------

func TestSetEffortOverride_RoundTripPreservesTheFile(t *testing.T) {
	path := writeUserRegistry(t, `{
  "builtins": "merge",
  "comment": {"why": "kept"},
  "agents": [
    {"id": "zeta", "cli": "z", "effort_levels": ["lo", "hi"]},
    {"id": "alpha", "cli": "a", "turbo": true}
  ],
  "version": 1
}`)

	_, id, changed, err := SetEffortOverride("claude-opus", "high")
	if err != nil || !changed || id != "claude-opus" {
		t.Fatalf("set = %q, %v, %v", id, changed, err)
	}
	if _, _, _, err := SetEffortOverride("zeta", "hi"); err != nil {
		t.Fatalf("set zeta: %v", err)
	}
	body := readFile(t, path)
	for _, want := range []string{`"comment": {`, `"why": "kept"`, `"turbo": true`, `"overrides": {`} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %s after set:\n%s", want, body)
		}
	}
	if order := []int{strings.Index(body, `"builtins"`), strings.Index(body, `"comment"`), strings.Index(body, `"agents"`),
		strings.Index(body, `"zeta"`), strings.Index(body, `"alpha"`), strings.Index(body, `"version"`),
		strings.Index(body, `"overrides"`)}; !ascending(order) {
		t.Fatalf("keys or agents reordered (%v):\n%s", order, body)
	}
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if find(t, reg, "claude-opus").DefaultEffort != "high" || find(t, reg, "zeta").DefaultEffort != "hi" {
		t.Fatalf("overrides not applied:\n%s", body)
	}

	for _, name := range []string{"claude-opus", "zeta"} {
		if _, _, changed, err := SetEffortOverride(name, ""); err != nil || !changed {
			t.Fatalf("reset %s = %v, %v", name, changed, err)
		}
	}
	if _, _, changed, err := SetEffortOverride("claude-opus", ""); err != nil || changed {
		t.Fatalf("a second reset should be a no-op: %v, %v", changed, err)
	}
	body = readFile(t, path)
	if strings.Contains(body, "overrides") {
		t.Fatalf("an empty overrides block should be dropped:\n%s", body)
	}
	if !strings.Contains(body, `"why": "kept"`) || !strings.Contains(body, `"turbo": true`) {
		t.Fatalf("reset lost content:\n%s", body)
	}
}

func TestSetEffortOverride_AliasKeysByCanonicalAndReplacesAliasKey(t *testing.T) {
	path := writeUserRegistry(t, `{"version":1,"agents":[],"overrides":{"gpt-6-astra":{"default_effort":"low"}}}`)

	_, id, _, err := SetEffortOverride("gpt-6-astra", "max")
	if err != nil || id != "codex-astra" {
		t.Fatalf("set via alias = %q, %v", id, err)
	}
	body := readFile(t, path)
	if strings.Contains(body, "gpt-6-astra") || !strings.Contains(body, `"codex-astra"`) {
		t.Fatalf("override should be keyed by the canonical id alone:\n%s", body)
	}
}

func TestSetEffortOverride_Refusals(t *testing.T) {
	path := writeUserRegistry(t, `{"version":1,"agents":[]}`)
	before := readFile(t, path)

	if _, _, _, err := SetEffortOverride("claude-opus", "ludicrous"); err == nil {
		t.Fatal("an effort outside effort_levels must be refused")
	}
	if _, _, _, err := SetEffortOverride("no-such-agent", "high"); err == nil {
		t.Fatal("an unknown agent must be refused")
	}
	if readFile(t, path) != before {
		t.Fatal("a refused edit must leave the file untouched")
	}
}

func TestSetEffortOverride_CreatesMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "agents.json")
	t.Setenv("FELT_AGENTS_FILE", path)

	if _, _, changed, err := SetEffortOverride("claude-opus", ""); err != nil || changed {
		t.Fatalf("resetting with no file = %v, %v; want a no-op", changed, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("a no-op reset must not create the file")
	}
	if _, _, _, err := SetEffortOverride("claude-opus", "high"); err != nil {
		t.Fatalf("set: %v", err)
	}
	want := `{
  "version": 1,
  "builtins": "merge",
  "agents": [],
  "overrides": {
    "claude-opus": {
      "default_effort": "high"
    }
  }
}
`
	if got := readFile(t, path); got != want {
		t.Fatalf("created file:\n%s\nwant:\n%s", got, want)
	}
}

func TestSetEffortOverride_ConvertsBareArray(t *testing.T) {
	path := writeUserRegistry(t, `[{"id":"mine","cli":"x","effort_levels":["a","b"]}]`)

	if _, _, _, err := SetEffortOverride("mine", "b"); err != nil {
		t.Fatalf("set: %v", err)
	}
	body := readFile(t, path)
	if !strings.HasPrefix(body, "{\n  \"version\": 1,\n  \"builtins\": \"merge\",\n  \"agents\": [") {
		t.Fatalf("bare array should become the object form:\n%s", body)
	}
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if rec := find(t, reg, "mine"); rec.DefaultEffort != "b" || rec.Source != SourceUser {
		t.Fatalf("mine = %+v", rec)
	}
}

func TestSetEffortOverride_RefusesABrokenFile(t *testing.T) {
	writeUserRegistry(t, `{"version":1,"overrides":{"claude-opus":{"default_effort":"ludicrous"}}}`)
	if _, _, _, err := SetEffortOverride("claude-sonnet", "high"); err == nil {
		t.Fatal("an edit must not build on a registry that fails to load")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(body)
}

func ascending(xs []int) bool {
	for i := range xs {
		if xs[i] < 0 || (i > 0 && xs[i] <= xs[i-1]) {
			return false
		}
	}
	return true
}
