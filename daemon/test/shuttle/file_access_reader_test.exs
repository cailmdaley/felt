defmodule Shuttle.FileAccess.ReaderTest do
  use ExUnit.Case, async: true
  alias Shuttle.FileAccess, as: Access
  alias Shuttle.FileAccess.Reader
  alias Shuttle.FileAccess.Error
  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    service =
      start_supervised!({Access, name: nil, capacity: 2, timeout: 60, protected_roots: [dir]})

    path = Path.join(dir, "file")
    File.write!(path, :binary.copy("01234567", 20_000))
    %{service: service, path: path, opts: [service: service]}
  end

  test "one raw descriptor serves bounded offset reads until close", ctx do
    {:ok, reader} = Reader.open(ctx.path, ctx.opts)
    assert Access.status(ctx.service).active == 1
    assert {:ok, "34567"} = Reader.read(reader, 3, 5)
    assert {:ok, bytes} = Reader.read(reader, 0, 1_000_000)
    assert byte_size(bytes) == Reader.chunk_size()
    # Idle network backpressure does not expire the initial open deadline.
    Process.sleep(80)
    assert Access.status(ctx.service).active == 1
    assert {:ok, "01"} = Reader.read(reader, 8, 2)
    assert :ok == Reader.close(reader)
    eventually(fn -> Access.status(ctx.service).active == 0 end)
  end

  # Red control: kill/release the worker on a read deadline, or remove the
  # Reader.read after clause. A raw FIFO open parks the leased native callback.
  test "a read timeout holds its native lease and cache until actual completion", ctx do
    fifo = fifo!(Path.join(ctx.tmp_dir, "fifo"))

    read_fn = fn fd, offset, length ->
      {:ok, parked} = :file.open(String.to_charlist(fifo), [:read, :binary, :raw])
      :ok = :file.close(parked)
      :file.pread(fd, offset, length)
    end

    {:ok, reader} = Reader.open(ctx.path, ctx.opts ++ [read_fn: read_fn])
    error = assert_raise Error, fn -> Reader.read(reader, 0, 8) end
    assert error.reason == :timeout
    assert Process.alive?(reader.worker)
    assert %{active: 1, blocked_prefixes: [%{cause: :timeout}]} = Access.status(ctx.service)
    assert_raise Error, fn -> Access.read(ctx.path, ctx.opts) end
    unblock_fifo(fifo)

    eventually(fn ->
      Map.take(Access.status(ctx.service), [:active, :capacity, :blocked_prefixes]) == %{
        active: 0,
        capacity: 2,
        blocked_prefixes: []
      }
    end)

    refute_receive {_request, {:ok, _bytes}}, 20
  end

  test "two abandoned native opens remain occupied until external unblock", ctx do
    fifo = fifo!(Path.join(ctx.tmp_dir, "fifo"))
    opts = [service: ctx.service, timeout: 60]

    tasks =
      for _ <- 1..2,
          do: Task.async(fn -> assert_raise Error, fn -> Reader.open(fifo, opts) end end)

    Enum.each(tasks, fn task -> assert Task.await(task).reason == :timeout end)
    assert Access.status(ctx.service).active == 2
    unblock_fifo(fifo)
    eventually(fn -> Access.status(ctx.service).active == 0 end)
  end

  test "owner death closes an idle descriptor", ctx do
    parent = self()

    owner =
      spawn(fn ->
        {:ok, reader} = Reader.open(ctx.path, ctx.opts)
        send(parent, {:reader, reader})

        receive do
          :stop -> :ok
        end
      end)

    assert_receive {:reader, reader}
    assert Process.alive?(reader.worker)
    Process.exit(owner, :kill)
    eventually(fn -> Access.status(ctx.service).active == 0 end)
  end

  defp fifo!(path) do
    {_, 0} = System.cmd("mkfifo", [path])
    on_exit(fn -> unblock_fifo(path) end)
    path
  end

  defp unblock_fifo(path) do
    {_, 0} = System.cmd("/bin/sh", ["-c", "exec 3<> \"$1\"; printf granted >&3", "writer", path])
  end

  defp eventually(fun, tries \\ 100)
  defp eventually(fun, 0), do: assert(fun.())

  defp eventually(fun, tries) do
    if fun.(),
      do: :ok,
      else:
        (
          Process.sleep(10)
          eventually(fun, tries - 1)
        )
  end
end
