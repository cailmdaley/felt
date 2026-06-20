package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// mechRenderOpts parameterizes formatMechanicalEvent so the two surfaces that
// render mechanical events keep their distinct output shapes while sharing the
// rendering logic.
//
//   - padType: pad the event type to a 13-wide column ("[%-13s %s]"). The
//     `felt history` listing aligns its rows; `felt show`'s trailer does not.
//   - withChars: append a ", N chars" clause to the size parenthetical when a
//     size_chars payload value is present. Only `felt history` shows char counts.
type mechRenderOpts struct {
	padType   bool
	withChars bool
}

// formatMechanicalEvent renders one mechanical (add/edit/external_edit) event as
// a single line WITHOUT a trailing newline. The base form is:
//
//	2026-04-01 15:04:05 [edit actor] hash=abc12345 (12 lines) — name,status
//
// With opts.padType the type is left-padded to 13 columns; with opts.withChars
// the size parenthetical gains a ", N chars" segment when size_chars is set.
func formatMechanicalEvent(e felt.Event, opts mechRenderOpts) string {
	var sb strings.Builder
	timestamp := e.OccurredAt.Local().Format("2006-01-02 15:04:05")
	if opts.padType {
		fmt.Fprintf(&sb, "%s [%-13s %s] hash=%s", timestamp, e.Type, e.Actor, shortHash(e.ContentHash))
	} else {
		fmt.Fprintf(&sb, "%s [%s %s] hash=%s", timestamp, e.Type, e.Actor, shortHash(e.ContentHash))
	}
	if lines := intField(e.Payload, "size_lines"); lines > 0 {
		fmt.Fprintf(&sb, " (%d lines", lines)
		if opts.withChars {
			if chars := intField(e.Payload, "size_chars"); chars > 0 {
				fmt.Fprintf(&sb, ", %d chars", chars)
			}
		}
		sb.WriteString(")")
	}
	if fields := stringSliceField(e.Payload, "fields_changed"); len(fields) > 0 {
		fmt.Fprintf(&sb, " — %s", strings.Join(fields, ","))
	}
	return sb.String()
}

// recordMechanical appends one mechanical history event (add/edit/rm)
// for a CLI action. It is a best-effort write: index errors do not
// fail the user's command, since the mutation already succeeded on
// disk and the next OpenIndex/Sync will catch the file via hash-on-read.
//
// fieldsChanged is the list of frontmatter/body fields touched (for
// edit events). For add events pass {"all"}. For rm events pass nil.
//
// post is the file's bytes after the mutation; it is hashed and used
// to size the payload. For rm events pass nil.
func recordMechanical(
	storage *felt.Storage,
	fiberID string,
	eventType string,
	fieldsChanged []string,
	post []byte,
) {
	idx, err := storage.OpenIndexNoSync()
	if err != nil {
		return
	}
	defer idx.Close()

	event := felt.Event{
		FiberID: fiberID,
		Type:    eventType,
		Actor:   felt.DefaultActor(),
	}
	payload := map[string]interface{}{}
	if len(fieldsChanged) > 0 {
		payload["fields_changed"] = fieldsChanged
	}
	if post != nil {
		event.ContentHash = felt.HashBytes(post)
		lines := 0
		for _, b := range post {
			if b == '\n' {
				lines++
			}
		}
		if len(post) > 0 && post[len(post)-1] != '\n' {
			lines++
		}
		payload["size_lines"] = lines
		payload["size_chars"] = len(post)
	}
	if len(payload) > 0 {
		event.Payload = payload
	}
	_ = idx.AppendEvent(event)
}
