defmodule ShuttleWeb.RequestDeadlineFIFOTest do
  # File.read/1 uses the VM's shared file server. Keep the deliberate FIFO
  # stall out of the async suite so it cannot hold other tests' filesystem IO.
  use ExUnit.Case

  alias ShuttleWeb.RequestDeadline

  defmodule FIFOHandler do
    def init(opts), do: opts

    def call(conn, opts) do
      send(opts[:observer], {:request_owner, self()})

      if opts[:raw] do
        {:ok, fd} = :file.open(String.to_charlist(opts[:fifo]), [:read, :raw, :binary])
        :file.read(fd, 1)
        :file.close(fd)
      else
        File.read!(opts[:fifo])
      end

      Plug.Conn.send_resp(conn, 200, "ok")
    end
  end

  @tag :tmp_dir
  test "expiry closes inbound sockets while File.read or a raw dirty IO NIF is blocked", %{
    tmp_dir: dir
  } do
    for raw <- [false, true] do
      fifo = Path.join(dir, "fifo-#{raw}")
      {_, 0} = System.cmd("mkfifo", [fifo])

      # Start the external writer before blocking the VM's file server. Its
      # nonblocking open also exits safely if the reader never reached open.
      writer =
        Port.open({:spawn_executable, System.find_executable("perl")}, [
          :exit_status,
          args: [
            "-MFcntl=O_WRONLY,O_NONBLOCK",
            "-e",
            "select(undef, undef, undef, 2); sysopen(my $fh, $ARGV[0], O_WRONLY|O_NONBLOCK) or exit 0; print $fh 'x'; close($fh);",
            fifo
          ]
        ])

      opts = [observer: self(), fifo: fifo, raw: raw]
      id = make_ref()

      guard =
        start_supervised!(
          Supervisor.child_spec(
            {RequestDeadline, name: nil, plug: {FIFOHandler, opts}, budget: fn _, _ -> 500 end},
            id: {:guard, id}
          )
        )

      server =
        start_supervised!(
          Supervisor.child_spec(
            {Bandit, plug: {FIFOHandler, opts}, ip: {127, 0, 0, 1}, port: 0, startup_log: false},
            id: {:server, id}
          )
        )

      {:ok, {_, port}} = ThousandIsland.listener_info(server)
      {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 1_000)
      :ok = :gen_tcp.send(socket, "GET /fifo HTTP/1.1\r\nHost: localhost\r\n\r\n")
      assert_receive {:request_owner, owner}, 1_000
      monitor = Process.monitor(owner)
      Process.sleep(50)

      # Probe only before expiry: querying a stuck dirty-NIF owner after a
      # kill must never be part of the deadline's cleanup path.
      if raw do
        assert {:current_function, {:prim_file, :open_nif, 2}} =
                 Process.info(owner, :current_function)
      else
        assert {:current_function, {:gen, :do_call, 4}} = Process.info(owner, :current_function)
        IO.inspect(Process.info(owner, :current_stacktrace), label: "FIFO HTTP owner stack")

        IO.inspect(Process.info(Process.whereis(:file_server_2), :current_stacktrace),
          label: "FIFO shared file server stack"
        )
      end

      ports =
        Enum.filter(:erlang.ports(), fn port ->
          :erlang.port_info(port, :connected) == {:connected, owner}
        end)

      assert [_ | _] = ports
      assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
      assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}, 1_000
      assert Enum.all?(ports, &(:erlang.port_info(&1) == :undefined))
      assert %{spans: %{}, monitors: %{}} = :sys.get_state(guard)

      unless raw do
        assert {:current_function, {:prim_file, :read_file_nif, 1}} =
                 Process.info(Process.whereis(:file_server_2), :current_function)
      end

      refute_receive {^writer, {:exit_status, _}}, 0
      assert_receive {^writer, {:exit_status, 0}}, 3_000
      stop_supervised!({:server, id})
      stop_supervised!({:guard, id})
      File.rm!(fifo)
    end
  end
end
