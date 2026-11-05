package shuttle

import (
	"fmt"
	"strconv"
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
	path := ""
	for _, line := range header {
		prefix := ""
		for _, p := range []string{"--- ", "+++ ", "rename to "} {
			if strings.HasPrefix(line, p) {
				prefix = p
				break
			}
		}
		if prefix == "" {
			continue
		}
		name := strings.TrimPrefix(line, prefix)
		if prefix != "rename to " {
			name = strings.TrimSuffix(name, "\t")
		}
		if strings.HasPrefix(name, `"`) {
			decoded, err := strconv.Unquote(name)
			if err != nil {
				return nil
			}
			name = decoded
		}
		if name == "/dev/null" {
			continue
		}
		if prefix != "rename to " {
			name = name[2:]
		}
		path = name
	}
	for i := range c.Files {
		f := &c.Files[i]
		if f.Path == path || (path == "" && header[0] == "diff --git "+changeQuotePath("a/"+f.Path)+" "+changeQuotePath("b/"+f.Path)) {
			return f
		}
	}
	return nil
}
