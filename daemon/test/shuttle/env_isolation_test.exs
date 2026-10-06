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
  # A Task the GenServer starts: two hops from the test (`$callers` → `$ancestors`).
  def handle_call({:task_read, fun}, _from, state),
    do: {:reply, Task.async(fun) |> Task.await(), state}
end

defmodule Shuttle.EnvIsolationTest.Shared do
  @moduledoc false
  # Two async modules run the same body concurrently with different values for
  # the same keys; each must observe only its own, from every process that acts
  # for it, while the global values stay untouched.
  import ExUnit.Assertions

  alias Shuttle.EnvIsolationTest.Probe
  alias Shuttle.Test.{Env, FakeCli}

  @key "SHUTTLE_ENV_ISOLATION_PROBE"

  # How long one module waits for the other at each rendezvous. The two are
  # scheduled independently among every async module in the suite, so on a
  # loaded machine the peer can start long after this one; the bound is
  # failure-only, and the modules' test timeout sits above two of them.
  @rendezvous_ms 100_000
  def rendezvous_ms, do: @rendezvous_ms

  def run(label) do
    other = if label == "a", do: "b", else: "a"
    rendezvous = :"shuttle_env_isolation_#{label}"
    Process.register(self(), rendezvous)

    Env.put_env(@key, label)
    Env.put_env("SHUTTLE_STORES", "/stores/#{label}")
    Env.put_app_env(:env_isolation_probe, label)
    Env.delete_env("HOME")

    FakeCli.install!(%{
      "felt" => "#!/bin/sh\nprintf '%s:%s' \"$SHUTTLE_ENV_ISOLATION_PROBE\" \"$SHUTTLE_STORES\"\n"
    })

    # Both modules hold their overrides at once before anyone reads, so a
    # leak in either direction would be observed.
    wait_for_peer(other)

    read = fn -> {Shuttle.Env.get(@key), Shuttle.Env.app(:env_isolation_probe)} end
    expected = {label, label}

    assert read.() == expected
    assert Task.async(read) |> Task.await() == expected

    probe = ExUnit.Callbacks.start_supervised!(Probe)
    assert Probe.read(probe, read) == expected
    assert GenServer.call(probe, {:task_read, read}) == expected

    assert Shuttle.Env.get("HOME") == nil
    assert Shuttle.Env.get("HOME", "fallback") == "fallback"

    # The fake on this test's scoped PATH, spawned through the real runner,
    # sees this test's env — from the test and from a supervised process.
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

    send_peer_done(other)
    assert_receive {:peer_done, ^other}, @rendezvous_ms
  end

  defp wait_for_peer(other) do
    send_when_registered(:"shuttle_env_isolation_#{other}", {:peer_ready, self()})
    assert_receive {:peer_ready, _}, @rendezvous_ms
  end

  defp send_peer_done(other) do
    label = if other == "a", do: "b", else: "a"
    send_when_registered(:"shuttle_env_isolation_#{other}", {:peer_done, label})
  end

  defp send_when_registered(name, msg) do
    deadline = System.monotonic_time(:millisecond) + @rendezvous_ms
    send_when_registered(name, msg, deadline)
  end

  defp send_when_registered(name, msg, deadline) do
    case Process.whereis(name) do
      pid when is_pid(pid) ->
        send(pid, msg)

      nil ->
        if System.monotonic_time(:millisecond) > deadline,
          do: flunk("#{inspect(name)} never registered")

        Process.sleep(10)
        send_when_registered(name, msg, deadline)
    end
  end
end

defmodule Shuttle.EnvIsolationATest do
  use ExUnit.Case, async: true

  @moduletag timeout: 3 * Shuttle.EnvIsolationTest.Shared.rendezvous_ms()

  test "scope a sees only its own overrides" do
    Shuttle.EnvIsolationTest.Shared.run("a")
  end
end

defmodule Shuttle.EnvIsolationBTest do
  use ExUnit.Case, async: true

  @moduletag timeout: 3 * Shuttle.EnvIsolationTest.Shared.rendezvous_ms()

  test "scope b sees only its own overrides" do
    Shuttle.EnvIsolationTest.Shared.run("b")
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
