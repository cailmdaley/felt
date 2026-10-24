package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

type migrateDocumentsRequest struct {
	Mode      string            `json:"mode"`
	Documents []migrateDocument `json:"documents"`
}

type migrateDocument struct {
	Path   string         `json:"path"`
	UID    string         `json:"uid"`
	Host   string         `json:"host"`
	Before map[string]any `json:"before"`
	After  map[string]any `json:"after"`
}

type migrateDocumentsResult struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	Error  string `json:"error,omitempty"`
}

func migrateDocumentsFailure(reason string, err error) migrateDocumentsResult {
	return migrateDocumentsResult{Reason: reason, Error: err.Error()}
}

func (a *app) migrateDocumentsCmd() *cobra.Command {
	var request string
	cmd := &cobra.Command{
		Use: "migrate-documents", Hidden: true, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var req migrateDocumentsRequest
			decoder := json.NewDecoder(strings.NewReader(request))
			decoder.DisallowUnknownFields()
			err := decoder.Decode(&req)
			if err == nil {
				var extra any
				if next := decoder.Decode(&extra); next != io.EOF {
					err = fmt.Errorf("request must contain exactly one JSON object")
				}
			}
			var result migrateDocumentsResult
			if err != nil {
				result = migrateDocumentsFailure("invalid_request", err)
			} else {
				result = applyMigrateDocuments(req, felt.WriteFiberFile)
			}
			if err := json.NewEncoder(a.env.Stdout).Encode(result); err != nil {
				return err
			}
			if !result.OK {
				return fmt.Errorf("%s: %s", result.Reason, result.Error)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&request, "request-json", "", "Migration document request JSON")
	return cmd
}

func validMigrateSnapshot(key string, value any) bool {
	if value == nil {
		return true
	}
	switch key {
	case "status", "horizon", "closed-at":
		_, ok := value.(string)
		return ok
	case "tempered":
		_, ok := value.(bool)
		return ok
	case "ask", "shuttle.runtime":
		_, ok := value.(map[string]any)
		return ok
	}
	return false
}

func validateMigrateDocuments(req migrateDocumentsRequest) error {
	if req.Mode != "check" && req.Mode != "forward" && req.Mode != "reverse" {
		return fmt.Errorf("unknown mode %q", req.Mode)
	}
	if len(req.Documents) != 2 {
		return fmt.Errorf("exactly two documents are required")
	}
	seen := map[string]bool{}
	for _, doc := range req.Documents {
		if !filepath.IsAbs(doc.Path) || filepath.Clean(doc.Path) != doc.Path || filepath.Ext(doc.Path) != ".md" {
			return fmt.Errorf("document path must be absolute canonical markdown: %q", doc.Path)
		}
		canonical, err := filepath.EvalSymlinks(doc.Path)
		if err != nil || canonical != doc.Path {
			return fmt.Errorf("document path is not canonical: %q", doc.Path)
		}
		if seen[canonical] {
			return fmt.Errorf("duplicate document path %q", canonical)
		}
		seen[canonical] = true
		info, err := os.Stat(canonical)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("document must be a regular file: %q", canonical)
		}
		if doc.UID == "" || strings.TrimSpace(doc.Host) == "" || len(doc.Before) == 0 || len(doc.Before) != len(doc.After) {
			return fmt.Errorf("UID, expected host and matching nonempty snapshots required")
		}
		for key, value := range doc.Before {
			after, exists := doc.After[key]
			if !exists || !validMigrateSnapshot(key, value) || !validMigrateSnapshot(key, after) {
				return fmt.Errorf("invalid or unmatched snapshot field %q", key)
			}
			switch key {
			case "status", "horizon", "tempered", "closed-at", "ask", "shuttle.runtime":
			default:
				return fmt.Errorf("unsupported snapshot field %q", key)
			}
		}
	}
	return nil
}

type preparedMigrateDocument struct {
	document migrateDocument
	original []byte
	patched  []byte
}

// applyMigrateDocuments holds both canonical file locks through all preflight
// reads and writes. A partial write failure is left intact for journal replay;
// document bodies are never restored from historical snapshots.
func applyMigrateDocuments(req migrateDocumentsRequest, writeFile func(string, []byte) error) migrateDocumentsResult {
	if err := validateMigrateDocuments(req); err != nil {
		return migrateDocumentsFailure("invalid_request", err)
	}
	docs := append([]migrateDocument(nil), req.Documents...)
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
	var unlocks []func() error
	defer func() {
		for i := len(unlocks) - 1; i >= 0; i-- {
			_ = unlocks[i]()
		}
	}()
	for _, doc := range docs {
		unlock, err := felt.LockFiberFile(doc.Path)
		if err != nil {
			return migrateDocumentsFailure("write_failed", err)
		}
		unlocks = append(unlocks, unlock)
	}
	var prepared []preparedMigrateDocument
	for _, doc := range docs {
		raw, err := os.ReadFile(doc.Path)
		if err != nil {
			return migrateDocumentsFailure("document_conflict", err)
		}
		patched, err := prepareMigrateDocument(doc, raw, req.Mode)
		if err != nil {
			return migrateDocumentsFailure("document_conflict", fmt.Errorf("%s: %w", doc.Path, err))
		}
		prepared = append(prepared, preparedMigrateDocument{doc, raw, patched})
	}
	if req.Mode == "check" {
		return migrateDocumentsResult{OK: true}
	}
	for _, doc := range prepared {
		fresh, err := os.ReadFile(doc.document.Path)
		if err != nil || !bytes.Equal(fresh, doc.original) {
			return migrateDocumentsFailure("document_conflict", fmt.Errorf("document changed after preflight: %s", doc.document.Path))
		}
		if bytes.Equal(doc.original, doc.patched) {
			continue
		}
		if err := writeFile(doc.document.Path, doc.patched); err != nil {
			return migrateDocumentsFailure("write_failed", err)
		}
	}
	return migrateDocumentsResult{OK: true}
}

