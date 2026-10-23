defmodule Shuttle.CodexEndpointTest do
  use ExUnit.Case, async: true
  import Bitwise
  alias Shuttle.CodexEndpoint
  alias Shuttle.Test.Env

  test "Go and Elixir agree on host-local endpoints across Linux, macOS and network homes" do
    fixtures =
      File.read!(Path.expand("../fixtures/codex_endpoints.json", __DIR__)) |> Jason.decode!()

    for fixture <- fixtures do
      for {key, value} <- fixture["env"] || %{}, do: Env.put_env(key, value)
      actual = CodexEndpoint.resolve(fixture["override"], fixture["uid"], fixture["hostname"])

      if fixture["error"],
        do: assert(match?({:error, _}, actual), fixture["name"]),
        else: assert(actual == {:ok, fixture["want"]}, fixture["name"])
    end
  end

  test "the default hostname producer is the raw OS API, and current preserves a kernel FQDN" do
    # Negative control: selecting :inet.gethostname/0 instead makes the
    # producer assertion fail even on a developer host with a short hostname.
    source = CodexEndpoint.hostname_source()
    assert {:module, :net} = Function.info(source, :module)
    assert {:name, :gethostname} = Function.info(source, :name)
    assert {:arity, 0} = Function.info(source, :arity)
    Env.put_env("SHUTTLE_CODEX_SOCKET", "")

    assert CodexEndpoint.current(fn -> {:ok, ~c"node-b.example"} end) ==
             CodexEndpoint.resolve("", Shuttle.Host.euid(), "node-b.example")

    refute CodexEndpoint.current(fn -> {:ok, ~c"node-b.example"} end) ==
             CodexEndpoint.resolve("", Shuttle.Host.euid(), "node-b")
  end

  setup do
    root = "/tmp/shuttle-endpoint-test-#{System.unique_integer([:positive])}"
    on_exit(fn -> File.rm_rf!(root) end)
    %{root: root, endpoint: Path.join(root, "control.sock")}
  end

  # Negative control: accepting mode 0777 or using stat instead of lstat makes
  # these refusals red. Never chmod an insecure precreated root into acceptance.
  test "private root creation and adoption; hostile type, mode, owner and symlinks fail closed",
       %{root: root, endpoint: endpoint} do
    assert :ok = CodexEndpoint.ensure_root(endpoint)
    assert {:ok, %{type: :directory, mode: mode}} = File.lstat(root)
    assert (mode &&& 0o777) == 0o700
    assert :ok = CodexEndpoint.ensure_root(endpoint)
    File.chmod!(root, 0o777)
    assert {:error, _} = CodexEndpoint.ensure_root(endpoint)
    assert {:ok, %{mode: mode}} = File.lstat(root)
    assert (mode &&& 0o777) == 0o777
    File.rmdir!(root)
    File.write!(root, "not a directory")
    assert {:error, _} = CodexEndpoint.ensure_root(endpoint)
    File.rm!(root)
    File.ln_s!("/tmp", root)
    assert {:error, _} = CodexEndpoint.ensure_root(endpoint)
    File.rm!(root)
    assert :ok = CodexEndpoint.ensure_root(endpoint)
    assert {:error, _} = CodexEndpoint.ensure_root(endpoint, Shuttle.Host.euid() + 1)
    File.ln_s!("/tmp/somewhere-else.sock", endpoint)
    assert {:error, _} = CodexEndpoint.verify_socket(endpoint)
  end

  test "override ancestors cannot hide a symlink into a private root", %{root: root} do
    File.mkdir!(root)
    File.chmod!(root, 0o700)
    real = Path.join(root, "real")
    File.mkdir!(real)
    File.ln_s!(real, Path.join(root, "alias"))

    assert {:error, _} =
             CodexEndpoint.ensure_root(Path.join([root, "alias", "private", "control.sock"]))

    refute File.exists?(Path.join(real, "private"))
  end
end
