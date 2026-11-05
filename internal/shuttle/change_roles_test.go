package shuttle

import "testing"

func TestChangeRole(t *testing.T) {
	cases := map[string]string{
		"cmd/main.go": "implementation", "src/component.ts": "implementation",
		"analysis/measure.py": "implementation", "lib/app.ex": "implementation",
		"tests/catalog.py": "test", "test/test_helper.exs": "test",
		"ui/e2e/workspace.mjs": "test", "ui/harness/example.ts": "test",
		"ui/harness/fixtures/snapshot.json": "test", "tests/fixtures/data.bin": "test",
		"analysis/test_shear.py": "test", "pkg/server_test.go": "test",
		"src/a.test.ts": "test", "src/a.spec.tsx": "test", "test/app_test.exs": "test",
		"package-lock.json": "generated", "uv.lock": "generated", "go.sum": "generated",
		"mix.lock": "generated", "ui/harness/fixtures/example.change.json": "generated",
		"ui/public/change-reader-NOTICES.txt": "generated", "THIRD_PARTY_LICENSES": "generated",
		"NOTICE": "generated", "LICENSE": "generated", "licence-inventory.txt": "generated",
		"config/pipeline.json": "config", ".github/workflows/test.yml": "config",
		"dist/bundle.js": "generated", "src/__generated__/api.ts": "generated",
		"api/service.pb.go": "generated", "src/model.generated.ts": "generated",
		"docs/concepts/change.md": "docs", "README.md": "docs",
	}
	for file, want := range cases {
		if got := ChangeRole(file); got != want {
			t.Errorf("ChangeRole(%q) = %q, want %q", file, got, want)
		}
	}
}
