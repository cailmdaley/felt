defmodule Shuttle.Voice.Transcript do
  @moduledoc "The recorder-local day transcript, including unrouted and discarded speech."

  def directory, do: Path.join(Shuttle.data_dir(), "transcripts")

  def today do
    {date, _} = :calendar.local_time()
    date |> Date.from_erl!() |> Date.to_iso8601()
  end

  def local_time(iso) do
    {:ok, at, _} = DateTime.from_iso8601(iso)
    {_date, time} = :calendar.system_time_to_local_time(DateTime.to_unix(at), :second)
    time |> Time.from_erl!() |> Time.to_iso8601()
  end

  defp date(iso) do
    {:ok, at, _} = DateTime.from_iso8601(iso)
    {date, _time} = :calendar.system_time_to_local_time(DateTime.to_unix(at), :second)
    date |> Date.from_erl!() |> Date.to_iso8601()
  end

  def append(rows) do
    for {day, rows} <- Enum.group_by(rows, &date(&1["t"])) do
      path = Path.join(directory(), day <> ".jsonl")

      :global.trans({{__MODULE__, path}, self()}, fn ->
        :ok = Shuttle.FS.mkdir_p(directory())
        existing = read_rows(path)
        # Replaying a relay checkpoint must not duplicate the day's speech.
        known = MapSet.new(existing)
        fresh = Enum.reject(rows, &MapSet.member?(known, &1))

        if fresh != [],
          do:
            :ok = Shuttle.FS.write(path, Enum.map(fresh, &(Jason.encode!(&1) <> "\n")), [:append])
      end)
    end

    :ok
  end

  def read(params \\ %{}) do
    day = params["date"] || today()

    with {:ok, _} <- Date.from_iso8601(day),
         {:ok, since} <- since(params["since"]) do
      fibers = fiber_ids(params["fiber"])

      rows =
        directory()
        |> Path.join(day <> ".jsonl")
        |> read_rows()
        |> Enum.filter(fn row ->
          (is_nil(fibers) or row["fiber_id"] in fibers or
             (is_binary(row["fiber_id"]) and Path.basename(row["fiber_id"]) in fibers)) and
            (is_nil(since) or local_time(row["t"]) >= since)
        end)

      {:ok, %{date: day, rows: rows}}
    else
      _ -> {:error, "date must be YYYY-MM-DD and since must be HH:MM[:SS]"}
    end
  end

  defp fiber_ids(fiber) when fiber in [nil, ""], do: nil

  defp fiber_ids(fiber) do
    served = Shuttle.Env.app(:voice_fibers, &Shuttle.ServedFibers.all/0)
    aliases = fn f -> Enum.reject([f["uid"], f["id"], f["slug"]], &is_nil/1) end

    [
      fiber
      | Enum.flat_map(served.(), fn f ->
          if Enum.any?(aliases.(f), &(fiber in [&1, Path.basename(&1)])),
            do: aliases.(f),
            else: []
        end)
    ]
  end

  defp since(nil), do: {:ok, nil}

  defp since(value) when is_binary(value) do
    value = if byte_size(value) == 5, do: value <> ":00", else: value
    with {:ok, time} <- Time.from_iso8601(value), do: {:ok, Time.to_iso8601(time)}
  end

  defp read_rows(path) do
    case Shuttle.FS.read(path) do
      {:ok, bytes} -> bytes |> String.split("\n", trim: true) |> Enum.map(&Jason.decode!/1)
      {:error, :enoent} -> []
      {:error, reason} -> raise File.Error, reason: reason, action: "read transcript", path: path
    end
  end
end
