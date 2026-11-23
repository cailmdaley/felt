package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"reflect"
	"slices"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

type adoptSessionOptions struct {
	projectDir  string
	host        string
	agent       string
	sessionUUID string
	rexSession  string
	rexBlock    string
	tmuxSession string
	tmuxPane    string
	existing    bool
	role        string
}

// adoptCmd serves two paths:
//
//  1. User-facing session adoption (`shuttle adopt <fiber-id> [title]`):
//     atomically creates the fiber (unless --existing or already present),
//     installs it as an open draft, optionally assigns --role, claims it with
//     the local daemon's POST /api/v1/claim, and activates it (status: active)
//     only after claim succeeds. On claim failure it leaves the fiber unarmed.
//
//  2. Owner-side carried-document adoption (`shuttle adopt <fiber> --document-file
//     <path> [--carry]`), hidden and invoked by the owning daemon inside its
//     Poller before a remote resume or dispatch.
func (a *app) adoptCmd() *cobra.Command {
	var documentFile string
	var carry bool
	var opts adoptSessionOptions
	cmd := &cobra.Command{
		Use:   "adopt <fiber-id> [title]",
		Short: "Create, install, claim, and activate a fiber for this live session",
		Long: `Atomically adopts an unattached live conversation into a Shuttle fiber:

  1. Creates the fiber (status: open) if it does not exist yet (unless --existing).
  2. Installs it as an open draft with the resolved host, project directory, and agent.
  3. Optionally assigns --role to the draft.
  4. Claims it with the local daemon (POST /api/v1/claim) using the current Rex or tmux
     coordinates and native session UUID.
  5. Activates the fiber (status: active) only after the claim succeeds.

If claim fails or the daemon is unreachable, the fiber stays an unarmed open draft so
the poller cannot launch a duplicate worker.`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if documentFile != "" || cmd.Flags().Changed("document-file") {
				if len(args) != 1 {
					return fmt.Errorf("--document-file takes exactly one <fiber> argument")
				}
				return a.runCarriedAdopt(args[0], documentFile, carry)
			}
			if carry {
				return fmt.Errorf("--carry requires --document-file")
			}
			return a.runSessionAdopt(cmd, args, opts)
		},
	}
	cmd.Flags().StringVar(&opts.projectDir, "project-dir", "", "Working directory for the worker (defaults to current working directory)")
	cmd.Flags().StringVar(&opts.host, "host", "", "Owning host ID (defaults to this host)")
	cmd.Flags().StringVar(&opts.agent, "agent", "", "Agent registry ID (defaults to the registry default)")
	cmd.Flags().StringVar(&opts.sessionUUID, "session-uuid", "", "Native harness session UUID (defaults to current harness session)")
	cmd.Flags().StringVar(&opts.rexSession, "rex-session", "", "Rex session reference (defaults to REX_SESSION)")
	cmd.Flags().StringVar(&opts.rexBlock, "rex-block", "", "Rex block reference (defaults to REX_BLOCK)")
	cmd.Flags().StringVar(&opts.tmuxSession, "tmux-session", "", "Existing tmux session name (defaults to current tmux session)")
	cmd.Flags().StringVar(&opts.tmuxPane, "tmux-pane", "", "Existing tmux pane ID (defaults to TMUX_PANE)")
	cmd.Flags().BoolVar(&opts.existing, "existing", false, "Require the fiber to already exist instead of creating it")
	cmd.Flags().StringVar(&opts.role, "role", "", "Assign this role slug to the draft before claiming")

	cmd.Flags().StringVar(&documentFile, "document-file", "", "The caller's fiber file")
	cmd.Flags().BoolVar(&carry, "carry", false, "Replace this host's copy even when it holds the constitution")
	_ = cmd.Flags().MarkHidden("document-file")
	_ = cmd.Flags().MarkHidden("carry")
	return cmd
}

