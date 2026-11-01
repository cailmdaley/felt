defmodule Shuttle.FileAccessTest do
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  alias Shuttle.FileAccess, as: Access
  alias Shuttle.FileAccess.Error

  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    root = Path.join(dir, "Documents")
    File.mkdir_p!(root)

    service =
      start_supervised!({Access, name: nil, capacity: 2, timeout: 60, protected_roots: [root]})

    %{service: service, opts: [service: service], root: root}
  end

  test "raw wrappers preserve File results, options, symlinks and nested calls", ctx do
    path = Path.join(ctx.root, "file")
    File.write!(path, "hello")
    link = Path.join(ctx.root, "link")
    File.ln_s!("file", link)

    for time <- [:local, :universal, :posix] do
      assert Access.stat(link, ctx.opts ++ [time: time]) == File.stat(link, time: time)
      assert Access.lstat(link, ctx.opts ++ [time: time]) == File.lstat(link, time: time)
    end

    assert Access.read(link, ctx.opts) == {:ok, "hello"}
    assert Access.read!(path, ctx.opts) == "hello"
    assert Access.read_link(link, ctx.opts) == {:ok, "file"}
    assert Access.exists?(link, ctx.opts)
    refute Access.exists?(path <> ".missing", ctx.opts)
    assert Access.ls(ctx.root, ctx.opts) == File.ls(ctx.root)
    assert Access.dir?(ctx.root, ctx.opts)
    assert Access.regular?(link, ctx.opts)
    refute Access.regular?(ctx.root, ctx.opts)
    assert Access.read(path <> ".missing", ctx.opts) == {:error, :enoent}
    assert_raise File.Error, fn -> Access.read!(path <> ".missing", ctx.opts) end
    assert Access.task(path, fn -> Access.read!(link, ctx.opts) end, ctx.opts) == "hello"
    assert Access.find_executable("/bin/sh", ctx.opts) == "/bin/sh"
  end

  test "binary streams preserve lines and byte units, and close on early termination", ctx do
    path = Path.join(ctx.root, "lines")
    body = "first\r\nsecond\n" <> :binary.copy("x", 150_000) <> "\nlast"
    File.write!(path, body)

    assert Enum.to_list(Access.stream!(path, [], :line, ctx.opts)) ==
             Enum.to_list(File.stream!(path))

    assert Enum.to_list(Access.stream!(path, [:read_ahead], 100_000, ctx.opts)) ==
             Enum.to_list(File.stream!(path, [], 100_000))

    assert Access.stream!(path, [], :line, ctx.opts) |> Enum.take(1) == ["first\n"]
    eventually(fn -> Access.status(ctx.service).active == 0 end)

    assert_raise File.Error, fn ->
      Access.stream!(path <> ".missing", [], :line, ctx.opts) |> Enum.to_list()
    end
  end

  test "wildcards preserve Path results and dot matching through raw discovery", ctx do
    File.mkdir_p!(Path.join(ctx.root, "nested"))

    for name <- ["a.json", "b.txt", ".hidden.json", "nested/c.json"] do
      File.write!(Path.join(ctx.root, name), name)
    end

    for pattern <- ["*", "**/*.json", "{a,b}.*", ".*"], match_dot <- [false, true] do
      glob = Path.join(ctx.root, pattern)

      assert Access.wildcard(glob, ctx.opts ++ [match_dot: match_dot]) ==
               Path.wildcard(glob, match_dot: match_dot)
    end

    assert :sys.get_state(Access.journal(ctx.service)).aliases == %{}

    error =
      transient(fn ->
        Access.task(
          ctx.root,
          fn ->
            Access.run(ctx.root, fn _ -> {:error, :eacces} end)
          end,
          ctx.opts
        )
      end)

    assert error.reason == :blocked
    assert transient(fn -> Access.wildcard(ctx.root <> "/*", ctx.opts) end).reason == :blocked
  end

  test "executable lookup continues past blocked PATH entries but never reports a transient as missing",
       ctx do
    healthy = Path.join(ctx.tmp_dir, "bin")
    File.mkdir_p!(healthy)
    program = "healthy-tool"
    binary = Path.join(healthy, program)
    File.write!(binary, "#!/bin/sh\nexit 0\n")
    File.chmod!(binary, 0o755)

    assert transient(fn -> Access.task(ctx.root, fn -> {:error, :eacces} end, ctx.opts) end).reason ==
             :blocked

    opts = ctx.opts ++ [search_path: ctx.root <> ":" <> healthy]
    assert Access.find_executable(program, opts) == binary
    assert transient(fn -> Access.find_executable("missing-tool", opts) end).reason == :blocked

    assert transient(fn -> Access.find_executable(Path.join(ctx.root, program), opts) end).reason ==
             :blocked

    assert :ok == Access.reset(:all, ctx.service)
    assert Access.find_executable("missing-tool", opts) == nil
  end

  test "resolves dot-dot after directory symlinks and limits cycles", ctx do
    elsewhere = Path.join(ctx.tmp_dir, "elsewhere")
    File.mkdir_p!(Path.join(elsewhere, "nested"))
    File.write!(Path.join(elsewhere, "value"), "physical")
    File.write!(Path.join(ctx.root, "value"), "lexical")
    link = Path.join(ctx.root, "alias")
    File.ln_s!(Path.join(elsewhere, "nested"), link)
    assert Access.read(link <> "/../value", ctx.opts) == {:ok, "physical"}
    cycle = Path.join(ctx.root, "cycle")
    File.ln_s!("cycle", cycle)
    assert Access.read(cycle, ctx.opts) == {:error, :eloop}
  end

  # Red control: replace max_children with an unbounded Task.Supervisor, or
  # kill workers on :expire. The busy/occupancy assertions must fail.
  test "two native FIFO opens retain capacity after timeout, then recover after external unblock",
       ctx do
    paths = for n <- 1..2, do: fifo!(Path.join(ctx.tmp_dir, "fifo#{n}"))
    before_ports = length(Port.list())

    callers =
      Enum.map(paths, fn path ->
        Task.async(fn -> transient(fn -> Access.read(path, ctx.opts) end) end)
      end)

    Enum.each(callers, fn caller -> assert Task.await(caller).reason == :timeout end)
    assert %{active: 2, capacity: 2} = Access.status(ctx.service)
    workers = worker_pids(ctx.service)
    assert length(workers) == 2
    assert Enum.all?(workers, &Process.alive?/1)

    for _ <- 1..50 do
      error = transient(fn -> Access.read(hd(paths), ctx.opts) end)
      assert error.reason == :busy
      assert Plug.Exception.status(error) == 503
    end

    assert worker_pids(ctx.service) == workers
    assert length(Port.list()) <= before_ports + 2
    Enum.each(paths, &unblock_fifo/1)
    eventually(fn -> Access.status(ctx.service).active == 0 end)
    path = Path.join(ctx.tmp_dir, "healthy")
    File.write!(path, "recovered")
    assert Access.read(path, ctx.opts) == {:ok, "recovered"}
    refute_receive {_ref, {:result, _}}, 30
  end

  # Red control: remove block/3 from :expire, or ignore aliases in admission.
  test "a symlink into a protected folder blocks subsequent polls once, and late success clears it",
       ctx do
    path = fifo!(Path.join(ctx.root, "consent"))
    alias_path = Path.join(ctx.tmp_dir, ".felt")
    File.ln_s!(ctx.root, alias_path)
    logical = Path.join(alias_path, "consent")

    log =
      capture_log(fn ->
        assert transient(fn -> Access.read(logical, ctx.opts) end).reason == :timeout

        assert %{active: 1, blocked_prefixes: [%{prefix: root, cause: :timeout}]} =
                 Access.status(ctx.service)

        assert root == ctx.root

        for _ <- 1..20 do
          assert transient(fn -> Access.stat(Path.join(alias_path, "another"), ctx.opts) end).reason ==
                   :blocked

          assert transient(fn -> Access.read(path, ctx.opts) end).reason == :blocked
        end

        assert Access.status(ctx.service).active == 1
      end)

    assert length(Regex.scan(~r/Filesystem access blocked/, log)) == 1
    assert log =~ ctx.root
    assert log =~ "Files & Folders"
    assert log =~ "Full Disk Access"
    unblock_fifo(path)

    eventually(fn ->
      Map.take(Access.status(ctx.service), [:active, :capacity, :blocked_prefixes]) == %{
        active: 0,
        capacity: 2,
        blocked_prefixes: []
      }
    end)

    refute_receive {_ref, {:result, _}}, 30
  end

  test "permission failures are typed, cached indefinitely, and explicitly resettable", ctx do
    for reason <- [:eacces, :eperm] do
      error = transient(fn -> Access.task(ctx.root, fn -> {:error, reason} end, ctx.opts) end)
      assert error.reason == :blocked
      assert error.cause == reason
      assert Plug.Exception.status(error) == 503
      Process.sleep(80)
      assert transient(fn -> Access.regular?(ctx.root, ctx.opts) end).reason == :blocked
      assert :ok == Access.reset(ctx.root, ctx.service)
      assert Access.dir?(ctx.root, ctx.opts)
    end
  end

  test "caller death and coordinator restart cannot replenish occupied capacity", ctx do
    path = fifo!(Path.join(ctx.tmp_dir, "abandoned"))
    caller = spawn(fn -> Access.read(path, ctx.opts ++ [timeout: 5_000]) end)
    eventually(fn -> Access.status(ctx.service).active == 1 end)
    eventually(fn -> Enum.any?(worker_pids(ctx.service), &native_open?/1) end)
    Process.exit(caller, :kill)
    assert Access.status(ctx.service).active == 1
    old = Access.coordinator(ctx.service)
    Process.exit(old, :kill)
    eventually(fn -> Access.coordinator(ctx.service) != old end)
    assert Access.status(ctx.service).active == 1
    second = fifo!(Path.join(ctx.tmp_dir, "second"))
    assert transient(fn -> Access.read(second, ctx.opts) end).reason == :timeout
    assert transient(fn -> Access.read(second, ctx.opts) end).reason == :busy
    Enum.each([path, second], &unblock_fifo/1)
    eventually(fn -> Access.status(ctx.service).active == 0 end)
  end

  test "caller budgets include queued admission and service lookup; status fails soft", ctx do
    coordinator = Access.coordinator(ctx.service)
    parent = self()
    :ok = :sys.suspend(coordinator)

    try do
      started = System.monotonic_time(:millisecond)

      assert transient(fn ->
               Access.task(
                 ctx.root,
                 fn -> send(parent, :late_open) end,
                 ctx.opts ++ [timeout: 20]
               )
             end).reason == :timeout

      assert System.monotonic_time(:millisecond) - started < 150
      assert %{available: false} = Access.status(ctx.service)
    after
      :sys.resume(coordinator)
    end

    eventually(fn -> Access.status(ctx.service).active == 0 end)
    refute_receive :late_open, 30
    :ok = :sys.suspend(ctx.service)

    try do
      assert Access.dir?(ctx.root, ctx.opts)
      assert %{active: 0} = Access.status(ctx.service)
    after
      :sys.resume(ctx.service)
    end
  end

  # Red control: route any wrapper through File or non-raw :file operations.
  test "raw operations complete while the shared file server is suspended", ctx do
    path = Path.join(ctx.tmp_dir, "raw")
    link = path <> ".link"
    File.write!(path, "raw")
    File.ln_s!(path, link)
    assert Access.stream!(path, [], :line, ctx.opts) |> Enum.to_list() == ["raw"]
    assert Access.wildcard(path <> "*", ctx.opts) == [path, link]
    server = Process.whereis(:file_server_2)
    :ok = :sys.suspend(server)

    try do
      assert Access.read!(path, ctx.opts) == "raw"

      assert Access.task(
               ctx.tmp_dir,
               fn ->
                 directory = Path.join(ctx.tmp_dir, "new/nested")
                 assert :ok = Access.mkdir_p(directory)
                 assert :ok = Access.chmod(directory, 0o700)
                 written = Path.join(directory, "written")
                 assert :ok = Access.write(written, "written", [:exclusive])
                 assert {:error, :eexist} = Access.write(written, "no", [:exclusive])
                 assert :ok = Access.rename(written, written <> ".moved")
                 assert Access.read!(written <> ".moved") == "written"
                 assert :ok = Access.rm(written <> ".moved")
                 assert :ok = Access.rmdir(directory)
                 :ok
               end,
               ctx.opts
             ) == :ok

      assert Access.regular?(path, ctx.opts)
      assert Access.dir?(ctx.tmp_dir, ctx.opts)
      assert {:ok, %File.Stat{type: :symlink}} = Access.lstat(link, ctx.opts)
      assert Access.read_link(link, ctx.opts) == {:ok, path}
      assert {:ok, names} = Access.ls(ctx.tmp_dir, ctx.opts)
      assert "raw" in names
      assert Access.find_executable("/bin/sh", ctx.opts) == "/bin/sh"
      assert Access.exists?(path, ctx.opts)
      assert Access.stream!(path, [], :line, ctx.opts) |> Enum.to_list() == ["raw"]
      assert Access.wildcard(path <> "*", ctx.opts) == [path, link]
    after
      :sys.resume(server)
    end
  end

  test "worker callbacks inherit the caller's scoped environment", ctx do
    Shuttle.Test.Env.put_env("SHUTTLE_FILE_ACCESS_TEST", "scoped-owner")

    assert Access.task(ctx.root, fn -> Shuttle.Env.get("SHUTTLE_FILE_ACCESS_TEST") end, ctx.opts) ==
             "scoped-owner"
  end

  test "a protected root beneath a symlink retains logical and physical refusal aliases", ctx do
    parent = Path.join(ctx.tmp_dir, "alias-parent")
    File.ln_s!(ctx.tmp_dir, parent)
    root = Path.join(parent, "Documents")

    service =
      Shuttle.Test.Env.start_scoped!(
        Supervisor.child_spec({Access, name: nil, protected_roots: [root]}, id: :alias_root)
      )

    opts = [server: service]

    error =
      transient(fn -> Access.task(Path.join(root, "file"), fn -> {:error, :eacces} end, opts) end)

    assert error.path == root
    assert [%{prefix: ^root}] = Access.status(service).blocked_prefixes
    assert transient(fn -> Access.read!(Path.join(ctx.root, "file"), opts) end).reason == :blocked
  end

  test "denials outside protected roots are named rather than missing", ctx do
    path = Path.join(ctx.tmp_dir, "ordinary")
    error = transient(fn -> Access.task(path, fn -> {:error, :eacces} end, ctx.opts) end)
    assert error.reason == :denied
    assert error.path == path
    assert Access.status(ctx.service).blocked_prefixes == []
  end

  defp transient(fun), do: assert_raise(Error, fun)

  defp fifo!(path) do
    {_, 0} = System.cmd("mkfifo", [path])
    on_exit(fn -> unblock_fifo(path) end)
    path
  end

  defp unblock_fifo(path) do
    {_, 0} = System.cmd("/bin/sh", ["-c", "exec 3<> \"$1\"; printf granted >&3", "writer", path])
  end

  defp worker_pids(service) do
    {_, workers, _, _} = Enum.find(Supervisor.which_children(service), &(elem(&1, 0) == :workers))
    Task.Supervisor.children(workers) |> Enum.sort()
  end

  defp native_open?(pid) do
    case Process.info(pid, :current_stacktrace) do
      {:current_stacktrace, frames} ->
        Enum.any?(frames, fn {module, function, _, _} ->
          module == :prim_file and function in [:open, :open_nif]
        end)

      _ ->
        false
    end
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
