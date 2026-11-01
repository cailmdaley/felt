defmodule Shuttle.ThreadOutbox do
  @moduledoc "Host-local pending thread payloads and retained, payload-free acknowledgment IDs."
  @retention_ms 14 * 24 * 60 * 60 * 1_000
  @prune_interval_ms 60 * 60 * 1_000

  @doc "Establish the first-deployment cutoff before polling; never reset or advance it."
  def boot_baseline, do: transaction(true, fn _root, _baseline, _cutoff -> :ok end)

  def baseline, do: transaction(false, fn _root, baseline, _cutoff -> baseline end)

  # Each capture checks just its own ID. A durable cutoff makes a pruned
  # acknowledgment unnecessary for rejecting a replay outside retention.
  def capture(records) do
    transaction(false, fn root, _baseline, cutoff ->
      Enum.each(records, fn {id, record} -> capture_one(root, id, record, cutoff) end)
      :ok
    end)
  end

  @doc "Capture records and return only the ids created by this call."
  def capture_new(records) do
    transaction(false, fn root, _baseline, cutoff ->
      Enum.flat_map(records, fn {id, record} ->
        if capture_one(root, id, record, cutoff), do: [id], else: []
      end)
    end)
  end

  def pending(owner) do
    transaction(false, fn root, _baseline, cutoff ->
      root
      |> Path.join("pending/*.json")
      |> Path.wildcard()
      |> Enum.flat_map(fn path ->
        key = Path.basename(path, ".json")

        if File.exists?(Path.join([root, "acked", key])) do
          # Crash after durable ack but before payload removal.
          File.rm!(path)
          []
        else
          %{"id" => id, "record" => record} = path |> File.read!() |> Jason.decode!()
          true = key == key(id)

          if retained?(record, cutoff) do
            if record["owner"] == owner, do: [{id, record}], else: []
          else
            File.rm!(path)
            []
          end
        end
      end)
    end)
  end

  @doc "Update a pending payload atomically without changing its delivery identity."
  def update_pending(id, record) when is_map(record) do
    transaction(false, fn root, _baseline, cutoff ->
      path = pending_path(root, id)

      cond do
        not retained?(record, cutoff) ->
          {:error, :expired}

        File.exists?(acked_path(root, id)) ->
          {:error, :acknowledged}

        true ->
          case File.read(path) do
            {:ok, _} ->
              write_atomic!(path, Jason.encode!(%{id: id, record: record}))
              :ok

            {:error, :enoent} ->
              {:error, :not_pending}

            {:error, reason} ->
              raise File.Error, reason: reason, action: "read", path: path
          end
      end
    end)
  end

  def acknowledge(id) do
    transaction(false, fn root, _baseline, _cutoff ->
      acknowledge_one(root, id)
      :ok
    end)
  end

  defp capture_one(root, id, record, cutoff) do
    path = pending_path(root, id)

    if not retained?(record, cutoff) or File.exists?(acked_path(root, id)) or File.exists?(path) do
      false
    else
      write_atomic!(path, Jason.encode!(%{id: id, record: record}))
      true
    end
  end

  # The cutoff in retention_cutoff prevents old lifecycle stamps from being
  # replayed after their acknowledgment tombstones expire.
  # Publish the tombstone before deleting the payload, so interruption cannot
  # cause republication or lose an unacknowledged result.
  defp acknowledge_one(root, id) do
    path = acked_path(root, id)
    unless File.exists?(path), do: write_atomic!(path, id)

    case File.rm(pending_path(root, id)) do
      :ok ->
        :ok

      {:error, :enoent} ->
        :ok

      {:error, reason} ->
        raise File.Error, reason: reason, action: "remove pending payload", path: path
    end
  end

  defp key(id), do: :crypto.hash(:sha256, id) |> Base.encode16(case: :lower)
  defp pending_path(root, id), do: Path.join([root, "pending", key(id) <> ".json"])
  defp acked_path(root, id), do: Path.join([root, "acked", key(id)])

  # Serialize host-local capture, ack, pruning and snapshot migration.
  defp transaction(boot?, fun) do
    root = Path.join(Shuttle.data_dir(), "thread-outbox")

    :global.trans({{__MODULE__, root}, self()}, fn ->
      baseline = prepare!(root, boot?)
      {cutoff, prune?} = retention_cutoff(root, boot?)

      if prune? do
        persist_retention_cutoff!(root, cutoff)
        prune_acked!(root, cutoff)
      end

      fun.(root, baseline, cutoff)
    end)
  end

  defp retention_cutoff(root, force?) do
    path = Path.join(root, "retention_cutoff")
    marker = Path.join(root, "last_pruned")
    now = DateTime.utc_now()
    candidate = DateTime.add(now, -@retention_ms, :millisecond)

    current =
      case File.read(path) do
        {:ok, value} ->
          {:ok, date, _} = DateTime.from_iso8601(value)
          date

        {:error, :enoent} ->
          DateTime.add(candidate, -1, :millisecond)

        {:error, reason} ->
          raise File.Error, reason: reason, action: "read", path: path
      end

    cutoff = if DateTime.compare(current, candidate) == :gt, do: current, else: candidate
    prune? = force? or prune_due?(marker, now)
    {cutoff, prune?}
  end

  defp retained?(record, cutoff) do
    if is_nil(cutoff) do
      true
    else
      case get_in(record, ["signal", "stamp"]) || record["retained_at"] do
        stamp when is_binary(stamp) ->
          case DateTime.from_iso8601(stamp) do
            {:ok, date, _} -> DateTime.compare(date, cutoff) != :lt
            _ -> true
          end

        _ ->
          true
      end
    end
  end

  defp prune_due?(marker, now) do
    case File.read(marker) do
      {:ok, value} ->
        DateTime.to_unix(now, :millisecond) - String.to_integer(value) >= @prune_interval_ms

      {:error, :enoent} ->
        true

      {:error, reason} ->
        raise File.Error, reason: reason, action: "read", path: marker
    end
  end

  defp persist_retention_cutoff!(root, cutoff) do
    Path.join(root, "retention_cutoff")
    |> write_atomic!(DateTime.to_iso8601(cutoff))
  end

  defp prune_acked!(root, cutoff) do
    acked = Path.join(root, "acked")
    marker = Path.join(root, "last_pruned")
    now = System.system_time(:millisecond)
    cutoff_seconds = DateTime.to_unix(cutoff)

    Path.wildcard(Path.join(acked, "*"))
    |> Enum.each(fn path ->
      case File.stat(path, time: :posix) do
        {:ok, %{mtime: mtime}} ->
          if mtime < cutoff_seconds, do: File.rm!(path)

        {:error, :enoent} ->
          :ok

        {:error, reason} ->
          raise File.Error, reason: reason, action: "stat", path: path
      end
    end)

    write_atomic!(marker, Integer.to_string(now))
  end

  defp prepare!(root, boot?) do
    snapshot = root <> ".json"
    legacy = read_snapshot!(snapshot)
    path = Path.join(root, "baseline")

    baseline =
      case File.read(path) do
        {:ok, value} ->
          valid_baseline!(value)

        {:error, :enoent} ->
          # A missing cutoff in an established store is corruption, not first
          # deployment. Never recover by resetting it and dropping pending work.
          if File.exists?(Path.join(root, "version")) or payloads?(root) or not boot?,
            do: raise("missing thread outbox baseline: #{path}")

          value =
            valid_baseline!(
              (legacy && legacy["baseline"]) || DateTime.to_iso8601(DateTime.utc_now())
            )

          write_atomic!(path, value)
          value

        {:error, reason} ->
          raise File.Error, reason: reason, action: "read", path: path
      end

    File.mkdir_p!(Path.join(root, "pending"))
    File.mkdir_p!(Path.join(root, "acked"))

    unless File.exists?(Path.join(root, "version")),
      do: write_atomic!(Path.join(root, "version"), "4")

    if legacy do
      if legacy["baseline"] && legacy["baseline"] != baseline,
        do: raise("thread outbox snapshot cutoff differs from durable baseline: #{snapshot}")

      # Idempotent across interruption at any record; remove the full snapshot
      # only after every pending payload and acknowledgment has been installed.
      Enum.each(legacy["records"], fn {id, record} ->
        if record["acked"] == true,
          do: acknowledge_one(root, id),
          else: capture_one(root, id, migrate_recipient(record), nil)
      end)

      File.rm!(snapshot)
    end

    baseline
  end

  defp payloads?(root) do
    Enum.any?(["pending", "acked"], fn dir ->
      case File.ls(Path.join(root, dir)) do
        {:ok, []} -> false
        {:ok, _} -> true
        {:error, :enoent} -> false
        {:error, reason} -> raise File.Error, reason: reason, action: "list", path: root
      end
    end)
  end

  defp valid_baseline!(value) do
    {:ok, _, _} = DateTime.from_iso8601(value)
    value
  end

  defp read_snapshot!(path) do
    case File.read(path) do
      {:ok, bytes} ->
        state = Jason.decode!(bytes)

        case state do
          %{"version" => version, "records" => records}
          when version in [1, 2, 3] and is_map(records) ->
            if version != 1, do: valid_baseline!(Map.fetch!(state, "baseline"))
            true = Enum.all?(records, fn {id, record} -> is_binary(id) and is_map(record) end)
            state

          _ ->
            raise "invalid thread outbox snapshot: #{path}"
        end

      {:error, :enoent} ->
        nil

      {:error, reason} ->
        raise File.Error, reason: reason, action: "read", path: path
    end
  end

  defp migrate_recipient(record) do
    case get_in(record, ["parent", "uid"]) do
      uid when is_binary(uid) -> record |> Map.delete("parent") |> Map.put("parent_uid", uid)
      _ -> record
    end
  end

  defp write_atomic!(path, bytes) do
    File.mkdir_p!(Path.dirname(path))
    tmp = path <> ".#{System.unique_integer([:positive])}.tmp"

    try do
      File.write!(tmp, bytes, [:binary, :sync])
      File.rename!(tmp, path)
    after
      File.rm(tmp)
    end
  end
end
