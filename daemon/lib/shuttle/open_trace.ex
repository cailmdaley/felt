defmodule Shuttle.OpenTrace do
  @moduledoc "Request-local timings for terminal opens, logged once by the outermost caller."
  require Logger
  @key {__MODULE__, :steps}

  def run(name, host, fun) do
    if Process.get(@key) do
      fun.()
    else
      started = System.monotonic_time(:microsecond)
      Process.put(@key, [])

      try do
        fun.()
      after
        steps = Process.delete(@key) |> Enum.reverse()
        elapsed = (System.monotonic_time(:microsecond) - started) / 1000

        Logger.info(fn ->
          timings = Enum.map_join(steps, " ", fn {step, us} -> "#{step}=#{us / 1000}ms" end)

          "Terminal open name=#{inspect(name)} host=#{inspect(host || "local")} total=#{elapsed}ms #{timings}"
        end)
      end
    end
  end

  def step(name, fun) do
    started = System.monotonic_time(:microsecond)

    try do
      fun.()
    after
      if steps = Process.get(@key) do
        Process.put(@key, [{name, System.monotonic_time(:microsecond) - started} | steps])
      end
    end
  end
end
