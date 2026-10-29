defmodule Shuttle.Migration do
  @moduledoc "Validation and reversible backend changes for a Poller-owned session migration."
  alias Shuttle.{AppWorkers, Dispatcher, FeltStores, LifecycleStore, Poller, WorkerProcess}
  alias Shuttle.Terminal.Tmux

  def prepare(state, from_id, to_id, opts) do
    with {:ok, from} <- resolve(state, from_id),
         {:ok, to} <- resolve(state, to_id),
         :ok <- installed(from),
         :ok <- installed(to),
         :ok <- owner(state, from),
         :ok <- owner(state, to) do
      source = worker(state, from)
      dest = worker(state, to)
      requested = present(opts[:session_id]) || present(opts[:session_uuid])

      cond do
        opts[:rest] == true and opts[:disabled] == true ->
          {:error, :invalid_options}

        retry_identity(state, dest, to, requested, opts[:tmux_pane]) != nil ->
          {:retry, reply(from, to, retry_identity(state, dest, to, requested, opts[:tmux_pane]))}

        from["uid"] == to["uid"] ->
          {:error, :same_fiber}

        is_nil(source) ->
          {:error, :not_running}

        dest != nil or Poller.live_session_for_fiber(state, to["id"], to["uid"]) != nil ->
          {:error, :already_running}

        true ->
          prepare_worker(state, from, to, source, requested, opts)
      end
    end
  end

  defp resolve(state, id) do
    with {:ok, target} <- FeltStores.resolve_fiber(id, state.felt_stores),
         {:ok, fiber} <- Poller.fetch_fiber_full(target.fiber_id, state) do
      {:ok,
       Map.merge(fiber, %{
         "id" => target.fiber_id,
         "path" => target.path,
         "uid" => target.uid,
         "store" => target.store
       })}
    else
      _ -> {:error, :not_found}
    end
  end

  defp present(value) when is_binary(value),
    do: if(String.trim(value) == "", do: nil, else: value)

  defp present(_), do: nil

  defp installed(%{"shuttle" => block}) when is_map(block), do: :ok
  defp installed(_), do: {:error, :not_installed}

  defp owner(state, fiber) do
    if Poller.host_owned?(fiber["shuttle"], state.own_host_id),
      do: :ok,
      else: {:error, :other_host}
  end

  defp worker(state, fiber), do: state.running[Poller.running_key(state, fiber["uid"])]

  defp migrated_to?(uuid, to) do
    case Shuttle.SessionLedger.latest_for_session(uuid) do
      %{"kind" => "migrate", "uid" => uid} -> uid == to["uid"]
      _ -> false
    end
  end

  defp retry_identity(_state, nil, _to, _requested, _pane), do: nil

  defp retry_identity(state, dest, to, requested, pane) do
    uuid = AppWorkers.id(dest.session) || dest[:session_uuid]

    proof =
      (requested && matches?(dest, requested)) ||
        (present(pane) && verify_pane(state.runner, dest.session, pane) == :ok &&
           not AppWorkers.app?(dest.session))

    if uuid && proof && migrated_to?(uuid, to), do: uuid
  end

  defp matches?(nil, _), do: false

  defp matches?(worker, uuid),
    do: (AppWorkers.id(worker.session) || worker[:session_uuid]) == uuid

  defp prepare_worker(state, from, to, worker, requested, opts) do
    # An explicitly nil captured identity must not fall back to a predecessor's mirror.
    uuid =
      AppWorkers.id(worker.session) ||
        Map.get(worker, :session_uuid, get_in(from, ["shuttle", "runtime", "session_uuid"]))

    canonical = Dispatcher.session_name(to["id"], to["uid"])

    with true <- is_binary(uuid) and uuid not in ["", "unknown"],
         :ok <- verify_uuid(uuid, requested),
         :ok <- verify_pane(state.runner, worker.session, opts[:tmux_pane]),
         {:ok, backend} <- backend(state, worker, from, to, canonical, uuid),
         {:ok, documents} <-
           LifecycleStore.prepare_migration(from["path"], to["path"], uuid, opts) do
      {:ok,
       %{
         from: from,
         to: to,
         worker: worker,
         uuid: uuid,
         backend: backend,
         documents: documents,
         session: if(AppWorkers.app?(worker.session), do: worker.session, else: canonical)
       }}
    else
      false -> {:error, :surface_unsupported}
      {:error, _} = error -> error
    end
  end

  defp verify_uuid(id, id), do: :ok
  defp verify_uuid(_, nil), do: :ok
  defp verify_uuid(_, _), do: {:error, :identity_mismatch}
  defp verify_pane(_, "codex-app:" <> _, _), do: :ok
  defp verify_pane(_, _, nil), do: :ok
  defp verify_pane(_, _, ""), do: :ok

  defp verify_pane(runner, session, pane) do
    if AppWorkers.app?(session) do
      {:error, :surface_unsupported}
    else
      if Tmux.owns_pane?(runner, session, pane),
        do: :ok,
        else: {:error, :identity_mismatch}
    end
  end

  defp backend(state, worker, _from, to, canonical, uuid) do
    if AppWorkers.app?(worker.session) do
      with {:ok, record} <- AppWorkers.get(AppWorkers.id(worker.session)),
           :ok <-
             AppWorkers.check_owner(
               record,
               record["session_uuid"],
               state.own_host_id,
               Shuttle.CodexApp.Transport.default_socket()
             ) do
        {:ok,
         {:app, record,
          Map.merge(record, %{
            "fiber_id" => to["id"],
            "uid" => to["uid"],
            "felt_store" => to["store"],
            "fiber_path" => to["path"]
          })}}
      end
    else
      if is_nil(canonical) do
        {:error, :uid_missing}
      else
        with {:ok, procs} <- WorkerProcess.scan(state.runner),
             {:ok, terminal_identity} <- Tmux.identity(state.runner, worker.session) do
          aliases = WorkerProcess.migration_aliases(procs, worker.session, canonical)
          identity = Map.put(terminal_identity, "session_uuid", uuid)
          {:ok, {:tmux, worker.session, canonical, aliases, identity}}
        else
          _ -> {:error, :surface_unsupported}
        end
      end
    end
  end

  @doc "Idempotently reconcile a journal's backend assignment in its durable direction."
  def reconcile_backend(_, %{"resolution" => "unresolvable", "reason" => reason}),
    do: {:error, {:journal_unresolvable, reason}}

  def reconcile_backend(state, %{"backend" => %{"type" => "app"} = backend} = entry) do
    old = backend["before"]
    target = backend[if(entry["direction"] == "forward", do: "after", else: "before")]
    fiber = entry[if(entry["direction"] == "forward", do: "to", else: "from")]
    target = Map.put(target, "fiber_path", fiber["path"])

    AppWorkers.update(entry["uuid"], fn current ->
      with :ok <-
             AppWorkers.check_owner(
               current,
               entry["uuid"],
               state.own_host_id,
               Shuttle.CodexApp.Transport.default_socket()
             ),
           true <- current["uid"] in [old["uid"], backend["after"]["uid"]] do
        # Assignment fields change; contemporaneous backend state is retained.
        {:ok, Map.merge(current, Map.take(target, ~w(fiber_id uid felt_store fiber_path)))}
      else
        false -> {:error, :backend_assignment_conflict}
        error -> error
      end
    end)
  end

  def reconcile_backend(state, %{"backend" => %{"type" => "tmux"} = backend} = entry) do
    forward? = entry["direction"] == "forward"
    from = backend[if(forward?, do: "before", else: "after")]
    to = backend[if(forward?, do: "after", else: "before")]

    aliases =
      Enum.map(backend["aliases"], fn alias ->
        previous = if alias["before"], do: {:ok, alias["before"]}, else: {:error, :enoent}
        {alias["path"], previous, alias["after"]}
      end)

    # Query tmux directly here: script aliases themselves are being reconciled.
    with {:ok, source?} <- tmux_exists(state.runner, from),
         {:ok, dest?} <- tmux_exists(state.runner, to),
         :ok <- reconcile_name(state.runner, from, to, source?, dest?, backend["identity"]) do
      if forward?,
        do: WorkerProcess.write_migration_aliases(aliases),
        else: WorkerProcess.restore_migration_aliases(aliases)
    else
      {:error, :backend_identity_mismatch} = error ->
        case Shuttle.MigrationJournal.unresolvable(entry, :backend_identity_mismatch) do
          :ok -> error
          failure -> {:error, {:journal_write_failed, failure}}
        end

      error ->
        error
    end
  end

  defp verify_tmux_identity(runner, name, %{"panes" => expected}) do
    with {:ok, %{"panes" => observed}} <- Tmux.identity(runner, name) do
      if Enum.all?(expected, &(&1 in observed)),
        do: :ok,
        else: {:error, :backend_identity_mismatch}
    end
  end

  defp verify_tmux_identity(_, _, _), do: {:error, :backend_identity_mismatch}

  defp tmux_exists(runner, name) do
    case Tmux.probe(runner, name) do
      :present -> {:ok, true}
      :absent -> {:ok, false}
      :unknown -> {:error, :backend_unobservable}
    end
  end

  defp reconcile_name(_, _, _, true, true, _), do: {:error, :backend_assignment_conflict}

  defp reconcile_name(runner, from, to, true, false, identity) do
    with :ok <- verify_tmux_identity(runner, from, identity), do: rename(runner, to, identity)
  end

  defp reconcile_name(runner, _, to, false, true, identity),
    do: verify_tmux_identity(runner, to, identity)

  defp reconcile_name(runner, from, to, false, false, _) do
    # A completed conversation can be absent, but a failed scan cannot prove it.
    with {:ok, procs} <- WorkerProcess.scan(runner),
         nil <- WorkerProcess.session_process(procs, from),
         nil <- WorkerProcess.session_process(procs, to) do
      :ok
    else
      _ -> {:error, :backend_unobservable}
    end
  end

  defp rename(runner, to, %{"panes" => [pane | _]}) do
    # Target the captured tmux session ID, never a name that can be replaced
    # between verification and this command.
    session_id = pane |> String.split("\t") |> hd()

    Tmux.rename_session_id(runner, session_id, to)
  end

  def reply(from, to, uuid), do: %{ok: true, from: from["id"], to: to["id"], session_uuid: uuid}
end
