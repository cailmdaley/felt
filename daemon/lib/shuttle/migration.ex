defmodule Shuttle.Migration do
  @moduledoc "Validation and reversible backend changes for a Poller-owned session migration."
  alias Shuttle.{AppWorkers, Dispatcher, FeltStores, LifecycleStore, Poller, WorkerProcess}

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
         {:ok, backend} <- backend(state, worker, from, to, canonical),
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
      case runner.cmd("tmux", ["display-message", "-p", "-t", pane, "\#{session_name}"],
             stderr_to_stdout: true
           ) do
        {output, 0} ->
          if String.trim(output) == session, do: :ok, else: {:error, :identity_mismatch}

        _ ->
          {:error, :identity_mismatch}
      end
    end
  end

  defp backend(state, worker, _from, to, canonical) do
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
        with {:ok, procs} <- WorkerProcess.scan(state.runner) do
          aliases = WorkerProcess.migration_aliases(procs, worker.session, canonical)
          {:ok, {:tmux, worker.session, canonical, aliases}}
        else
          _ -> {:error, :surface_unsupported}
        end
      end
    end
  end

  def move_backend(_state, %{backend: {:app, old, new}}) do
    case AppWorkers.put(new) do
      :ok -> {:ok, fn -> AppWorkers.put(old) end}
      error -> error
    end
  end

  def move_backend(state, %{backend: {:tmux, old, new, aliases}}) do
    with :ok <- WorkerProcess.write_migration_aliases(aliases),
         :ok <- rename(state.runner, old, new) do
      {:ok,
       fn ->
         with :ok <- rename(state.runner, new, old),
              do: WorkerProcess.restore_migration_aliases(aliases)
       end}
    else
      error ->
        WorkerProcess.restore_migration_aliases(aliases)
        error
    end
  end

  defp rename(runner, from, to) do
    case runner.cmd("tmux", ["rename-session", "-t", "=" <> from, to], stderr_to_stdout: true) do
      {_, 0} -> :ok
      _ -> {:error, :rename_failed}
    end
  end

  def reply(from, to, uuid), do: %{ok: true, from: from["id"], to: to["id"], session_uuid: uuid}
end
