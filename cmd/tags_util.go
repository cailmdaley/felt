package cmd

import "strings"

// splitTags splits comma-separated tag input into individual tags.
// "claim, urgent" -> ["claim", "urgent"]
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
