defmodule Shuttle.Test.ThreadsCase do
  @moduledoc """
  The case template for the thread suites (`test/shuttle/threads_*_test.exs`):
  each test gets a store under its tmp dir holding the hub and its child
  thread, made by the real CLIs, and a data dir and home of its own.
  """

  use ExUnit.CaseTemplate

  import ExUnit.Assertions
  import ExUnit.Callbacks
  alias Shuttle.{CLI, FiberDocuments, Threads, Test.Env}

  using do
    quote do
      import Shuttle.Test.ApiConn
      import Phoenix.ConnTest
      alias Shuttle.{CLI, FiberDocuments, Threads, Test.Env}
      @moduletag :tmp_dir
      @endpoint ShuttleWeb.Endpoint
      alias Shuttle.Test.ThreadsCase.ScopedAPI
      alias Shuttle.Test.ThreadsCase.SocketRunner
      alias Shuttle.Test.ThreadsCase.FailingMailboxRunner
      alias Shuttle.Test.ThreadsCase.NoFiberReadsRunner
      import Shuttle.Test.ThreadsCase
    end
  end

  defmodule ScopedAPI do
    @behaviour Plug
    def init(owner), do: owner

    def call(conn, owner) do
      Shuttle.Env.adopt_callers([owner])
      ShuttleWeb.Endpoint.call(conn, ShuttleWeb.Endpoint.init([]))
    end
  end

  defmodule SocketRunner do
    @behaviour Shuttle.Runner
    def cmd("bash", ["-l" | args], opts),
      do: Shuttle.Runner.Default.cmd("bash", ["--noprofile", "--norc" | args], opts)

    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  defmodule FailingMailboxRunner do
    def cmd("shuttle", ["context-mailbox", "put" | _], _opts), do: {"mailbox unavailable", 1}
    def cmd(command, args, opts), do: Shuttle.Runner.Default.cmd(command, args, opts)
  end

  defmodule NoFiberReadsRunner do
    def cmd(command, args, _opts) do
      send(Process.get(:fiber_read_test_pid), {:fiber_read, command, args})
      {"unexpected fiber read", 1}
    end
  end

  setup %{tmp_dir: dir} = context do
    home = Path.join(dir, "home")
    data = Path.join(dir, "data")
    File.mkdir_p!(home)
    File.mkdir_p!(data)
    Env.delete_env("TMUX")
    Env.delete_env("SHUTTLE_FIBER_PATH")
    Env.put_env("HOME", home)
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.delete_env("SHUTTLE_LISTEN")
    Env.delete_env("SHUTTLE_PORT")
    claim_test_daemon_owner!(home)
    Env.put_env("SHUTTLE_HOST", "test-host")
    Env.put_env("SHUTTLE_STORES", dir)
    unless context[:first_boot], do: Shuttle.ThreadOutbox.boot_baseline()
    Env.put_app_env(:felt_runner, Shuttle.Runner.Default)
    assert {:ok, _} = CLI.run_felt(["-C", dir, "init"])
    assert {:ok, _} = CLI.run_felt(["-C", dir, "add", "hub", "Hub"])

    assert {:ok, _} =
             CLI.run_in_store(dir, [
               "install",
               "hub",
               "--disabled",
               "--host",
               "test-host",
               "--project-dir",
               dir
             ])

    assert {:ok, _} =
             CLI.run_in_store(dir, [
               "thread",
               "hub",
               "Investigate",
               "--slug",
               "child",
               "--disabled"
             ])

    {:ok, store: dir, data: data}
  end

  def claim_test_daemon_owner!(home) do
    {hostname, 0} = System.cmd("hostname", [])

    hostname =
      hostname |> String.trim() |> String.downcase() |> String.split(".", parts: 2) |> hd()

    listen_network = "tcp"
    listen_address = "127.0.0.1:4000"

    key =
      :crypto.hash(:sha256, hostname <> <<0>> <> listen_network <> <<0>> <> listen_address)
      |> Base.encode16(case: :lower)

    path = Path.join([home, ".shuttle", "daemon-owners", key <> ".json"])
    File.mkdir_p!(Path.dirname(path))
    pid = System.pid()

    File.write!(path, Jason.encode!(%{pid: String.to_integer(pid), birth: process_birth!(pid)}))
  end

  def process_birth!(pid) do
    case File.read("/proc/#{pid}/stat") do
      {:ok, stat} ->
        fields = stat |> String.split(")") |> List.last() |> String.split()
        {:ok, boot} = File.read("/proc/sys/kernel/random/boot_id")
        String.trim(boot) <> ":ticks:" <> Enum.at(fields, 19)

      {:error, _} ->
        {birth, 0} =
          System.cmd("ps", ["-p", pid, "-o", "lstart="], env: [{"LC_ALL", "C"}, {"TZ", "UTC"}])

        String.trim(birth)
    end
  end

  # Record who asked for hub/child: `fiber` is the constitution the asking
  # session worked, the hub's own uid when `:hub`.
  def asked_by(store, session, fiber) do
    path = Path.join(store, ".felt/hub/child/child.md")
    text = File.read!(path)
    [_, hub_uid] = Regex.run(~r/thread_parent:\n\s+uid: (\S+)/, text)
    fiber = if fiber == :hub, do: hub_uid, else: fiber

    asker =
      "        asked_by:\n            session: #{session}\n" <>
        if(fiber, do: "            fiber: #{fiber}\n", else: "")

    File.write!(path, String.replace(text, "        name: Hub\n", "        name: Hub\n" <> asker))
  end

  def native_receiver(listener, transcript, ready, test_pid) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        case :gen_tcp.recv(socket, 0, 10_000) do
          {:error, :closed} ->
            :ok

          {:ok, line} ->
            frame = Jason.decode!(line)
            session = ready |> File.read!() |> String.trim()
            uuid = frame["uuid"]

            rows = [
              %{type: "user", sessionId: session, uuid: uuid},
              %{
                type: "assistant",
                sessionId: session,
                uuid: "reply-" <> uuid,
                parentUuid: uuid,
                message: %{role: "assistant", model: "claude-test"}
              }
            ]

            File.write!(transcript, Enum.map(rows, &(Jason.encode!(&1) <> "\n")), [:append])
            send(test_pid, {:wake, frame["message"]["content"]})
        end

        :gen_tcp.close(socket)
        native_receiver(listener, transcript, ready, test_pid)

      {:error, :closed} ->
        :ok
    end
  end

  def await(fun), do: await(fun, System.monotonic_time(:millisecond) + 20_000)

  def await(fun, deadline) do
    unless fun.() do
      assert System.monotonic_time(:millisecond) < deadline,
             "timed out waiting for process evidence"

      Process.sleep(10)
      await(fun, deadline)
    end
  end

  def pending(data) do
    Path.wildcard(Path.join(data, "mailboxes/fiber/*/pending/*.json"))
    |> Enum.map(&(&1 |> File.read!() |> Jason.decode!()))
    |> Enum.sort_by(& &1["request"]["message_id"])
  end
end
