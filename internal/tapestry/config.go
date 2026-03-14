package tapestry

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

func ReadConfig(projectRoot string) (map[string]any, error) {
	for _, rel := range []string{"config/config.yaml", "workflow/config/config.yaml"} {
		path := filepath.Join(projectRoot, rel)
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("read config %s: %w", rel, err)
		}

		var raw any
		if err := yaml.Unmarshal(data, &raw); err != nil {
			return nil, fmt.Errorf("parse config %s: %w", rel, err)
		}

		flat := map[string]any{}
		flattenConfig("", normalizeYAML(raw), flat)
		return flat, nil
	}

	return nil, nil
}

func normalizeYAML(v any) any {
	switch value := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(value))
		for k, child := range value {
			out[k] = normalizeYAML(child)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(value))
		for k, child := range value {
			out[fmt.Sprint(k)] = normalizeYAML(child)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, child := range value {
			out[i] = normalizeYAML(child)
		}
		return out
	default:
		return value
	}
}

func flattenConfig(prefix string, value any, out map[string]any) {
	if m, ok := value.(map[string]any); ok {
		for key, child := range m {
			next := key
			if prefix != "" {
				next = prefix + "." + key
			}
			flattenConfig(next, child, out)
		}
		return
	}
	if prefix != "" {
		out[prefix] = value
	}
}