func (a *app) runSessionAdopt(cmd *cobra.Command, args []string, opts adoptSessionOptions) error {
	fiberArg := args[0]
	title := ""
	if len(args) == 2 {
		title = args[1]
	}

	ownHost, err := a.resolveOwnHost("")
	if err != nil {
		return err
	}
	host := ownHost
	if strings.TrimSpace(opts.host) != "" {
		host, err = a.resolveOwnHost(opts.host)
		if err != nil {
			return err
		}
		if host != ownHost {
			return fmt.Errorf("adopt must run on task host %q; this host is %q", host, ownHost)
		}
	}

	projectDirRaw := strings.TrimSpace(opts.projectDir)
	if projectDirRaw == "" {
		wd, wdErr := a.env.Getwd()
		if wdErr != nil {
			return fmt.Errorf("resolving working directory: %w", wdErr)
		}
		projectDirRaw = wd
	}
	projectDir, err := a.resolveProjectDirFlag(projectDirRaw)
	if err != nil {
		return err
	}

	reg, err := shuttle.LoadAgentRegistry(a.env)
	if err != nil {
		return fmt.Errorf("loading agent registry: %w", err)
	}
	block := &shuttle.Block{
		Kind:       "oneshot",
		Host:       host,
		Agent:      strings.TrimSpace(opts.agent),
		ProjectDir: projectDir,
	}
	if errs := shuttle.Validate(block, reg); len(errs) > 0 {
		return a.printShuttleValidationErrors(errs)
	}

	if opts.role != "" && !shuttle.ValidRole(opts.role) {
		for _, segment := range strings.Split(opts.role, "/") {
			if err := felt.CheckSlug(segment); err != nil {
				return fmt.Errorf("role must be <office> or <office>/<person>, each a slug: %w", err)
			}
		}
		return fmt.Errorf("role must be <office> or <office>/<person>, each a slug, got %q", opts.role)
	}

	tmuxSession, tmuxPane, err := a.resolveAdoptTerminal(opts)
	if err != nil {
		return err
	}

	_, envSession := a.currentSession()
	sessionUUID := strings.TrimSpace(opts.sessionUUID)
	if sessionUUID == "" {
		sessionUUID = envSession
	}
	harnessPID := 0
	if sessionUUID != "" && (envSession == "" || sessionUUID == envSession) {
		if pid := a.eventReceiverPID(); pid > 0 {
			harnessPID = pid
		}
	}

	// Step 1: Resolve or create the fiber (status: open).
	root, err := felt.ProjectRoot(a.env, a.dir)
	if err != nil {
		return fmt.Errorf("not in a felt repository (run 'felt init' first)")
	}
	st := felt.NewStorage(root)
	var f *felt.Felt
	ref, err := felt.ResolveRef(st, felt.CommandScope(a.env, root, a.dir), fiberArg)
	if err == nil {
		f, err = felt.ReadRef(ref, felt.ParseFull)
		if err != nil {
			return err
		}
		st = ref.Storage
	} else {
		var missing *felt.NoFiberMatchError
		if !errors.As(err, &missing) {
			return err
		}
		if opts.existing {
			return fmt.Errorf("fiber %s does not exist (--existing set)", fiberArg)
		}
		f, err = a.createAdoptFiber(st, fiberArg, title)
		if err != nil {
			return err
		}
	}

	// Step 2 & 3: Install as an open draft and optionally assign role.
	// Release the fiber lock before calling the daemon's /api/v1/claim endpoint.
	claimAgent := block.Agent
	if err := func() error {
		locked, unlock, err := lockAndReloadFiber(st, f)
		if err != nil {
			return err
		}
		defer unlock()
		f = locked

		existingBlock, hasBlock, err := shuttle.BlockOf(f)
		if err != nil {
			return err
		}
		if !hasBlock {
			f.Status, f.ClosedAt = felt.StatusOpen, nil
			if err := shuttle.SetConfig(f, block); err != nil {
				return fmt.Errorf("attaching shuttle block: %w", err)
			}
		} else {
			if existingBlock.Host != ownHost {
				return fmt.Errorf("fiber %s is owned by host %q; this host is %q", f.ID, existingBlock.Host, ownHost)
			}
			if f.Status == felt.StatusActive {
				return fmt.Errorf("fiber %s is already active; cannot adopt an active constitution", f.ID)
			}
			if f.Status == felt.StatusClosed {
				return fmt.Errorf("fiber %s is closed; reopen it before adopting", f.ID)
			}
			if existingBlock.ProjectDir == "" && projectDir != "" {
				if err := shuttle.SetField(f, "project_dir", projectDir); err != nil {
					return err
				}
			}
			if block.Agent != "" && existingBlock.Agent != block.Agent {
				if err := shuttle.SetField(f, "agent", block.Agent); err != nil {
					return err
				}
			} else if claimAgent == "" {
				claimAgent = existingBlock.Agent
			}
		}

		if opts.role != "" {
			role := felt.QualifyRole(opts.role, st.Path(f.ID))
			office := shuttle.OfficeOf(role)
			charters, _, err := st.RoleCharters()
			if err != nil {
				return err
			}
			if charters[office] == nil {
				return felt.NoCharterError(office)
			}
			if err := shuttle.SetRole(f, role); err != nil {
				return err
			}
		}

		if err := a.writeFiber(st, f); err != nil {
			return fmt.Errorf("writing draft fiber: %w", err)
		}
		return nil
	}(); err != nil {
		return err
	}

	// Step 4: Claim with the local daemon (fail closed: leave unarmed on error).
	canonicalID, err := a.canonicalFiberID(f.Path)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"fiber_id":     canonicalID,
		"tmux_session": tmuxSession,
		"tmux_pane":    tmuxPane,
	}
	if claimAgent != "" {
		payload["agent"] = claimAgent
	}
	if sessionUUID != "" {
		payload["session_uuid"] = sessionUUID
	}
	if harnessPID > 0 {
		payload["harness_pid"] = harnessPID
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint, err := a.daemonEndpoint("/api/v1/claim")
	if err != nil {
		return err
	}
	response, err := a.postDaemonContext(cmd.Context(), endpoint, body, daemonPostTimeout)
	if err != nil {
		return fmt.Errorf("claim not confirmed (fiber %s left as open draft): %w", f.ID, err)
	}
	var result struct {
		Claimed bool `json:"claimed"`
	}
	if err := json.Unmarshal(response, &result); err != nil {
		return fmt.Errorf("claim response unreadable (fiber %s left as open draft): %w", f.ID, err)
	}
	if !result.Claimed {
		return fmt.Errorf("claim rejected (fiber %s left as open draft): %s", f.ID, response)
	}

	// Step 5: Activate (status: active) only after claim succeeded.
	locked, unlock, err := lockAndReloadFiber(st, f)
	if err != nil {
		return fmt.Errorf("reloading claimed fiber %s for activation: %w", f.ID, err)
	}
	locked.Status, locked.ClosedAt = felt.StatusActive, nil
	if err := locked.SetExtraField("horizon", nil); err != nil {
		unlock()
		return fmt.Errorf("clearing horizon on claimed fiber %s: %w", f.ID, err)
	}
	writeErr := a.writeFiber(st, locked)
	unlock()
	if writeErr != nil {
		return fmt.Errorf("activating claimed fiber %s: %w", f.ID, writeErr)
	}

	if a.json {
		var claimResp map[string]any
		if err := json.Unmarshal(response, &claimResp); err != nil {
			claimResp = map[string]any{"claimed": true}
		}
		claimResp["fiber"] = locked.ID
		claimResp["status"] = locked.Status
		return a.outputJSON(claimResp)
	}
	fmt.Fprintf(a.env.Stdout, "Adopted %s (active, claimed for current session).\n", locked.ID)
	return nil
}

