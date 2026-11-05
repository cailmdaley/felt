package shuttle

import (
	"fmt"
	"strings"
)

// Git quotes control bytes and UTF-8 bytes using C escapes with core.quotePath=true.
func changeQuotePath(path string) string {
	quote := false
	var out strings.Builder
	for _, b := range []byte(path) {
		switch b {
		case '\\', '"':
			out.WriteByte('\\')
			out.WriteByte(b)
			quote = true
		case '\a':
			out.WriteString(`\a`)
			quote = true
		case '\b':
			out.WriteString(`\b`)
			quote = true
		case '\t':
			out.WriteString(`\t`)
			quote = true
		case '\n':
			out.WriteString(`\n`)
			quote = true
		case '\v':
			out.WriteString(`\v`)
			quote = true
		case '\f':
			out.WriteString(`\f`)
			quote = true
		case '\r':
			out.WriteString(`\r`)
			quote = true
		default:
			if b < 32 || b >= 127 {
				fmt.Fprintf(&out, `\%03o`, b)
				quote = true
			} else {
				out.WriteByte(b)
			}
		}
	}
	if quote {
		return `"` + out.String() + `"`
	}
	return path
}

func (c *Change) patchFile(header []string) *ChangeFile {
	for i := range c.Files {
		f := &c.Files[i]
		oldPath := f.OldPath
		if oldPath == "" {
			oldPath = f.Path
		}
		if header[0] == "diff --git "+changeQuotePath("a/"+oldPath)+" "+changeQuotePath("b/"+f.Path) {
			return f
		}
	}
	return nil
}
