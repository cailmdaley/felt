package tapestry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Evidence struct {
	Metrics       map[string]any    `json:"metrics"`
	Artifacts     map[string]string `json:"artifacts"`
	MTime         int64             `json:"mtime"`
	Generated     string            `json:"generated"`
	ArtifactPaths map[string]string `json:"-"`
}

type rawEvidence struct {
	Evidence  map[string]any    `json:"evidence"`
	Output    map[string]string `json:"output"`
	Generated string            `json:"generated"`
}

func ReadEvidence(projectRoot, specName string) (*Evidence, error) {
	path := filepath.Join(projectRoot, "results", "tapestry", specName, "evidence.json")
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("stat evidence for %s: %w", specName, err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read evidence for %s: %w", specName, err)
	}

	var raw rawEvidence
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse evidence for %s: %w", specName, err)
	}

	evidence := &Evidence{
		Metrics:       raw.Evidence,
		Artifacts:     map[string]string{},
		MTime:         info.ModTime().UnixMilli(),
		Generated:     raw.Generated,
		ArtifactPaths: map[string]string{},
	}
	if evidence.Metrics == nil {
		evidence.Metrics = map[string]any{}
	}

	for key, name := range raw.Output {
		if !isImageArtifact(name) {
			continue
		}
		evidence.Artifacts[key] = name
		evidence.ArtifactPaths[key] = filepath.Join(projectRoot, "results", "tapestry", specName, name)
	}

	return evidence, nil
}

func ComputeStaleness(fiberID string, graph upstreamGraph, evidenceByID map[string]*Evidence) string {
	current := evidenceByID[fiberID]
	if current == nil {
		return "no-evidence"
	}

	for _, upstreamID := range graph.GetUpstream(fiberID) {
		upstream := evidenceByID[upstreamID]
		if upstream != nil && upstream.MTime > current.MTime {
			return "stale"
		}
	}

	return "fresh"
}

func isImageArtifact(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".pdf":
		return true
	default:
		return false
	}
}
