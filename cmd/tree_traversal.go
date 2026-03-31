package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
)

var (
	graphFormat  string
	upDownDetail string
	traversalAll bool
)

// traversalConfig captures the differences between upstream and downstream traversal.
type traversalConfig struct {
	getRelated func(g *felt.Graph, id string) []string
	edgeLabel  func(g *felt.Graph, fiberID, relatedID string) string
	emptyMsg   string
}

// runTraversal implements the shared logic for tree --up/--down.
func runTraversal(fiberArg string, cfg traversalConfig) error {
	root, err := felt.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("not in a felt repository")
	}

	if upDownDetail != "" {
		if err := validateDepth(upDownDetail); err != nil {
			return err
		}
	}

	storage := felt.NewStorage(root)
	var felts []*felt.Felt
	if jsonOutput {
		felts, err = storage.ListMetadataWithModTime()
	} else {
		felts, err = storage.ListMetadata()
	}
	if err != nil {
		return err
	}

	f, err := felt.FindByPrefix(felts, fiberArg)
	if err != nil {
		return err
	}

	g := felt.BuildGraph(felts)
	related := cfg.getRelated(g, f.ID)

	if jsonOutput {
		var deps []*felt.Felt
		for _, id := range related {
			if dep := g.Nodes[id]; dep != nil {
				deps = append(deps, dep)
			}
		}
		return outputJSON(deps)
	}

	if len(related) == 0 {
		fmt.Println(cfg.emptyMsg)
		return nil
	}

	if upDownDetail != "" {
		for i, id := range related {
			dep := g.Nodes[id]
			if dep != nil {
				fmt.Print(renderFelt(dep, g, upDownDetail))
				if upDownDetail != DepthTitle && i < len(related)-1 {
					fmt.Println()
				}
			}
		}
		return nil
	}

	for _, id := range related {
		dep := g.Nodes[id]
		if dep != nil {
			label := cfg.edgeLabel(g, f.ID, id)
			if label != "" {
				fmt.Printf("%s %s  %s [%s]\n", felt.StatusIcon(dep.Status), dep.ID, dep.Title, label)
			} else {
				fmt.Printf("%s %s  %s\n", felt.StatusIcon(dep.Status), dep.ID, dep.Title)
			}
		}
	}

	return nil
}

// edgeLabelInGraph finds the label on the edge from depID to dependentID.
func edgeLabelInGraph(g *felt.Graph, depID, dependentID string) string {
	for _, d := range g.Upstream[dependentID] {
		if d.ID == depID {
			return d.Label
		}
	}
	return ""
}
