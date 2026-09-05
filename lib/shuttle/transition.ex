defmodule Shuttle.Transition do
  @moduledoc """
  The unified write-plane for kanban transitions — one call that hides the
  resolve / invoke / owner-routing dance the kanban used to orchestrate itself.

  A kanban drag is `{fiber_id, target, origin}`: move this fiber to that column,
  and the fiber is owned by that host. `transition/3` turns it into a lifecycle
  mutation:

    1. **Route by origin.** The composite board (`GET /api/v1/fibers/composite`)
       stamps every fiber with the host that OWNS it. An `origin` that is this
       daemon (or absent / `"local"`) routes to the local branch; an `origin`
       matching a configured remote forwards over the tunnel; an unknown origin
       falls through to local, where the daemon's own ownership + availability
       gates are the final arbiter (mirroring Portolan's prior
       `resolveShuttleDaemonUrl` fallback).

    2. **Local branch** = resolve + invoke, in one process, on ONE read.
       `ActionQueries` reads the live felt document and tmux liveness outside
       the Poller mailbox to map `target` → a canonical action id. Nothing
       re-checks availability afterward: the resolved action is in the
       availability set by construction (the `resolve ⊆ availability` invariant
       — see `gotcha-shuttle-resolve-invoke-daemon-split`), so a second read
       could only disagree with the first by racing it. Then the mutation:
       pause/reopen/close shell the offline frontmatter writer, accept-run /
       dispatch-ad-hoc go through the in-process lifecycle.

    3. **Forward branch** = `POST <remote>/api/v1/transition` with `origin`
       omitted, so the owning daemon runs its OWN local branch against its
       authoritative state. The owner-routing (route + forward) is
       `Shuttle.OriginRouter`, the one forwarder every write endpoint shares;
       this service only adds the resolve+invoke local branch and re-stamps the
       relayed response's `origin`. Terminating in one hop: a fiber has exactly
       one owner, and the owner never re-forwards.

  This service's `/transition` endpoint uses `http_error/1`, so the write-plane's
  status mapping has a single implementation.
  """

  alias Shuttle.{
    ActionQueries,
    FeltStores,
    LifecycleService,
    OriginRouter,
    Poller,
    RemoteFiberRegistry,
    Remote
  }

  @typedoc """
  The local outcome of a transition: `{:ok, action_id}` on success, a structured
  error otherwise. The forward branch instead returns `{:forwarded, status,
  body}`, the remote daemon's verbatim response for the controller to relay.
  """
  @type result ::
          {:ok, String.t()}
          | {:forwarded, non_neg_integer(), map()}
          | {:error, term()}

  @doc """
  Resolve `target` to an action and invoke it on the fiber's owning daemon.

  Returns `{:ok, action_id}` for a local transition, `{:forwarded, status,
  body}` for one relayed to a remote owner, or `{:error, reason}` (map reasons
  to HTTP via `http_error/1`).
  """
  @spec transition(String.t(), String.t(), String.t() | nil, keyword()) :: result()
  def transition(fiber_id, target, origin, opts \\ []) do
    case OriginRouter.route(origin, opts) do
      :local -> transition_local(fiber_id, target)
      {:remote, %Remote{} = remote} -> forward(remote, fiber_id, target, origin, opts)
    end
  end

  # ── Local branch: resolve + invoke ──

  # The local branch, end to end: resolve the drag target to an action, resolve
  # the felt store that owns the fiber (so the `felt shuttle` verbs that still
  # shell out get the right `--felt-store` — the same resolution /api/v1/fibers
  # uses, so it never disagrees with the id we advertised), mutate, then re-read
  # the document into the daemon's cache NOW so the kanban's post-transition
  # refetch reflects the move instead of snapping the card back to its old
  # column until the next poll.
  #
  # There is deliberately no availability gate between resolve and invoke.
  # `Actions.action_ids/2` is a projection of `action_for_target/3` over the same
  # targets `resolve_transition/3` normalizes into, so the resolved action is in
  # the availability set by construction; a re-check would cost a second felt
  # read and tmux probe per drag and could only ever 409 on a race between its
  # own two reads. See `gotcha-shuttle-resolve-invoke-daemon-split`. Double
  # dispatch is refused by `Poller.dispatch_fiber`'s own `:already_running`,
  # which is the real guard.
  defp transition_local(fiber_id, target) do
    with {:ok, %{id: action_id}} <- resolve(fiber_id, target),
         {:ok, felt_store} <- FeltStores.host_for_fiber(fiber_id),
         :ok <- invoke_action(fiber_id, action_id, felt_store) do
      Poller.refresh_document(fiber_id)
      {:ok, action_id}
    end
  end

  defp resolve(fiber_id, target) do
    case ActionQueries.resolve_action(fiber_id, target) do
      {:ok, action} ->
        {:ok, action}

      {:error, :unknown_target} ->
        {:error, :unknown_target}

      # Any other resolve failure is an unresolvable fiber (unknown id,
      # unreadable frontmatter, foreign store) — the read paths 404 it, so match
      # them rather than falling to the catch-all 500. A `host_for_fiber`
      # `:timeout` is deliberately NOT folded in here: a wedged store means the
      # world is unknown, not that the fiber is absent.
      {:error, _reason} ->
        {:error, :not_found}
    end
  end

  # pause / reopen / close shell the Go frontmatter writer with
  # SHUTTLE_LIFECYCLE_OFFLINE so it writes frontmatter only (status, tempered,
  # closed-at) WITHOUT calling back into this daemon's /api/v1/lifecycle. The
  # document carries the entire lifecycle (status + tempered) — there is no
  # runtime row to reset, so close/reopen are a single felt write and
  # re-arm/awaiting are recomputed from the document on the next poll.
  defp invoke_action(fiber_id, "pause", felt_store),
    do: run_offline("pause", fiber_id, [], felt_store)

  defp invoke_action(fiber_id, "reopen", felt_store),
    do: run_offline("reopen", fiber_id, [], felt_store)

  # reopen-draft: status:open + verdict cleared — a paused draft, NOT armed.
  # The kanban's "drag a closed card to Drafts" verb, and the park-as-draft
  # half it composes before a planning-surface drop on a closed card (the
  # slides snap-back fix; see Portolan kanban-ux-rework/placement-pipeline-invariants).
  defp invoke_action(fiber_id, "reopen-draft", felt_store),
    do: run_offline("reopen", fiber_id, ["--as-draft"], felt_store)

  # accept-run goes through the in-process lifecycle path so the felt-document
  # re-arm happens atomically against poll cycles, not the shelled-out
  # `felt shuttle accept` (which can race a concurrent poll's document read).
  defp invoke_action(fiber_id, "accept-run", _felt_store) do
    case LifecycleService.accept(fiber_id) do
      {:ok, _output} -> :ok
      {:error, reason} -> {:error, {:command_error, 1, reason}}
    end
  end

  defp invoke_action(fiber_id, "close-awaiting-review", felt_store),
    do: run_offline("close", fiber_id, [], felt_store)

  defp invoke_action(fiber_id, "close-tempered", felt_store),
    do: run_offline("close", fiber_id, ["--tempered=true"], felt_store)

  defp invoke_action(fiber_id, "close-composted", felt_store),
    do: run_offline("close", fiber_id, ["--tempered=false"], felt_store)

  defp invoke_action(fiber_id, "dispatch-ad-hoc", _felt_store) do
    case Poller.dispatch_fiber(Poller, fiber_id, force: true, ad_hoc: true) do
      {:ok, _session} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  # Routed through the one audited write helper (`Shuttle.Felt.Shuttle`),
  # which itself sits on `Shuttle.Felt.run` — bounded by `Shuttle.Runner`'s
  # timeout+SIGKILL reap instead of a bare `System.cmd/3` that would hang this
  # Phoenix request (and leak the process) forever against a wedged felt on a
  # loaded node. `felt_store` may be `nil` (no store resolved) — the helper
  # omits `--felt-store` in that case, same as before.
  defp run_offline(verb, fiber_id, args, felt_store) do
    case Shuttle.Felt.Shuttle.run(verb, fiber_id, args,
           felt_store: felt_store,
           env: lifecycle_offline_env()
         ) do
      {:ok, _output} -> :ok
      {:command_error, status, output} -> {:error, {:command_error, status, output}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp lifecycle_offline_env, do: [{"SHUTTLE_LIFECYCLE_OFFLINE", "1"}]

  # ── Forward branch: relay to the owning remote daemon ──

  # Delegate route+POST to OriginRouter (the shared forwarder), then re-stamp
  # `origin` on the decoded body: the remote computed its response treating the
  # fiber as local, so its `origin` would read "local"/its own id. The kanban
  # always sees the origin it routed to.
  defp forward(%Remote{} = remote, fiber_id, target, origin, opts) do
    case OriginRouter.forward(
           remote,
           "/api/v1/transition",
           %{fiber_id: fiber_id, target: target},
           opts
         ) do
      {:forwarded, status, body} ->
        RemoteFiberRegistry.refresh_after_forward(remote.name, status)
        {:forwarded, status, Map.put(decode_body(body), "origin", origin)}

      {:error, _reason} = error ->
        error
    end
  end

  defp decode_body(body) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, %{} = map} -> map
      _ -> %{"error" => body}
    end
  end

  # ── HTTP status mapping (shared by both controllers) ──

  @doc """
  Map a transition/invoke error reason to an `{http_status, error_string}` pair.
  The single place the write-plane's error vocabulary becomes HTTP.
  """
  @spec http_error(term()) :: {non_neg_integer(), String.t()}
  def http_error(:unknown_target), do: {400, "unknown_target"}
  def http_error(:already_running), do: {409, "already_running"}
  def http_error(:not_found), do: {404, "not_found"}

  def http_error({:command_error, status, output}),
    do: {422, "shuttle exited #{status}: #{String.trim(output)}"}

  def http_error({:forward_failed, remote, reason}),
    do: {502, "forward to #{remote} failed: #{render_error(reason)}"}

  def http_error(reason), do: {500, render_error(reason)}

  defp render_error(reason) when is_binary(reason), do: reason
  defp render_error(reason) when is_atom(reason), do: to_string(reason)
  defp render_error(reason), do: inspect(reason)
end
