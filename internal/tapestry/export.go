package tapestry

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

type ExportOptions struct {
	AllFibers bool
	Force     bool
	Name      string
}

type upstreamGraph interface {
	GetUpstream(id string) []string
}

type exportPayload struct {
	Nodes      []Node                  `json:"nodes"`
	Links      []Link                  `json:"links"`
	Downstream map[string][]Downstream `json:"downstream"`
	Config     map[string]any          `json:"config"`
	Fibers     []Fiber                 `json:"fibers"`
}

type Node struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Kind      string     `json:"kind"`
	Status    string     `json:"status"`
	Body      string     `json:"body"`
	Outcome   string     `json:"outcome"`
	Tags      []string   `json:"tags"`
	CreatedAt time.Time  `json:"createdAt"`
	ClosedAt  *time.Time `json:"closedAt"`
	DependsOn []string   `json:"dependsOn"`
	SpecName  string     `json:"specName"`
	Staleness string     `json:"staleness"`
	Evidence  *Evidence  `json:"evidence"`
}

type Fiber struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Kind      string     `json:"kind"`
	Status    string     `json:"status"`
	Body      string     `json:"body"`
	Outcome   string     `json:"outcome"`
	Tags      []string   `json:"tags"`
	CreatedAt time.Time  `json:"createdAt"`
	ClosedAt  *time.Time `json:"closedAt"`
	DependsOn []string   `json:"dependsOn"`
}

type Link struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

type Downstream struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Kind   string `json:"kind"`
}

type manifestEntry struct {
	Name      string `json:"name"`
	NodeCount int    `json:"nodeCount"`
	Updated   string `json:"updated"`
}

func Export(projectRoot, outDir string, options ExportOptions) error {
	storage := felt.NewStorage(projectRoot)
	felts, err := storage.List()
	if err != nil {
		return err
	}

	graph := felt.BuildGraph(felts)
	tapestryFelts, specByID := tapestryNodes(felts)
	evidenceByID := map[string]*Evidence{}
	for _, f := range tapestryFelts {
		evidenceByID[f.ID], err = ReadEvidence(projectRoot, specByID[f.ID])
		if err != nil {
			return err
		}
	}

	payload := exportPayload{
		Nodes:      buildNodes(tapestryFelts, graph, specByID, evidenceByID),
		Links:      buildLinks(tapestryFelts, specByID),
		Downstream: buildDownstream(tapestryFelts, graph),
		Fibers:     []Fiber{},
	}
	payload.Config, err = ReadConfig(projectRoot)
	if err != nil {
		return err
	}
	if options.AllFibers {
		payload.Fibers = buildFibers(felts)
	}

	if err := os.MkdirAll(filepath.Join(outDir, "tapestry"), 0755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	if err := copyArtifacts(outDir, specByID, evidenceByID, options.Force); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(outDir, "tapestry.json"), payload); err != nil {
		return err
	}
	if err := updateManifest(filepath.Join(filepath.Dir(outDir), "manifest.json"), options.Name, len(payload.Nodes)); err != nil {
		return err
	}

	return nil
}

func SpecName(tags []string) string {
	for _, tag := range tags {
		if spec, ok := strings.CutPrefix(tag, "tapestry:"); ok && spec != "" {
			return spec
		}
	}
	return ""
}

func tapestryNodes(felts []*felt.Felt) ([]*felt.Felt, map[string]string) {
	var nodes []*felt.Felt
	specByID := map[string]string{}
	for _, f := range felts {
		spec := SpecName(f.Tags)
		if spec == "" {
			continue
		}
		nodes = append(nodes, f)
		specByID[f.ID] = spec
	}
	sortFelts(nodes)
	return nodes, specByID
}

func buildNodes(tapestryFelts []*felt.Felt, graph *felt.Graph, specByID map[string]string, evidenceByID map[string]*Evidence) []Node {
	nodes := make([]Node, 0, len(tapestryFelts))
	for _, f := range tapestryFelts {
		nodes = append(nodes, Node{
			ID:        f.ID,
			Title:     f.Title,
			Kind:      kindFor(f),
			Status:    f.Status,
			Body:      f.Body,
			Outcome:   f.Outcome,
			Tags:      slices.Clone(f.Tags),
			CreatedAt: f.CreatedAt,
			ClosedAt:  f.ClosedAt,
			DependsOn: tapestryDependsOn(f, specByID),
			SpecName:  specByID[f.ID],
			Staleness: ComputeStaleness(f.ID, graph, evidenceByID),
			Evidence:  evidenceByID[f.ID],
		})
	}
	return nodes
}

