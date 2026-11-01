defmodule Shuttle.MigrationJournal do
  @moduledoc """
  Durable assignment intent, replayed before any worker adoption or launch.

  Journals live under `migrations/<sha256(host-id)>/`. Only the frozen daemon
  host owns recovery; foreign namespaces and foreign flat journals are logged
  and ignored. Flat journals belonging to this host are relocated before replay.

  Changing `~/.shuttle/host` does not transfer pending intent. Finish recovery
  under the old identity before changing it, or restore the old identity and
  restart to recover. Never rename a namespace or edit its host to adopt work:
  backend ownership and installed fiber anchors must still agree with the owner.

  Tmux intent captures pane PIDs and tmux IDs alongside the native UUID. A
  replacement resource permanently marks intent unresolvable for operator
  reconciliation; missing identity evidence holds rather than trusting a name.
  """

  require Logger

  def root, do: Path.join(Shuttle.data_dir(), "migrations")

  def root(host),
    do: Path.join(root(), Base.encode16(:crypto.hash(:sha256, host), case: :lower))

  def create(plan, host) do
    id = Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)

    entry = %{
      "version" => 1,
      "id" => id,
      "host" => host,
      "direction" => "forward",
      "from" => plan.from,
      "to" => plan.to,
      "uuid" => plan.uuid,
      "documents" => plan.documents,
      "worker" =>
        Map.take(plan.worker, [
          :fiber_id,
          :uid,
          :felt_store,
          :session,
          :session_uuid,
          :context_harness,
          :agent_id,
          :role
        ])
        |> Map.new(fn {k, v} -> {Atom.to_string(k), v} end),
      "session" => plan.session,
      "backend" => encode_backend(plan.backend)
    }

    with :ok <- put(entry), do: {:ok, entry}
  end

  def reverse(entry) do
    # Backend verification can persist a terminal mismatch after the caller
    # captured this entry. Compensation must not overwrite that evidence.
    with {:ok, bytes} <- File.read(path(entry)),
         {:ok, current} <- Jason.decode(bytes),
         :ok <- validate(current),
         true <- current["id"] == entry["id"] and current["host"] == entry["host"],
         :ok <- resolvable(current) do
      reversed = Map.put(current, "direction", "reverse")
      with :ok <- put(reversed), do: {:ok, reversed}
    else
      false -> {:error, :journal_identity_conflict}
      error -> error
    end
  end

  def pending(host \\ Shuttle.Poller.own_host_id()) do
    with :ok <- File.mkdir_p(root(host)),
         {:ok, names} <- File.ls(root()),
         {:ok, owned} <- File.ls(root(host)) do
      Enum.each(names, fn name ->
        path = Path.join(root(), name)

        if File.dir?(path) and path != root(host),
          do: Logger.info("Ignoring foreign migration journal namespace #{path}")
      end)

      paths =
        Enum.map(Enum.filter(names, &String.ends_with?(&1, ".json")), &Path.join(root(), &1)) ++
          Enum.map(
            Enum.filter(owned, &String.ends_with?(&1, ".json")),
            &Path.join(root(host), &1)
          )

      paths
      |> Enum.sort()
      |> Enum.reduce_while({:ok, []}, fn path, {:ok, entries} ->
        with {:ok, bytes} <- File.read(path),
             {:ok, %{"host" => owner} = entry} <- Jason.decode(bytes),
             true <- is_binary(owner) and owner != "" do
          if owner == host do
            with :ok <- validate(entry),
                 :ok <- resolvable(entry),
                 true <- Path.basename(path) == entry["id"] <> ".json",
                 :ok <- relocate(entry, path) do
              {:cont, {:ok, entries ++ [entry]}}
            else
              error -> {:halt, {:error, {:journal_unreadable, path, error}}}
            end
          else
            Logger.info("Ignoring foreign migration journal #{path} owned by #{inspect(owner)}")
            {:cont, {:ok, entries}}
          end
        else
          error -> {:halt, {:error, {:journal_unreadable, path, error}}}
        end
      end)
    end
  end

  defp relocate(entry, previous) do
    if previous == path(entry) do
      :ok
    else
      case File.read(path(entry)) do
        {:error, :enoent} ->
          with :ok <- put(entry), do: File.rm(previous)

        {:ok, bytes} ->
          if Jason.decode(bytes) == {:ok, entry},
            do: File.rm(previous),
            else: {:error, :journal_namespace_conflict}

        error ->
          error
      end
    end
  end

  @doc "Validate every value consumed by recovery before any backend or document operation."
  def validate(
        %{
          "version" => 1,
          "id" => id,
          "host" => host,
          "direction" => direction,
          "from" => from,
          "to" => to,
          "uuid" => uuid,
          "session" => session,
          "worker" => worker,
          "documents" => documents,
          "backend" => backend
        } = entry
      ) do
    checks = [
      {"id", token?(id)},
      {"host", text?(host)},
      {"direction", direction in ["forward", "reverse"]},
      {"uuid", token?(uuid)},
      {"session", text?(session)},
      {"from", fiber?(from)},
      {"to", fiber?(to)},
      {"worker", worker?(worker)},
      {"documents", documents?(documents, from, to, host)},
      {"backend", backend?(backend, uuid, from, to, host)},
      {"resolution", resolution?(entry)}
    ]

    case Enum.find(checks, fn {_, valid?} -> not valid? end) do
      nil -> :ok
      {field, _} -> {:error, {:invalid_journal_schema, field}}
    end
  end

  def validate(_), do: {:error, {:invalid_journal_schema, "required fields or version"}}

  defp text?(value), do: is_binary(value) and String.trim(value) != ""
  defp token?(value), do: text?(value) and Regex.match?(~r/^[A-Za-z0-9_-]+$/, value)
  defp optional_text?(value), do: is_nil(value) or is_binary(value)
  defp absolute?(value), do: text?(value) and Path.type(value) == :absolute

  defp fiber?(%{"id" => id, "uid" => uid, "path" => path, "store" => store}),
    do: text?(id) and token?(uid) and absolute?(path) and absolute?(store)

  defp fiber?(_), do: false

  defp worker?(%{"session" => session} = worker) do
    text?(session) and
      Enum.all?(
        ~w(fiber_id uid felt_store session_uuid context_harness agent_id role),
        &optional_text?(worker[&1])
      )
  end

  defp worker?(_), do: false

  defp documents?([source, dest], from, to, host) do
    fiber?(from) and fiber?(to) and from["uid"] != to["uid"] and
      document?(source, from, host, false) and document?(dest, to, host, true)
  end

  defp documents?(_, _, _, _), do: false

  defp document?(
         %{"path" => path, "uid" => uid, "host" => host, "before" => before, "after" => target},
         fiber,
         host,
         dest?
       ) do
    uid == fiber["uid"] and absolute?(path) and
      fields?(before, dest?) and fields?(target, dest?)
  end

  defp document?(_, _, _, _), do: false

  defp fields?(fields, dest?) when is_map(fields) do
    keys =
      ~w(status closed-at tempered horizon shuttle.runtime) ++ if(dest?, do: ["ask"], else: [])

    Enum.sort(Map.keys(fields)) == Enum.sort(keys) and
      fields["status"] in [nil, "open", "active", "closed"] and
      optional_text?(fields["closed-at"]) and optional_text?(fields["horizon"]) and
      fields["tempered"] in [nil, true, false] and
      (is_nil(fields["shuttle.runtime"]) or is_map(fields["shuttle.runtime"]))
  end

  defp fields?(_, _), do: false

  defp backend?(
         %{
           "type" => type,
           "before" => before,
           "after" => target,
           "aliases" => aliases,
           "identity" => identity
         },
         uuid,
         _,
         _,
         _
       )
       when type in ["tmux", "rex"] do
    identity?(type, identity, uuid) and text?(before) and text?(target) and before != target and
      is_list(aliases) and
      Enum.all?(aliases, fn
        %{"path" => path, "before" => previous, "after" => next} ->
          absolute?(path) and optional_text?(previous) and text?(next)

        _ ->
          false
      end)
  end

  defp backend?(%{"type" => "app", "before" => before, "after" => target}, uuid, from, to, host) do
    fiber?(from) and fiber?(to) and
      app_record?(before, uuid, from, host) and app_record?(target, uuid, to, host)
  end

  defp backend?(_, _, _, _, _), do: false

  defp app_record?(record, uuid, fiber, host) when is_map(record) do
    record["session_uuid"] == uuid and record["thread_id"] == uuid and
      record["backend_host"] == host and text?(record["backend_endpoint"]) and
      record["fiber_id"] == fiber["id"] and record["uid"] == fiber["uid"] and
      record["felt_store"] == fiber["store"]
  end

  defp app_record?(_, _, _, _), do: false

  defp identity?("tmux", %{"session_uuid" => uuid, "panes" => panes}, uuid) do
    is_list(panes) and panes != [] and
      Enum.all?(panes, fn pane ->
        is_binary(pane) and Regex.match?(~r/^\$[0-9]+\t[0-9]+\t%[0-9]+\t[1-9][0-9]*$/, pane)
      end)
  end

  defp identity?(
         "rex",
         %{"session_uuid" => uuid, "session_id" => sid, "block_id" => bid, "child_pid" => pid},
         uuid
       ) do
    native_ref?(sid, "session:") and native_ref?(bid, "block:") and is_integer(pid) and pid > 0
  end

  defp identity?(_, _, _), do: false

  defp native_ref?(value, prefix),
    do:
      is_binary(value) and String.starts_with?(value, prefix) and
        token?(String.replace_prefix(value, prefix, ""))

  defp resolution?(%{"resolution" => "unresolvable", "reason" => reason}), do: text?(reason)

  defp resolution?(entry),
    do: not Map.has_key?(entry, "resolution") and not Map.has_key?(entry, "reason")

  defp resolvable(%{"resolution" => "unresolvable", "reason" => reason}),
    do: {:error, {:journal_unresolvable, reason}}

  defp resolvable(_), do: :ok

  @doc "Persist a resource mismatch for operator reconciliation, without retrying another conversation."
  def unresolvable(entry, reason),
    do: put(Map.merge(entry, %{"resolution" => "unresolvable", "reason" => to_string(reason)}))

  def clear(entry), do: File.rm(path(entry))

  defp path(entry), do: Path.join(root(entry["host"]), entry["id"] <> ".json")

  defp put(entry) do
    path = path(entry)
    tmp = path <> "." <> Base.encode16(:crypto.strong_rand_bytes(8)) <> ".tmp"

    with :ok <- File.mkdir_p(root(entry["host"])),
         :ok <- File.chmod(root(), 0o700),
         :ok <- File.chmod(root(entry["host"]), 0o700),
         {:ok, file} <- File.open(tmp, [:write, :binary, :exclusive]) do
      result =
        with :ok <- File.chmod(tmp, 0o600),
             :ok <- IO.binwrite(file, Jason.encode!(entry)),
             :ok <- :file.sync(file),
             do: :ok

      File.close(file)
      result = if result == :ok, do: File.rename(tmp, path), else: result
      if result != :ok, do: File.rm(tmp)
      result
    end
  end

  defp encode_backend({:app, old, new}), do: %{"type" => "app", "before" => old, "after" => new}

  defp encode_backend({:terminal, type, old, new, aliases, identity}) do
    %{
      "type" => type,
      "identity" => identity,
      "before" => old,
      "after" => new,
      "aliases" =>
        Enum.map(aliases, fn {path, previous, target} ->
          %{
            "path" => path,
            "before" =>
              case previous do
                {:ok, value} -> value
                {:error, :enoent} -> nil
              end,
            "after" => target
          }
        end)
    }
  end
end
