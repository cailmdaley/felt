defmodule Shuttle.EnvGuardTest do
  @moduledoc """
  Process-global configuration is injected, not mutated.

  Daemon code reads the OS env, the `:shuttle` app env and `PATH` only through
  `Shuttle.Env`, so a test can scope a value instead of setting it globally;
  and an `async: true` test never writes global env, which every concurrently
  running test would see.
  """
  use ExUnit.Case, async: true

  @root Path.expand("../..", __DIR__)

  # Every global read in lib/ goes through the seam itself.
  @lib_allowlist %{"lib/shuttle/env.ex" => "the seam: the passthrough to the global value"}

  test "daemon code reads global configuration only through Shuttle.Env" do
    offenders =
      for path <- Path.wildcard(Path.join(@root, "lib/**/*.ex")),
          rel = Path.relative_to(path, @root),
          not Map.has_key?(@lib_allowlist, rel),
          {line, call} <- calls(path, &global_read?/1),
          do: "#{rel}:#{line}: #{call}"

    assert offenders == [],
           "read through Shuttle.Env.get/app/fetch_app/find_executable instead:\n" <>
             Enum.join(offenders, "\n")
  end

  test "async test modules never write global env" do
    offenders =
      for path <- Path.wildcard(Path.join(@root, "test/**/*_test.exs")),
          async_module?(path),
          {line, call} <- calls(path, &global_write?/1),
          do: "#{Path.relative_to(path, @root)}:#{line}: #{call}"

    assert offenders == [],
           "an async test scopes its values with Shuttle.Test.Env instead:\n" <>
             Enum.join(offenders, "\n")
  end

  defp global_read?({:System, f, _args}) when f in [:get_env, :fetch_env, :fetch_env!],
    do: true

  defp global_read?({:System, :find_executable, _args}), do: true

  defp global_read?({:Application, f, [:shuttle | _]})
       when f in [:get_env, :fetch_env, :fetch_env!, :get_all_env],
       do: true

  defp global_read?(_), do: false

  defp global_write?({:System, f, _args}) when f in [:put_env, :delete_env], do: true

  defp global_write?({:Application, f, _args})
       when f in [:put_env, :delete_env, :put_all_env],
       do: true

  defp global_write?(_), do: false

  defp async_module?(path) do
    path
    |> quoted()
    |> Macro.prewalk(false, fn
      {:use, _, [{:__aliases__, _, [:ExUnit, :Case]}, opts]} = node, acc when is_list(opts) ->
        {node, acc or Keyword.get(opts, :async) == true}

      node, acc ->
        {node, acc}
    end)
    |> elem(1)
  end

  # `{line, "Mod.fun/arity"}` for every remote call `pred` accepts, as
  # `{module_alias, function, literal_args}`.
  defp calls(path, pred) do
    path
    |> quoted()
    |> Macro.prewalk([], fn
      {{:., _, [{:__aliases__, _, [mod]}, fun]}, meta, args} = node, acc when is_list(args) ->
        if pred.({mod, fun, args}),
          do: {node, [{meta[:line], "#{mod}.#{fun}/#{length(args)}"} | acc]},
          else: {node, acc}

      node, acc ->
        {node, acc}
    end)
    |> elem(1)
    |> Enum.reverse()
  end

  defp quoted(path), do: path |> File.read!() |> Code.string_to_quoted!(file: path)
end
