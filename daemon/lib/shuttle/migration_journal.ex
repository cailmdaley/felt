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
    entry = Map.put(entry, "direction", "reverse")
    with :ok <- put(entry), do: {:ok, entry}
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
          Enum.map(Enum.filter(owned, &String.ends_with?(&1, ".json")), &Path.join(root(host), &1))

      paths
      |> Enum.sort()
      |> Enum.reduce_while({:ok, []}, fn path, {:ok, entries} ->
        with {:ok, bytes} <- File.read(path),
             {:ok, %{"version" => 1, "id" => id, "host" => owner} = entry} <- Jason.decode(bytes),
             true <- is_binary(id) and Path.basename(path) == id <> ".json" do
          if owner == host do
            with :ok <- relocate(entry, path) do
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
      with :ok <- put(entry), do: File.rm(previous)
    end
  end

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

  defp encode_backend({:tmux, old, new, aliases}) do
    %{
      "type" => "tmux",
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
