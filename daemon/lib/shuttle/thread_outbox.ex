defmodule Shuttle.ThreadOutbox do
  @moduledoc "Host-local immutable thread publications, retained until durable recipient enqueue."

  @doc "Establish the first-deployment cutoff before the Poller's first poll; never advance it."
  def boot_baseline do
    transaction(fn state ->
      {Map.put_new(state, "baseline", DateTime.to_iso8601(DateTime.utc_now())), :ok}
    end)
  end

  def baseline do
    transaction(fn state -> {state, Map.fetch!(state, "baseline")} end)
  end

  def capture(records) do
    transaction(fn state ->
      _baseline = Map.fetch!(state, "baseline")

      next =
        Enum.reduce(records, state["records"], fn {id, record}, acc ->
          Map.put_new(acc, id, record)
        end)

      {Map.put(state, "records", next), :ok}
    end)
  end

  def pending(owner) do
    transaction(fn state ->
      pending =
        Enum.filter(state["records"], fn {_id, record} ->
          record["owner"] == owner and record["acked"] != true
        end)

      {state, pending}
    end)
  end

  def acknowledge(id) do
    transaction(fn state ->
      {update_in(state, ["records", id], &Map.put(&1, "acked", true)), :ok}
    end)
  end

  # Capture and acknowledgment serialize across overlapping poll tasks. Disk is
  # authoritative; no process memory is needed to retry after daemon restart.
  defp transaction(fun) do
    path = Path.join(Shuttle.data_dir(), "thread-outbox.json")

    :global.trans({{__MODULE__, path}, self()}, fn ->
      state =
        case File.read(path) do
          {:ok, bytes} ->
            case Jason.decode!(bytes) do
              %{"version" => 2, "records" => records, "baseline" => baseline} = state
              when is_map(records) and is_binary(baseline) ->
                {:ok, _, _} = DateTime.from_iso8601(baseline)
                state

              %{"version" => 1, "records" => records} when is_map(records) ->
                %{"version" => 2, "records" => records}

              _ ->
                raise "invalid thread outbox: #{path}"
            end

          {:error, :enoent} ->
            %{"version" => 2, "records" => %{}}

          {:error, reason} ->
            raise File.Error, reason: reason, action: "read", path: path
        end

      {next, result} = fun.(state)

      if next != state do
        File.mkdir_p!(Path.dirname(path))
        tmp = path <> ".#{System.unique_integer([:positive])}.tmp"

        try do
          File.write!(tmp, Jason.encode!(next), [:binary, :sync])
          File.rename!(tmp, path)
        after
          File.rm(tmp)
        end
      end

      result
    end)
  end
end
