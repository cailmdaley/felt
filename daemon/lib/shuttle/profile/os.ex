defmodule Shuttle.Profile.OS do
  @moduledoc false

  def snapshot do
    if :os.type() == {:unix, :linux}, do: snapshot("/proc/self")
  end

  @doc false
  def snapshot(root) do
    with {:ok, stat} <- File.read(Path.join(root, "stat")),
         {:ok, process} <- parse_stat(stat) do
      threads =
        case File.ls(Path.join(root, "task")) do
          {:ok, tids} ->
            for tid <- tids,
                {:ok, comm} <- [File.read(Path.join([root, "task", tid, "comm"]))],
                {:ok, stat} <- [File.read(Path.join([root, "task", tid, "stat"]))],
                {:ok, cpu} <- [parse_stat(stat)],
                into: %{} do
              {tid, %{name: String.trim(comm), cpu: cpu}}
            end

          {:error, _} ->
            %{}
        end

      %{process: process, threads: threads, rlimit_cpu: limits(root)}
    else
      {:error, _} -> nil
    end
  end

  # Linux exports these fields in USER_HZ; this instrument assumes 100 ticks/s
  # (the Linux ABI default), avoiding an external getconf process per profile.
  @ticks 100
  def delta(nil, _), do: nil
  def delta(_, nil), do: nil

  def delta(before, later) do
    threads =
      Enum.reduce(later.threads, %{}, fn {tid, thread}, acc ->
        old = Map.get(before.threads, tid)
        # New threads start at zero; a recycled tid has a different starttime.
        baseline = if old && old.cpu.starttime == thread.cpu.starttime, do: old.cpu, else: zero()
        cpu = cpu_delta(baseline, thread.cpu)

        Map.update(acc, thread.name, cpu, fn previous ->
          %{utime: previous.utime + cpu.utime, stime: previous.stime + cpu.stime}
        end)
      end)

    %{
      process: cpu_delta(before.process, later.process),
      threads: threads,
      accumulated: %{
        utime: later.process.utime / @ticks,
        stime: later.process.stime / @ticks,
        total: (later.process.utime + later.process.stime) / @ticks
      },
      rlimit_cpu: later.rlimit_cpu,
      clock_ticks_per_second: @ticks
    }
  end

  defp zero, do: %{utime: 0, stime: 0}

  defp cpu_delta(a, b),
    do: %{utime: max(b.utime - a.utime, 0) / @ticks, stime: max(b.stime - a.stime, 0) / @ticks}

  @doc false
  def parse_stat(text) do
    # comm is parenthesized and may itself contain spaces or closing parens.
    case Regex.run(~r/^\d+ \(.*\) (.*)$/s, String.trim(text), capture: :all_but_first) do
      [tail] ->
        fields = String.split(tail)

        with {u, ""} <- Integer.parse(Enum.at(fields, 11, "")),
             {s, ""} <- Integer.parse(Enum.at(fields, 12, "")),
             {start, ""} <- Integer.parse(Enum.at(fields, 19, "")) do
          {:ok, %{utime: u, stime: s, starttime: start}}
        else
          _ -> {:error, :invalid_stat}
        end

      _ ->
        {:error, :invalid_stat}
    end
  end

  defp limits(root) do
    case File.read(Path.join(root, "limits")) do
      {:ok, text} ->
        case Regex.run(~r/^Max cpu time\s+(\S+)\s+(\S+)/m, text, capture: :all_but_first) do
          [soft, hard] -> %{soft: limit(soft), hard: limit(hard)}
          _ -> nil
        end

      {:error, _} ->
        nil
    end
  end

  defp limit("unlimited"), do: "unlimited"
  defp limit(value), do: String.to_integer(value)
end