func prepareMigrateDocument(doc migrateDocument, raw []byte, mode string) ([]byte, error) {
	// Keep the body byte-for-byte, including whitespace around its Status block.
	if !bytes.HasPrefix(raw, []byte("---\n")) {
		return nil, fmt.Errorf("missing frontmatter delimiter")
	}
	end := bytes.Index(raw[4:], []byte("\n---\n"))
	if end < 0 {
		return nil, fmt.Errorf("missing closing frontmatter delimiter")
	}
	end += 4
	var document yaml.Node
	if err := yaml.Unmarshal(raw[4:end], &document); err != nil {
		return nil, err
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("frontmatter must be a mapping")
	}
	mapping := document.Content[0]
	var validated any
	if err := migrationLexicalNode(mapping, make(map[*yaml.Node]*yaml.Node)).Decode(&validated); err != nil {
		return nil, err
	}
	uid := felt.MappingValueNode(mapping, "id")
	if uid == nil || uid.Kind != yaml.ScalarNode || uid.Tag != "!!str" || uid.Value != doc.UID {
		return nil, fmt.Errorf("intrinsic UID does not match request")
	}
	facet := felt.MappingValueNode(mapping, "shuttle")
	if facet == nil || facet.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("shuttle must remain installed as a mapping")
	}
	host := felt.MappingValueNode(facet, "host")
	if host == nil || host.Kind != yaml.ScalarNode || host.Tag != "!!str" || host.Value != doc.Host {
		return nil, fmt.Errorf("shuttle.host does not match expected host %q", doc.Host)
	}
	current := map[string]any{}
	for key := range doc.Before {
		node := migrateFieldNode(mapping, key)
		var value any
		if node != nil {
			// The daemon preserves timestamp spellings as strings, including
			// dates, explicit offsets and trailing fractional zeroes.
			lexical := migrationLexicalNode(node, make(map[*yaml.Node]*yaml.Node))
			if err := lexical.Decode(&value); err != nil {
				return nil, err
			}
		}
		// Normalize numeric and collection types to the JSON request's types.
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(encoded, &value); err != nil {
			return nil, err
		}
		current[key] = value
	}
	if !reflect.DeepEqual(current, doc.Before) && !reflect.DeepEqual(current, doc.After) {
		return nil, fmt.Errorf("touched fields match neither complete snapshot")
	}
	target := doc.After
	if mode == "reverse" {
		target = doc.Before
	}
	if mode == "check" || reflect.DeepEqual(current, target) {
		return raw, nil
	}
	keys := make([]string, 0, len(target))
	for key := range target {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := patchMigrateField(mapping, key, target[key]); err != nil {
			return nil, err
		}
	}
	header, err := yaml.Marshal(&document)
	if err != nil {
		return nil, err
	}
	result := append([]byte("---\n"), header...)
	result = append(result, raw[end+1:]...)
	return result, nil
}

// migrationLexicalNode copies only the comparison tree. The original nodes
// retain their tags, comments and values for untouched-frontmatter writes.
func migrationLexicalNode(node *yaml.Node, seen map[*yaml.Node]*yaml.Node) *yaml.Node {
	if node == nil {
		return nil
	}
	if copy := seen[node]; copy != nil {
		return copy
	}
	copy := *node
	seen[node] = &copy
	if copy.Tag == "!!timestamp" {
		copy.Tag = "!!str"
	}
	copy.Content = make([]*yaml.Node, len(node.Content))
	for i, child := range node.Content {
		copy.Content[i] = migrationLexicalNode(child, seen)
	}
	copy.Alias = migrationLexicalNode(node.Alias, seen)
	return &copy
}

func migrateFieldNode(mapping *yaml.Node, key string) *yaml.Node {
	if key == "ask" || key == "shuttle.runtime" {
		mapping = felt.MappingValueNode(mapping, "shuttle")
		key = strings.TrimPrefix(key, "shuttle.")
	}
	return felt.MappingValueNode(mapping, key)
}

func patchMigrateField(mapping *yaml.Node, key string, value any) error {
	if key == "ask" || key == "shuttle.runtime" {
		nested := felt.MappingValueNode(mapping, "shuttle")
		if nested == nil || nested.Kind != yaml.MappingNode {
			return fmt.Errorf("shuttle must be a mapping")
		}
		mapping = nested
		key = strings.TrimPrefix(key, "shuttle.")
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value != key {
			continue
		}
		if value == nil {
			mapping.Content = append(mapping.Content[:i], mapping.Content[i+2:]...)
			return nil
		}
		var node yaml.Node
		if err := node.Encode(value); err != nil {
			return err
		}
		mapping.Content[i+1] = &node
		return nil
	}
	if value == nil {
		return nil
	}
	var node yaml.Node
	if err := node.Encode(value); err != nil {
		return err
	}
	mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &node)
	return nil
}
