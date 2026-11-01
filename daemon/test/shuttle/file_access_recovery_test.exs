defmodule Shuttle.FileAccess.RecoveryTest do
  use ExUnit.Case, async: false
  alias Shuttle.FileAccess, as: Access
  alias Shuttle.FileAccess.Error
  @moduletag :tmp_dir

  setup ctx do
    root = Path.join(ctx.tmp_dir, "Documents")
    File.mkdir_p!(root)
    roots = if ctx[:unprotected], do: [], else: [root]

    service =
      start_supervised!({Access, name: nil, capacity: 2, timeout: 60, protected_roots: roots})

    %{root: root, service: service, opts: [service: service]}
  end

  # Red control: use live Task.Supervisor children as the admission credits.
  @tag :unprotected
  test "unexpected native-worker death quarantines its credit across coordinator restart", ctx do
    paths = for n <- 1..3, do: fifo!(Path.join(ctx.tmp_dir, "fifo#{n}"))

    callers =
      for path <- Enum.take(paths, 2),
          do: Task.async(fn -> assert_raise Error, fn -> Access.read(path, ctx.opts) end end)

    Enum.each(callers, fn caller -> assert Task.await(caller).reason == :timeout end)
    [victim, _other] = worker_pids(ctx.service)
    Process.exit(victim, :kill)

    eventually(fn ->
      Access.status(ctx.service).active == 2 and
        Map.get(Access.status(ctx.service), :quarantined) == 1
    end)

    assert assert_raise(Error, fn -> Access.read(Enum.at(paths, 2), ctx.opts) end).reason == :busy
    old = Access.coordinator(ctx.service)
    Process.exit(old, :kill)
    eventually(fn -> Access.coordinator(ctx.service) != old end)
    assert %{active: 2, quarantined: 1} = Access.status(ctx.service)
    assert assert_raise(Error, fn -> Access.read(Enum.at(paths, 2), ctx.opts) end).reason == :busy
    Enum.each(Enum.take(paths, 2), &unblock_fifo/1)
    eventually(fn -> Access.status(ctx.service).active == 1 end)
    :ok = Access.reset(:all, ctx.service)
    assert %{active: 1, quarantined: 1} = Access.status(ctx.service)
    path = Path.join(ctx.tmp_dir, "healthy")
    File.write!(path, "healthy")
    assert Access.read(path, ctx.opts) == {:ok, "healthy"}
    assert %{quarantined: 1} = Access.status(ctx.service)
  end

  # Red control: condition recovery on the successful job's own timed_out bit.
  test "an already-inflight successful native read heals another job's denial", ctx do
    fifo = fifo!(Path.join(ctx.root, "grant"))
    parent = self()

    denial =
      Task.async(fn ->
        assert_raise Error, fn ->
          Access.task(
            ctx.root,
            fn ->
              send(parent, {:denial_ready, self()})

              receive do
                :deny -> {:error, :eacces}
              end
            end,
            ctx.opts ++ [timeout: 2_000]
          )
        end
      end)

    assert_receive {:denial_ready, denied_worker}
    success = Task.async(fn -> Access.read(fifo, ctx.opts ++ [timeout: 2_000]) end)

    eventually(fn ->
      length(worker_pids(ctx.service)) == 2 and
        Enum.any?(worker_pids(ctx.service), &native_open?/1)
    end)

    send(denied_worker, :deny)
    assert Task.await(denial).reason == :blocked
    assert [%{cause: :eacces}] = Access.status(ctx.service).blocked_prefixes
    unblock_fifo(fifo)
    assert Task.await(success) == {:ok, "granted"}
    eventually(fn -> Access.status(ctx.service).blocked_prefixes == [] end)
  end

  test "late metadata success cannot heal a protected-folder denial", ctx do
    path = Path.join(ctx.root, "metadata")
    File.write!(path, "metadata")
    parent = self()

    denial =
      Task.async(fn ->
        assert_raise Error, fn ->
          Access.task(
            ctx.root,
            fn ->
              send(parent, {:denial_ready, self()})

              receive do
                :deny -> {:error, :eacces}
              end
            end,
            ctx.opts ++ [timeout: 2_000]
          )
        end
      end)

    assert_receive {:denial_ready, denied_worker}

    metadata =
      Task.async(fn ->
        assert_raise Error, fn ->
          Access.task(
            path,
            fn ->
              result = :file.read_file_info(String.to_charlist(path), [:raw])
              send(parent, {:metadata_ready, self()})

              receive do
                :finish -> result
              end
            end,
            ctx.opts
          )
        end
      end)

    assert_receive {:metadata_ready, worker}
    assert Task.await(metadata).reason == :timeout

    send(denied_worker, :deny)
    assert Task.await(denial).reason == :blocked
    assert [%{cause: :eacces}] = Access.status(ctx.service).blocked_prefixes
    send(worker, :finish)
    eventually(fn -> Access.status(ctx.service).active == 0 end)
    assert [%{cause: :eacces}] = Access.status(ctx.service).blocked_prefixes
  end

  # Red control: keep cache/jobs in the disposable coordinator, or capture its
  # pid in native workers. Restart must preserve the alias block and late proof.
  test "protected symlink timeout survives coordinator restart and recovers on actual completion",
       ctx do
    fifo = fifo!(Path.join(ctx.root, "pending"))
    link = Path.join(ctx.tmp_dir, ".felt")
    File.ln_s!(ctx.root, link)
    logical = Path.join(link, "pending")
    assert assert_raise(Error, fn -> Access.read(logical, ctx.opts) end).reason == :timeout
    before = Access.status(ctx.service)
    assert %{active: 1, blocked_prefixes: [_]} = before
    old = Access.coordinator(ctx.service)
    Process.exit(old, :kill)
    eventually(fn -> Access.coordinator(ctx.service) != old end)
    assert Access.status(ctx.service).blocked_prefixes == before.blocked_prefixes
    assert Access.status(ctx.service).active == 1

    assert assert_raise(Error, fn -> Access.stat(Path.join(link, "another"), ctx.opts) end).reason ==
             :blocked

    assert Access.status(ctx.service).active == 1
    unblock_fifo(fifo)

    eventually(fn ->
      Access.status(ctx.service).active == 0 and Access.status(ctx.service).blocked_prefixes == []
    end)
  end

  test "a reader failure reported before cleanup is not replayed after a newer grant", ctx do
    parent = self()
    fifo = fifo!(Path.join(ctx.root, "grant-after-report"))

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        denied =
          Task.async(fn ->
            assert_raise Error, fn ->
              Access.task(
                ctx.root,
                fn ->
                  {journal, lease} = Process.get({Access, :lease})
                  send(parent, {:denial_ready, self()})

                  receive do
                    :deny -> :ok
                  end

                  failure_id = make_ref()
                  message = {:reader_block, lease, failure_id, :eacces}
                  GenServer.call(journal, message)
                  send(parent, :reported)

                  receive do
                    :duplicate -> GenServer.call(journal, message)
                  end

                  send(parent, :duplicate_reported)

                  receive do
                    :cleanup -> {:error, :eacces}
                  end
                end,
                ctx.opts ++ [timeout: 2_000]
              )
            end
          end)

        assert_receive {:denial_ready, denied_worker}
        success = Task.async(fn -> Access.read(fifo, ctx.opts ++ [timeout: 2_000]) end)
        eventually(fn -> Enum.any?(worker_pids(ctx.service), &native_open?/1) end)
        send(denied_worker, :deny)
        assert_receive :reported
        assert [_] = Access.status(ctx.service).blocked_prefixes
        unblock_fifo(fifo)
        assert Task.await(success) == {:ok, "granted"}
        assert [] = Access.status(ctx.service).blocked_prefixes
        send(denied_worker, :duplicate)
        assert_receive :duplicate_reported
        assert [] = Access.status(ctx.service).blocked_prefixes
        send(denied_worker, :cleanup)
        assert Task.await(denied).reason == :blocked
        assert [] = Access.status(ctx.service).blocked_prefixes
      end)

    assert length(Regex.scan(~r/Filesystem access blocked/, log)) == 1
  end

  test "transient journal latency does not restart ingress or quarantine the pool", ctx do
    coordinator = Access.coordinator(ctx.service)
    journal = Access.journal(ctx.service)
    :ok = :sys.suspend(journal)

    try do
      for _ <- 1..5 do
        assert %{available: false} = Access.status(ctx.service)
        assert Process.alive?(coordinator)
        assert Process.alive?(ctx.service)
      end

      assert assert_raise(Error, fn -> Access.reset(:all, ctx.service) end).reason == :busy
    after
      :sys.resume(journal)
    end

    assert Access.coordinator(ctx.service) == coordinator
    assert %{available: true, quarantined: 0} = Access.status(ctx.service)
    assert Access.dir?(ctx.root, ctx.opts)
  end

  test "a stale native proof cannot heal a subsequent failure or repeat its warning", ctx do
    parent = self()
    path = Path.join(ctx.root, "proof")
    File.write!(path, "proof")

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        denial =
          Task.async(fn ->
            assert_raise Error, fn ->
              Access.task(
                ctx.root,
                fn ->
                  send(parent, {:denial_ready, self()})

                  receive do
                    :deny -> {:error, :eacces}
                  end
                end,
                ctx.opts
              )
            end
          end)

        assert_receive {:denial_ready, denied_worker}

        success =
          Task.async(fn ->
            Access.task(
              path,
              fn ->
                send(parent, {:proof_ready, self()})

                receive do
                  :read -> :ok
                end

                {:ok, fd} = :file.open(String.to_charlist(path), [:read, :binary, :raw])
                {:ok, bytes} = :file.read(fd, 5)
                :ok = :file.close(fd)
                proven_at = System.monotonic_time()
                {journal, lease} = Process.get({Access, :lease})
                send(parent, {:proof_held, bytes})

                receive do
                  :deliver -> GenServer.call(journal, {:permission_proof, lease, proven_at})
                end

                {:ok, bytes}
              end,
              ctx.opts ++ [timeout: 2_000]
            )
          end)

        assert_receive {:proof_ready, proof_worker}
        assert Task.await(denial).reason == :timeout
        send(proof_worker, :read)
        assert_receive {:proof_held, "proof"}
        send(denied_worker, :deny)
        eventually(fn -> Access.status(ctx.service).active == 1 end)
        assert [%{cause: :eacces}] = Access.status(ctx.service).blocked_prefixes
        send(proof_worker, :deliver)
        assert Task.await(success) == {:ok, "proof"}
        assert [_] = Access.status(ctx.service).blocked_prefixes
      end)

    assert length(Regex.scan(~r/Filesystem access blocked/, log)) == 1
  end

  @tag :unprotected
  test "loss of the independent journal fails closed for the VM lifetime", ctx do
    fifo = fifo!(Path.join(ctx.tmp_dir, "journal-loss"))
    assert assert_raise(Error, fn -> Access.read(fifo, ctx.opts) end).reason == :timeout
    old = Access.journal(ctx.service)
    Process.exit(old, :kill)
    eventually(fn -> Access.journal(ctx.service) != old end)
    assert %{active: 2, quarantined: 2} = Access.status(ctx.service)
    assert assert_raise(Error, fn -> Access.read(fifo, ctx.opts) end).reason == :busy
    unblock_fifo(fifo)
    eventually(fn -> worker_pids(ctx.service) == [] end)
    :ok = Access.reset(:all, ctx.service)
    assert %{active: 2, quarantined: 2} = Access.status(ctx.service)
  end

  test "wrapped normal, error and raised completions do not quarantine credits", ctx do
    for _ <- 1..10 do
      assert Access.task(ctx.root, fn -> :ok end, ctx.opts) == :ok
      assert Access.task(ctx.root, fn -> {:error, :enoent} end, ctx.opts) == {:error, :enoent}

      assert_raise ArgumentError, fn ->
        Access.task(ctx.root, fn -> raise ArgumentError, "wrapped" end, ctx.opts)
      end

      assert catch_exit(Access.task(ctx.root, fn -> exit(:wrapped) end, ctx.opts)) == :wrapped
    end

    eventually(fn -> Access.status(ctx.service).active == 0 end)
    assert %{quarantined: 0} = Access.status(ctx.service)
  end

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
