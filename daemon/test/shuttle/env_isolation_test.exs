defmodule Shuttle.EnvIsolationTest.Probe do
  @moduledoc false
  # A GenServer that reads through the seam from its own process.
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, nil)
  def read(pid, fun), do: GenServer.call(pid, {:read, fun})

  @impl true
  def init(nil), do: {:ok, nil}

  @impl true
  def handle_call({:read, fun}, _from, state), do: {:reply, fun.(), state}
  # A Task the GenServer starts: two hops from the scope (`$callers` → `$ancestors`).
  def handle_call({:task_read, fun}, _from, state),
    do: {:reply, Task.async(fun) |> Task.await(), state}
end

defmodule Shuttle.EnvIsolationTest do
  use ExUnit.Case, async: true

  alias Shuttle.EnvIsolationTest.Probe
  alias Shuttle.Test.{Env, FakeCli}

  @key "SHUTTLE_ENV_ISOLATION_PROBE"

  # Two scopes, owned by two processes this test starts, set different values
  # for the same keys and hold them at once; each must observe only its own,
  # from every process that acts for it, while the global values stay untouched.
  test "concurrent scopes see only their own overrides" do
    test = self()
    scopes = for label <- ~w(a b), do: Task.async(fn -> scope(label, test) end)
    Enum.each(scopes, &Env.adopt_scope!(&1.pid))
    Enum.each(scopes, &send(&1.pid, :set))

    # Both scopes hold their overrides before either reads, so a leak in
    # either direction would be observed.
    for label <- ~w(a b), do: assert_receive({:set, ^label})
    Enum.each(scopes, &send(&1.pid, :read))

    assert [%{data_dir: a}, %{data_dir: b}] = Task.await_many(scopes, 30_000)
    refute a == b
  end

  defp scope(label, test) do
    data_dir = Path.join(System.tmp_dir!(), "env-isolation-#{label}")
    receive do: (:set -> :ok)

    Env.put_env(@key, label)
    Env.put_env("SHUTTLE_STORES", "/stores/#{label}")
    Env.put_env("SHUTTLE_DATA_DIR", data_dir)
    Env.put_app_env(:env_isolation_probe, label)
    Env.delete_env("HOME")

    FakeCli.install!(%{
      "felt" => "#!/bin/sh\nprintf '%s:%s' \"$SHUTTLE_ENV_ISOLATION_PROBE\" \"$SHUTTLE_STORES\"\n"
    })

    send(test, {:set, label})
    receive do: (:read -> :ok)

    read = fn -> {Shuttle.Env.get(@key), Shuttle.Env.app(:env_isolation_probe)} end
    expected = {label, label}

    assert read.() == expected
    assert Task.async(read) |> Task.await() == expected

    {:ok, probe} = Probe.start_link(nil)
    assert Probe.read(probe, read) == expected
    assert GenServer.call(probe, {:task_read, read}) == expected
    assert GenServer.call(probe, {:task_read, &Shuttle.data_dir/0}) == data_dir

    assert Shuttle.Env.get("HOME") == nil
    assert Shuttle.Env.get("HOME", "fallback") == "fallback"

    # The fake on this scope's PATH, spawned through the real runner, sees
    # this scope's env — from the scope and from a process it started.
    run_felt = fn -> Shuttle.Runner.Default.cmd("felt", [], []) end
    assert run_felt.() == {"#{label}:/stores/#{label}", 0}
    assert Probe.read(probe, run_felt) == {"#{label}:/stores/#{label}", 0}

    # A caller's explicit env: entry wins over the scope.
    assert {"explicit:/stores/" <> ^label, 0} =
             Shuttle.Runner.Default.cmd("felt", [], env: [{@key, "explicit"}])

    # Nothing reached the global environment.
    assert System.get_env(@key) == nil
    assert Application.get_env(:shuttle, :env_isolation_probe) == nil
    assert System.get_env("HOME") != nil
    refute System.get_env("PATH") =~ "shuttle-fake-cli"

    # A process outside every scope reads the global values.
    parent = self()
    spawn(fn -> send(parent, {:outside, read.()}) end)
    assert_receive {:outside, {nil, nil}}

    GenServer.stop(probe)
    %{data_dir: data_dir}
  end
end

defmodule Shuttle.EnvOwnerByPidTest do
  use ExUnit.Case, async: true

  # A child records its parent's registered name in `$ancestors`; once the
  # child has resolved its owner, a later holder of that name changes nothing.
  test "an owner reached through a registered name stays that pid" do
    name = :"shuttle_env_owner_probe_#{System.unique_integer([:positive])}"
    Process.register(self(), name)
    Shuttle.Test.Env.put_env("SHUTTLE_ENV_OWNER_PROBE", "mine")
    parent = self()

    child =
      :proc_lib.spawn(fn ->
        loop = fn loop ->
          receive do
            :read ->
              send(parent, {:read, Shuttle.Env.get("SHUTTLE_ENV_OWNER_PROBE")})
              loop.(loop)
          end
        end

        loop.(loop)
      end)

    send(child, :read)
    assert_receive {:read, "mine"}

    Process.unregister(name)
    impostor = spawn(fn -> Process.sleep(:infinity) end)
    Process.register(impostor, name)

    send(child, :read)
    assert_receive {:read, "mine"}

    Process.exit(child, :kill)
    Process.exit(impostor, :kill)
  end
end

defmodule Shuttle.EnvScopeHygieneTest do
  use ExUnit.Case, async: true

  test "a write from outside a test process raises and registers no owner" do
    parent = self()

    spawn(fn ->
      result =
        try do
          Shuttle.Test.Env.put_env("SHUTTLE_ENV_HYGIENE_PROBE", "x")
        rescue
          e -> {:raised, e}
        end

      send(parent, {:done, self(), result})
    end)

    assert_receive {:done, pid, {:raised, _}}
    refute :ets.member(Shuttle.Env.table(), {:owner, pid})
  end

  test "clearing a scope erases its persistent_term slots" do
    Shuttle.Test.Env.own_scope!()
    key = Shuttle.Env.scope_key({__MODULE__, :slot})
    assert key == {{__MODULE__, :slot}, self()}
    :persistent_term.put(key, :value)

    Shuttle.Test.Env.clear(self())
    assert :persistent_term.get(key, :gone) == :gone
  end
end