func (a *app) resolveAdoptTerminal(opts adoptSessionOptions) (string, string, error) {
	if sid := strings.TrimSpace(opts.rexSession); sid != "" {
		bid := strings.TrimSpace(opts.rexBlock)
		if bid == "" && sid == strings.TrimSpace(a.env.Getenv("REX_SESSION")) {
			bid = strings.TrimSpace(a.env.Getenv("REX_BLOCK"))
		}
		return sid, bid, nil
	}
	if ts := strings.TrimSpace(opts.tmuxSession); ts != "" {
		return ts, strings.TrimSpace(opts.tmuxPane), nil
	}
	ref, refErr := a.currentTerminal()
	// A human-born Rex terminal has native IDs but no worker binding.
	if refErr != nil && !(ref.Backend == "rex" && validRexRef(ref.NativeSession, ref.NativePane)) {
		return "", "", fmt.Errorf("cannot identify existing terminal conversation: %w; pass --rex-session/--rex-block or --tmux-session", refErr)
	}
	pane := ref.NativePane
	if opts.rexBlock != "" {
		pane = strings.TrimSpace(opts.rexBlock)
	} else if opts.tmuxPane != "" {
		pane = strings.TrimSpace(opts.tmuxPane)
	}
	return ref.NativeSession, pane, nil
}

