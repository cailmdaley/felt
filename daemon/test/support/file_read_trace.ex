defmodule Shuttle.Test.FileReadTrace do
  @moduledoc "Observe whole-file reads on the request process, not the test adapter's pread."

  def run(fun) do
    parent = self()
    :erlang.trace_pattern({File, :read, 1}, true, [:local])

    worker =
      spawn(fn ->
        receive do
          :run ->
            result = fun.()
            ref = :erlang.trace_delivered(self())

            receive do
              {:trace_delivered, _, ^ref} -> :ok
            end

            send(parent, {:result, self(), result})
        end
      end)

    :erlang.trace(worker, true, [:call, {:tracer, parent}])
    send(worker, :run)

    try do
      collect(worker, [])
    after
      :erlang.trace_pattern({File, :read, 1}, false, [:local])
      Process.exit(worker, :kill)
    end
  end

  defp collect(worker, reads) do
    receive do
      {:trace, ^worker, :call, {File, :read, [path]}} -> collect(worker, [path | reads])
      {:result, ^worker, result} -> {result, Enum.reverse(reads)}
    after
      10_000 -> raise "file request did not complete"
    end
  end
end
