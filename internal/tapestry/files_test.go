package tapestry

import (
	"reflect"
	"testing"
)

func TestFindLinkedFiles(t *testing.T) {
	text := "" +
		"Code `docs/report.pdf` and `./src/main.go:L42` and `../notes/run.txt:12`.\n" +
		"Links [plot](figures/output.png) [range](./data/table.csv:L42-55) [url](https://example.com/a.txt).\n" +
		"Ignore `plainword.txt` and [site](http://example.com/file.pdf)."

	want := []string{
		"figures/output.png",
		"./data/table.csv",
		"docs/report.pdf",
		"./src/main.go",
		"../notes/run.txt",
	}

	if got := findLinkedFiles(text); !reflect.DeepEqual(got, want) {
		t.Fatalf("findLinkedFiles() = %#v, want %#v", got, want)
	}
}

func TestFlatName(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{
			path: "docs/unions_release/unions_bmodes/build/unions_bmodes.pdf",
			want: "docs_unions_release_unions_bmodes_build_unions_bmodes.pdf",
		},
		{path: "./src/main.go", want: "src_main.go"},
		{path: "../notes/run.txt", want: "notes_run.txt"},
	}

	for _, tt := range tests {
		if got := flatName(tt.path); got != tt.want {
			t.Fatalf("flatName(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestRewriteFileLinks(t *testing.T) {
	text := "" +
		"See `src/main.go:L42` and `docs/report.pdf`.\n" +
		"Open [report](docs/report.pdf:12) and [image](figures/output.png)."
	rewriteMap := map[string]string{
		"src/main.go":        "files/src_main.go",
		"docs/report.pdf":    "files/docs_report.pdf",
		"figures/output.png": "files/figures_output.png",
	}

	got := rewriteFileLinks(text, rewriteMap)
	want := "" +
		"See `files/src_main.go:L42` and `files/docs_report.pdf`.\n" +
		"Open [report](files/docs_report.pdf:12) and [image](files/figures_output.png)."

	if got != want {
		t.Fatalf("rewriteFileLinks() = %q, want %q", got, want)
	}
}
