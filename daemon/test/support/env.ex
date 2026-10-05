defmodule Shuttle.Test.Env do
  @moduledoc """
  Scoped overrides of the OS env, the `:shuttle` application env and `PATH`,
  visible only to the calling test and the processes acting for it (see
  `Shuttle.Env`). Overrides vanish when the test exits, after its
  `start_supervised` children have stopped, so a test never saves or restores
  global state by hand and async tests cannot see each other's values.

      setup do
        Shuttle.Test.Env.put_env("SHUTTLE_STORES", tmp)
        Shuttle.Test.Env.put_app_env(:felt_runner, MyRunner)
        :ok
      end

  Call these from a test body or a `setup` block — the test process owns the
  scope. A `setup_all` process is not an ancestor of the tests it precedes, so
  overrides registered there reach no test.
  """

  @table Shuttle.Env.table()

  @doc "Create the override table. Called once from `test_helper.exs`."
  def start! do
    if :ets.whereis(@table) == :undefined do
      parent = self()

      holder =
        spawn(fn ->
          :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
          send(parent, {:shuttle_env_table, self()})
          Process.sleep(:infinity)
        end)

      receive do
        {:shuttle_env_table, ^holder} -> :ok
      end
    end

    :ok
  end

  @doc "Set an OS env var for this test's scope; `nil` reads as unset."
  def put_env(name, nil) when is_binary(name), do: delete_env(name)

  def put_env(name, value) when is_binary(name) and is_binary(value),
    do: put(:env, name, {:set, value})

  @doc "Make an OS env var read as unset in this test's scope."
  def delete_env(name) when is_binary(name), do: put(:env, name, :delete)

  @doc "Set a `:shuttle` app env key for this test's scope."
  def put_app_env(key, value) when is_atom(key), do: put(:app, key, {:set, value})

  @doc "Make a `:shuttle` app env key read as absent in this test's scope."
  def delete_app_env(key) when is_atom(key), do: put(:app, key, :delete)

  @doc "Prepend `dir` to this test's scoped `PATH`."
  def prepend_path(dir) when is_binary(dir) do
    put_env("PATH", Enum.join([dir | List.wrap(Shuttle.Env.get("PATH"))], ":"))
  end

  @doc """
  Start `child_spec` under the test supervisor and make the started process
  this test's instance of `module` (default: the spec's module), read back with
  `server!/1`. Per-test replacement for a globally named test double.
  """
  def start_scoped!(child_spec, module \\ nil) do
    pid = ExUnit.Callbacks.start_supervised!(child_spec)
    module = module || spec_module(child_spec)
    put_app_env(module, pid)
    pid
  end

  @doc "The calling test's instance of `module`, as registered by `start_scoped!/2`."
  def server!(module) do
    case Shuttle.Env.app(module) do
      pid when is_pid(pid) ->
        pid

      _ ->
        raise "no #{inspect(module)} in this test's scope (start it with " <>
                "Shuttle.Test.Env.start_scoped!/1, from the test process)"
    end
  end

  defp spec_module({module, _arg}) when is_atom(module), do: module
  defp spec_module(module) when is_atom(module), do: module
  defp spec_module(%{start: {module, _, _}}), do: module

  defp put(kind, key, override) do
    unless Shuttle.Env.scoped?() do
      raise "Shuttle.Env was compiled without `config :shuttle, scoped_env: true`"
    end

    owner = self()
    ensure_owner(owner)
    :ets.insert(@table, {{owner, kind, key}, override})
    :ok
  end

  defp ensure_owner(owner) do
    if :ets.insert_new(@table, {{:owner, owner}, true}) do
      ExUnit.Callbacks.on_exit({__MODULE__, owner}, fn -> clear(owner) end)
    end
  end

  @doc false
  def clear(owner) do
    :ets.match_delete(@table, {{owner, :_, :_}, :_})
    :ets.delete(@table, {:owner, owner})
    :ok
  end
end
