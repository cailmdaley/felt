defmodule Shuttle.MigrationJournal do
  @moduledoc "Durable assignment intent, replayed before any worker adoption or launch."

  def root, do: Path.join(Shuttle.data_dir(), "migrations")

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

  def pending do
    with :ok <- File.mkdir_p(root()), {:ok, names} <- File.ls(root()) do
      names
      |> Enum.filter(&String.ends_with?(&1, ".json"))
      |> Enum.sort()
      |> Enum.reduce_while({:ok, []}, fn name, {:ok, entries} ->
        with {:ok, bytes} <- File.read(Path.join(root(), name)),
             {:ok, %{"version" => 1, "id" => id} = entry} <- Jason.decode(bytes),
             true <- name == id <> ".json" do
          {:cont, {:ok, entries ++ [entry]}}
        else
          error -> {:halt, {:error, {:journal_unreadable, name, error}}}
        end
      end)
    end
  end

  def clear(entry), do: File.rm(path(entry["id"]))

  defp path(id), do: Path.join(root(), id <> ".json")

  defp put(entry) do
    path = path(entry["id"])
    tmp = path <> "." <> Base.encode16(:crypto.strong_rand_bytes(8)) <> ".tmp"

    with :ok <- File.mkdir_p(root()),
         :ok <- File.chmod(root(), 0o700),
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
