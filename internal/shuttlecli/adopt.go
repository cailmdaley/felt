package shuttlecli

import (
	"fmt"
	"os"
	"reflect"
	"slices"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// adoptCmd is the owner's half of a remote resume or dispatch that carries the
// caller's document. The owning daemon runs it inside its Poller before the
// verb, so the owner judges the constitution the caller sees rather than its
// own copy, which may predate the caller's edit until Git catches up.
//
// The owner holds a constitution when its copy carries a shuttle: block naming
// this host. A held copy stands, since the caller's mirror is often older than
// the owner's worker-written state; --carry replaces it anyway, keeping its
// runtime. A copy the owner does not hold takes the caller's document.
func (a *app) adoptCmd() *cobra.Command {
	var documentFile string
	var carry bool
	cmd := &cobra.Command{
		Use:    "adopt <fiber>",
		Short:  "Take a caller's version of a constitution this host owns",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := os.ReadFile(a.env.Resolve(documentFile))
			if err != nil {
				return fmt.Errorf("reading carried document: %w", err)
			}
			carried, err := felt.Parse("", data)
			if err != nil {
				return fmt.Errorf("parsing carried document: %w", err)
			}
			carriedBlock, ok, err := shuttle.BlockOf(carried)
			if err != nil {
				return fmt.Errorf("carried document: %w", err)
			}
			if !ok {
				return fmt.Errorf("the caller's document for %s has no shuttle: block", args[0])
			}
			own, err := a.resolveOwnHost("")
			if err != nil {
				return err
			}
			if carriedBlock.Host != own {
				return fmt.Errorf("the caller's document for %s names host %q; this host is %q", args[0], carriedBlock.Host, own)
			}

			f, st, _, err := a.shuttleResolveFiberRef(args[0], true)
			if err != nil {
				return err
			}
			if st == nil {
				return fmt.Errorf("fiber %s is not in this host's stores", args[0])
			}
			local, unlock, err := lockAndReloadFiber(st, f)
			if err != nil {
				return err
			}
			defer unlock()
			if carried.UID != "" && local.UID != "" && carried.UID != local.UID {
				return fmt.Errorf("the caller's document for %s has id %s; this host's copy has id %s", local.ID, carried.UID, local.UID)
			}

			differs, err := documentDifferences(carried, local)
			if err != nil {
				return err
			}
			localBlock, hasBlock, err := shuttle.BlockOf(local)
			if err != nil {
				return err
			}
			held := hasBlock && localBlock.Host == own
			if held && !carry {
				if len(differs) > 0 {
					fmt.Fprintf(a.env.Stdout, "note: this host's copy of %s differs from the caller's (%s) and stands; --carry sends the caller's version\n", local.ID, strings.Join(differs, ", "))
				}
				return nil
			}

			carried.ID, carried.Path = local.ID, local.Path
			if carried.UID == "" {
				carried.UID = local.UID
			}
			facet := carried.ExtraFields[shuttle.FacetKey]
			felt.RemoveMappingKey(facet, shuttle.RuntimeKey)
			if runtime := felt.MappingValueNode(local.ExtraFields[shuttle.FacetKey], shuttle.RuntimeKey); held && runtime != nil {
				facet.Content = append(facet.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: shuttle.RuntimeKey}, runtime)
			}
			if err := a.writeFiber(st, carried); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}

			was := "no shuttle: block"
			switch {
			case held:
				was = "its own constitution, overridden by --carry"
			case hasBlock:
				was = fmt.Sprintf("a shuttle: block for host %q", localBlock.Host)
			}
			difference := "no differences"
			if len(differs) > 0 {
				difference = "differs: " + strings.Join(differs, ", ")
			}
			fmt.Fprintf(a.env.Stdout, "%s took the caller's version of %s (was: %s; %s)\n", own, local.ID, was, difference)
			return nil
		},
	}
	cmd.Flags().StringVar(&documentFile, "document-file", "", "The caller's fiber file")
	_ = cmd.MarkFlagRequired("document-file")
	cmd.Flags().BoolVar(&carry, "carry", false, "Replace this host's copy even when it holds the constitution")
	return cmd
}

// adoptVolatileKeys change with the lifecycle on either host and say nothing
// about which version of the constitution a copy is.
var adoptVolatileKeys = []string{"status", "horizon", "updated-at", "closed-at", "tempered"}

// documentDifferences names what differs between two copies of a fiber: "body",
// then each top-level frontmatter key, ignoring the volatile keys and the
// shuttle block's runtime and ask.
func documentDifferences(carried, local *felt.Felt) ([]string, error) {
	var differs []string
	if strings.TrimRight(carried.Body, " \t\n") != strings.TrimRight(local.Body, " \t\n") {
		differs = append(differs, "body")
	}
	a, err := comparableFrontmatter(carried)
	if err != nil {
		return nil, err
	}
	b, err := comparableFrontmatter(local)
	if err != nil {
		return nil, err
	}
	var keys []string
	for key := range a {
		keys = append(keys, key)
	}
	for key := range b {
		if _, ok := a[key]; !ok {
			keys = append(keys, key)
		}
	}
	slices.Sort(keys)
	for _, key := range keys {
		if !reflect.DeepEqual(a[key], b[key]) {
			differs = append(differs, key)
		}
	}
	return differs, nil
}

func comparableFrontmatter(f *felt.Felt) (map[string]any, error) {
	data, err := f.Marshal()
	if err != nil {
		return nil, err
	}
	frontmatter, _, err := felt.SplitFrontmatter(data, false)
	if err != nil {
		return nil, err
	}
	fields := map[string]any{}
	if err := yaml.Unmarshal(frontmatter, &fields); err != nil {
		return nil, err
	}
	for _, key := range adoptVolatileKeys {
		delete(fields, key)
	}
	if block, ok := fields[shuttle.FacetKey].(map[string]any); ok {
		delete(block, shuttle.RuntimeKey)
		delete(block, "ask")
	}
	return fields, nil
}
