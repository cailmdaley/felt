package cmd

import (
	"github.com/cailmdaley/felt/internal/felt"
)

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
