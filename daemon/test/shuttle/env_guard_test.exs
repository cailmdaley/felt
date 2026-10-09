defmodule Shuttle.EnvGuardTest do
  @moduledoc """
  Process-global configuration is injected, not mutated.

  Daemon code reads the OS env, the `:shuttle` app env, `PATH`, the home
  directory and spawns children only through `Shuttle.Env`, so a test can
  scope a value instead of setting it globally; and neither an `async: true`
  test nor shared test support writes VM-global state, which every
  concurrently running test would see.

  Calls are matched in the AST with aliases resolved per module, so
  `alias System, as: S`, `Elixir.System`, `apply/3`, captures and
  module-attribute app names are all seen.
  """
  use ExUnit.Case, async: true

  @root Path.expand("../..", __DIR__)

  # `{module, function}` reads a lib file may make directly, with the reason.
  @lib_allowlist %{
    "lib/shuttle/env.ex" => {:all, "the seam: the passthrough to the global value"},
    "lib/mix/tasks/shuttle.gen_version.ex" => {:all, "a build-time Mix task, not the daemon"},
    "lib/shuttle/folder_picker.ex" =>
      {[{System, :user_home}], "a nil-tolerant default start dir for a dialog"},
    "lib/shuttle/remote_registry.ex" =>
      {[{Application, :compile_env}], "compile-time switch for the test-only CA bundle"}
  }

  # Async test files that write `:persistent_term`, with the reason it is safe.
  @term_write_allowlist %{
    "test/shuttle/session_link_test.exs" => "keys are this test's own session uuids",
    "test/shuttle/felt_stores_test.exs" => "the key is this test's Shuttle.Env.scope_key slot",
    "test/shuttle/env_isolation_test.exs" => "the key is this test's Shuttle.Env.scope_key slot"
  }

  test "daemon code reads global configuration only through Shuttle.Env" do
    offenders =
      for path <- Path.wildcard(Path.join(@root, "lib/**/*.ex")),
          rel = Path.relative_to(path, @root),
          {line, call} <- calls(path),
          global_read?(call),
          not lib_allowed?(rel, call),
          do: "#{rel}:#{line}: #{describe(call)}"

    assert offenders == [],
           "read through Shuttle.Env (get/app/find_executable/home/expand/cmd) instead:\n" <>
             Enum.join(offenders, "\n")
  end

  test "async test modules and shared test support never write VM-global state" do
    files =
      Enum.filter(Path.wildcard(Path.join(@root, "test/**/*_test.exs")), &async_module?/1) ++
        Path.wildcard(Path.join(@root, "test/support/**/*.ex"))

    offenders =
      for path <- files,
          rel = Path.relative_to(path, @root),
          {line, call} <- calls(path),
          global_write?(call),
          not (match?({:persistent_term, :put, _}, call) and
                 Map.has_key?(@term_write_allowlist, rel)),
          do: "#{rel}:#{line}: #{describe(call)}"

    assert offenders == [],
           "scope the value with Shuttle.Test.Env (or Shuttle.Env.scope_key/1) instead:\n" <>
             Enum.join(offenders, "\n")
  end

  # ── what counts ──

  @system_reads [
    :get_env,
    :fetch_env,
    :fetch_env!,
    :find_executable,
    :user_home,
    :user_home!,
    :cmd,
    :shell
  ]
  @app_reads [:get_env, :fetch_env, :fetch_env!, :get_all_env, :compile_env, :compile_env!]

  defp global_read?({System, f, _}) when f in @system_reads, do: true
  defp global_read?({:os, f, _}) when f in [:getenv, :find_executable, :cmd], do: true

  # An app read is fine only when it literally names another application; a
  # capture (`&Application.get_env/2`) has no arguments at all.
  defp global_read?({Application, f, [app | _]}) when f in @app_reads,
    do: not (is_atom(app) and app != :shuttle)

  defp global_read?({Application, f, []}) when f in @app_reads, do: true

  # `Path.expand/1` of anything but a compile-time `__DIR__` path, and any
  # expansion of a literal `~` path, resolves the real home.
  defp global_read?({Path, :expand, [arg]}), do: not mentions_dir?(arg)
  defp global_read?({Path, :expand, ["~" <> _ | _]}), do: true
  defp global_read?(_), do: false

  defp global_write?({System, f, _}) when f in [:put_env, :delete_env], do: true
  defp global_write?({:os, f, _}) when f in [:putenv, :unsetenv], do: true

  defp global_write?({Application, f, _}) when f in [:put_env, :delete_env, :put_all_env],
    do: true

  defp global_write?({:persistent_term, :put, _}), do: true
  defp global_write?({Logger, f, _}) when f in [:configure, :configure_backend], do: true

  defp global_write?({:logger, f, _}) when f in [:set_primary_config, :update_primary_config],
    do: true

  defp global_write?(_), do: false

  defp lib_allowed?(rel, {mod, fun, _}) do
    case Map.get(@lib_allowlist, rel) do
      {:all, _reason} -> true
      {calls, _reason} -> {mod, fun} in calls
      nil -> false
    end
  end

  defp mentions_dir?(ast) do
    {_, found} =
      Macro.prewalk(ast, false, fn
        {:__DIR__, _, _} = node, _ -> {node, true}
        node, acc -> {node, acc}
      end)

    found
  end

  defp describe({mod, fun, args}), do: "#{inspect(mod)}.#{fun}/#{length(args)}"

  # ── the AST walk ──

  defp async_module?(path) do
    {_, async?} =
      path
      |> quoted()
      |> Macro.prewalk(false, fn
        {:use, _, [{:__aliases__, _, [:ExUnit, :Case]}, opts]} = node, acc when is_list(opts) ->
          {node, acc or Keyword.get(opts, :async) == true}

        node, acc ->
          {node, acc}
      end)

    async?
  end

  # `{line, {module, function, args}}` for every remote call in `path`, with
  # aliases resolved per module (nested modules inherit their parent's).
  defp calls(path), do: path |> quoted() |> collect(%{}) |> Enum.sort()

  defp collect({:defmodule, _, [_name, [do: body]]}, aliases),
    do: walk(body, Map.merge(aliases, aliases_in(body)))

  defp collect(ast, aliases), do: walk(ast, aliases)

  defp walk(ast, aliases) do
    {_, acc} =
      Macro.prewalk(ast, [], fn
        # A nested module is walked with its own aliases; replacing it with
        # `:ok` keeps this walk from visiting it twice.
        {:defmodule, _, _} = node, acc -> {:ok, acc ++ collect(node, aliases)}
        node, acc -> {node, acc ++ call_of(node, aliases)}
      end)

    acc
  end

  # `apply(Mod, :fun, args)` and `:erlang.apply/3` count as the call they make.
  defp call_of({:apply, meta, [mod, fun, args]}, aliases) do
    case resolve(mod, aliases) do
      nil ->
        []

      mod ->
        [{meta[:line], {mod, if(is_atom(fun), do: fun, else: :__dynamic__), List.wrap(args)}}]
    end
  end

  defp call_of({{:., meta, [mod, fun]}, _, args}, aliases) when is_atom(fun) and is_list(args) do
    case resolve(mod, aliases) do
      nil -> []
      :erlang when fun == :apply and length(args) == 3 -> call_of({:apply, meta, args}, aliases)
      mod -> [{meta[:line], {mod, fun, args}}]
    end
  end

  defp call_of(_node, _aliases), do: []

  defp resolve({:__aliases__, _, [:"Elixir" | rest]}, _aliases), do: Module.concat(rest)

  defp resolve({:__aliases__, _, [head | rest]}, aliases) when is_atom(head) do
    case Map.get(aliases, head) do
      nil -> Module.concat([head | rest])
      full -> Module.concat([full | rest])
    end
  end

  defp resolve(mod, _aliases) when is_atom(mod), do: mod
  defp resolve(_, _), do: nil

  # The `alias` directives directly in a module body (not in nested modules).
  defp aliases_in(body) do
    body
    |> List.wrap()
    |> Enum.flat_map(fn
      {:__block__, _, exprs} -> exprs
      expr -> [expr]
    end)
    |> Enum.flat_map(&alias_entries/1)
    |> Map.new()
  end

  defp alias_entries({:alias, _, [{:__aliases__, _, segs}, opts]}) when is_list(opts) do
    case Keyword.get(opts, :as) do
      {:__aliases__, _, [as]} -> [{as, Module.concat(strip(segs))}]
      _ -> [{List.last(segs), Module.concat(strip(segs))}]
    end
  end

  defp alias_entries({:alias, _, [{:__aliases__, _, segs}]}),
    do: [{List.last(segs), Module.concat(strip(segs))}]

  defp alias_entries({:alias, _, [{{:., _, [{:__aliases__, _, base}, :{}]}, _, children}]}) do
    for {:__aliases__, _, segs} <- children,
        do: {List.last(segs), Module.concat(strip(base) ++ segs)}
  end

  defp alias_entries(_), do: []

  defp strip([:"Elixir" | rest]), do: rest
  defp strip(segs), do: segs

  defp quoted(path), do: path |> File.read!() |> Code.string_to_quoted!(file: path)
end
