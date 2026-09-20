defmodule Shuttle.RealHarnessIsolationTest do
  use ExUnit.Case, async: true

  test "loading real harness smoke tests does not run external commands" do
    source = Path.join(__DIR__, "real_harness_smoke_test.exs")
    ast = source |> File.read!() |> Code.string_to_quoted!()

    # Function and test bodies run only when called. Everything else in the
    # module, including availability checks, executes when ExUnit loads it.
    {_, calls} =
      Macro.prewalk(ast, [], fn
        {kind, _, _}, calls when kind in [:def, :defp, :test] ->
          {nil, calls}

        {{:., _, [{:__aliases__, _, [:System]}, command]}, _, _} = node, calls
        when command in [:cmd, :shell] ->
          {node, [Macro.to_string(node) | calls]}

        node, calls ->
          {node, calls}
      end)

    assert calls == [], "smoke module starts external commands while loading: #{inspect(calls)}"
  end
end
