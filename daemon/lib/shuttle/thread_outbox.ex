defmodule Shuttle.ThreadOutbox do
  @moduledoc "Host-local pending thread payloads and permanent, payload-free acknowledgment IDs."

  @doc "Establish the first-deployment cutoff before polling; never reset or advance it."
  def boot_baseline, do: transaction(true, fn _root, _baseline -> :ok end)

  def baseline, do: transaction(false, fn _root, baseline -> baseline end)

  # Each capture checks just its own ID. Neither the acknowledged history nor
  # unrelated pending payloads are read or rewritten on this synchronous path.
  def capture(records) do
    transaction(false, fn root, _baseline ->
      Enum.each(records, fn {id, record} -> capture_one(root, id, record) end)
      :ok
    end)
  end

  def pending(owner) do
    transaction(false, fn root, _baseline ->
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
          if record["owner"] == owner, do: [{id, record}], else: []
        end
      end)
    end)
  end

  def acknowledge(id) do
    transaction(false, fn root, _baseline ->
      acknowledge_one(root, id)
      :ok
    end)
  end

  defp capture_one(root, id, record) do
    path = pending_path(root, id)

    unless File.exists?(acked_path(root, id)) or File.exists?(path) do
      write_atomic!(path, Jason.encode!(%{id: id, record: record}))
    end
  end

  # Retention rule: payloads live only until durable acknowledgment. IDs have
  # no expiry: an unchanged lifecycle stamp can be observed again indefinitely.
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

  # Serialize host-local capture, ack and snapshot migration. Each steady-state
  # operation touches constant-size metadata and its addressed payloads only.
  defp transaction(boot?, fun) do
    root = Path.join(Shuttle.data_dir(), "thread-outbox")

    :global.trans({{__MODULE__, root}, self()}, fn ->
      baseline = prepare!(root, boot?)
      fun.(root, baseline)
    end)
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
          else: capture_one(root, id, migrate_recipient(record))
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
