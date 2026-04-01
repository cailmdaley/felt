package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var retiredCommandPhrases = []string{
	"felt tag ",
	"felt untag ",
	"felt link ",
	"felt unlink ",
	"felt upstream ",
	"felt downstream ",
	"felt graph ",
	"felt ready ",
	"felt find ",
	"felt prime ",
	"felt check ",
	"felt tapestry export",
}

func TestGeneratedGuidanceAvoidsRetiredCommands(t *testing.T) {
	for name, text := range map[string]string{
		"cliReference":    cliReference(),
		"claudeMDSnippet": claudeMDSnippet(),
		"minimalOutput":   minimalOutput(),
	} {
		for _, phrase := range retiredCommandPhrases {
			if strings.Contains(text, phrase) {
				t.Fatalf("%s contains retired command phrase %q", name, phrase)
			}
		}
	}
}

func TestBundledSkillsAvoidRetiredCommands(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	err = filepath.Walk(filepath.Join(root, "skills"), func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(data)
		for _, phrase := range retiredCommandPhrases {
			if strings.Contains(text, phrase) {
				t.Fatalf("%s contains retired command phrase %q", path, phrase)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk skills: %v", err)
	}
}
