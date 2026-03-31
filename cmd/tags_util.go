package cmd

import "strings"

// splitTags splits comma-separated tag input into individual tags.
// "claim, tapestry:foo" -> ["claim", "tapestry:foo"]
func splitTags(input string) []string {
	parts := strings.Split(input, ",")
	var tags []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			tags = append(tags, p)
		}
	}
	return tags
}