func buildFibers(felts []*felt.Felt) []Fiber {
	sortFelts(felts)
	fibers := make([]Fiber, 0, len(felts))
	for _, f := range felts {
		fibers = append(fibers, Fiber{
			ID:        f.ID,
			Title:     f.Title,
			Kind:      kindFor(f),
			Status:    f.Status,
			Body:      f.Body,
			Outcome:   f.Outcome,
			Tags:      slices.Clone(f.Tags),
			CreatedAt: f.CreatedAt,
			ClosedAt:  f.ClosedAt,
			DependsOn: f.DependsOn.IDs(),
		})
	}
	return fibers
}

func buildLinks(tapestryFelts []*felt.Felt, specByID map[string]string) []Link {
	links := []Link{}
	for _, f := range tapestryFelts {
		for _, dep := range tapestryDependsOn(f, specByID) {
			links = append(links, Link{Source: dep, Target: f.ID})
		}
	}
	sort.Slice(links, func(i, j int) bool {
		if links[i].Source != links[j].Source {
			return links[i].Source < links[j].Source
		}
		return links[i].Target < links[j].Target
	})
	return links
}

func buildDownstream(tapestryFelts []*felt.Felt, graph *felt.Graph) map[string][]Downstream {
	downstream := map[string][]Downstream{}
	for _, f := range tapestryFelts {
		ids := graph.GetDownstream(f.ID)
		refs := make([]Downstream, 0, len(ids))
		for _, id := range ids {
			node, ok := graph.Nodes[id]
			if !ok {
				continue
			}
			refs = append(refs, Downstream{
				ID:     node.ID,
				Title:  node.Title,
				Status: node.Status,
				Kind:   kindFor(node),
			})
		}
		sort.Slice(refs, func(i, j int) bool { return refs[i].ID < refs[j].ID })
		downstream[f.ID] = refs
	}
	return downstream
}

func tapestryDependsOn(f *felt.Felt, specByID map[string]string) []string {
	deps := []string{}
	for _, dep := range f.DependsOn {
		if _, ok := specByID[dep.ID]; ok {
			deps = append(deps, dep.ID)
		}
	}
	return deps
}

func kindFor(_ *felt.Felt) string {
	return ""
}

func copyArtifacts(outDir string, specByID map[string]string, evidenceByID map[string]*Evidence, force bool) error {
	for fiberID, evidence := range evidenceByID {
		if evidence == nil {
			continue
		}
		specName := specByID[fiberID]
		for key, name := range evidence.Artifacts {
			src := evidence.ArtifactPaths[key]
			dst := filepath.Join(outDir, "tapestry", specName, name)
			if !force {
				if _, err := os.Stat(dst); err == nil {
					continue
				}
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
				return fmt.Errorf("create artifact dir for %s: %w", specName, err)
			}
			if err := copyFile(src, dst); err != nil {
				return fmt.Errorf("copy artifact %s: %w", name, err)
			}
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return nil
}

func updateManifest(path, name string, nodeCount int) error {
	entries := []manifestEntry{}
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &entries); err != nil {
			return fmt.Errorf("parse manifest: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("read manifest: %w", err)
	}

	updated := false
	now := time.Now().UTC().Format(time.RFC3339)
	for i := range entries {
		if entries[i].Name != name {
			continue
		}
		entries[i].NodeCount = nodeCount
		entries[i].Updated = now
		updated = true
	}
	if !updated {
		entries = append(entries, manifestEntry{Name: name, NodeCount: nodeCount, Updated: now})
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return writeJSON(path, entries)
}

func writeJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("create dir for %s: %w", path, err)
	}

	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	defer file.Close()

	enc := json.NewEncoder(file)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func sortFelts(felts []*felt.Felt) {
	sort.Slice(felts, func(i, j int) bool {
		if !felts[i].CreatedAt.Equal(felts[j].CreatedAt) {
			return felts[i].CreatedAt.Before(felts[j].CreatedAt)
		}
		return felts[i].ID < felts[j].ID
	})
}