func (a *app) createAdoptFiber(st *felt.Storage, slugArg, title string) (*felt.Felt, error) {
	extractedTags, cleanSlug := felt.ExtractTags(slugArg)
	name := strings.TrimSpace(title)
	if name == "" {
		base := path.Base(strings.TrimRight(cleanSlug, "/"))
		name = strings.ReplaceAll(base, "-", " ")
	}
	f, err := felt.New(cleanSlug, name)
	if err != nil {
		return nil, err
	}
	for _, segment := range strings.Split(f.ID, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return nil, fmt.Errorf("slug %q must be a path inside the store", f.ID)
		}
		if strings.HasPrefix(segment, ".") {
			return nil, fmt.Errorf("slug %q starts with \".\", which no segment may%s", segment, felt.ConformingHint(segment))
		}
	}
	st.MemoizeWalk()
	felts, err := st.ListMetadata()
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(felts))
	for i, existing := range felts {
		ids[i] = existing.ID
	}
	resolved, _, err := felt.ResolveAddPath(f.ID, ids)
	if err != nil {
		return nil, err
	}
	f.ID = resolved
	if err := st.CheckNewSlugs(f.ID); err != nil {
		return nil, err
	}
	if err := st.CheckAvailableID(f.ID); err != nil {
		return nil, err
	}
	f.Status = felt.StatusOpen
	if len(extractedTags) > 0 {
		f.Tags = extractedTags
	}
	if err := st.Write(f); err != nil {
		return nil, fmt.Errorf("creating fiber %s: %w", f.ID, err)
	}
	created, err := st.Read(f.ID)
	if err != nil {
		return nil, fmt.Errorf("reading created fiber %s: %w", f.ID, err)
	}
	return created, nil
}

// runCarriedAdopt is the owner's half of a remote resume or dispatch that carries the
// caller's document. The owning daemon runs it inside its Poller before the
// verb, so the owner judges the constitution the caller sees rather than its
// own copy, which may predate the caller's edit until Git catches up.
//
// The owner holds a constitution when its copy carries a shuttle: block naming
// this host. A held copy stands, since the caller's mirror is often older than
// the owner's worker-written state; --carry replaces it anyway, keeping its
// runtime and lifecycle state. A copy the owner does not hold takes the caller's document.
func (a *app) runCarriedAdopt(fiberArg, documentFile string, carry bool) error {
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
		return fmt.Errorf("the caller's document for %s has no shuttle: block", fiberArg)
	}
	own, err := a.resolveOwnHost("")
	if err != nil {
		return err
	}
	if carriedBlock.Host != own {
		return fmt.Errorf("the caller's document for %s names host %q; this host is %q", fiberArg, carriedBlock.Host, own)
	}

	f, st, _, err := a.shuttleResolveFiberRef(fiberArg, true)
	if err != nil {
		return err
	}
	if st == nil {
		return fmt.Errorf("fiber %s is not in this host's stores", fiberArg)
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
			fmt.Fprintf(a.env.Stdout, "note: %s's copy of %s differs from the caller's (%s) and stands; --carry sends the caller's version\n", own, local.ID, strings.Join(differs, ", "))
		}
		return nil
	}

	carried.ID, carried.Path = local.ID, local.Path
	if carried.UID == "" {
		carried.UID = local.UID
	}
	if held {
		// The owner's lifecycle is its own: --carry replaces what the
		// constitution says, not where it stands.
		carried.Status, carried.ClosedAt = local.Status, local.ClosedAt
		for _, key := range []string{"horizon", "tempered"} {
			if node := local.ExtraFields[key]; node != nil {
				carried.ExtraFields[key] = node
			} else {
				delete(carried.ExtraFields, key)
			}
		}
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
