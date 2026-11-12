defmodule Shuttle.Test.StackSampler do
  @moduledoc false
  # Samples the stacks of the processes `targets.()` names (evaluated in the
  # caller's scope), and of the processes they are linked to, every
  # millisecond while `fun` runs; prints the most frequent frames.
  def run(fun, targets \\ nil, top \\ 15) do
    parent = self()
    callers = Shuttle.Env.callers()
    targets = targets || fn -> [parent] end

    sampler =
      spawn(fn ->
        Shuttle.Env.adopt_callers(callers)
        loop(targets, %{})
      end)

    result = fun.()
    send(sampler, {:stop, self()})

    counts =
      receive do
        {:counts, counts} -> counts
      end

    counts
    |> Enum.sort_by(&(-elem(&1, 1)))
    |> Enum.take(top)
    |> Enum.each(fn {frames, n} -> IO.puts("SAMPLE #{n} #{frames}") end)

    result
  end

  defp loop(targets, counts) do
    receive do
      {:stop, from} -> send(from, {:counts, counts})
    after
      1 ->
        pids =
          for t <- targets.(), pid = (is_pid(t) && t) || Process.whereis(t), is_pid(pid) do
            {:links, links} = Process.info(pid, :links) || {:links, []}
            [pid | Enum.filter(links, &is_pid/1)]
          end
          |> List.flatten()
          |> Enum.uniq()

        counts =
          Enum.reduce(pids, counts, fn pid, counts ->
            case Process.info(pid, :current_stacktrace) do
              {:current_stacktrace, stack} ->
                key =
                  stack
                  |> Enum.reject(fn {m, _, _, _} -> m in [__MODULE__] end)
                  |> Enum.take(5)
                  |> Enum.map_join(" < ", fn {m, f, a, loc} ->
                    "#{inspect(m)}.#{f}/#{if is_list(a), do: length(a), else: a}:#{loc[:line]}"
                  end)

                Map.update(counts, key, 1, &(&1 + 1))

              _ ->
                counts
            end
          end)

        loop(targets, counts)
    end
  end
end
