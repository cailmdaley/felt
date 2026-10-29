defmodule Shuttle.SessionLinkTest do
  use ExUnit.Case, async: true

  alias Shuttle.SessionLink

  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"
  @other "fef866ba-b397-4277-a01b-16fcecc2b256"
  @first "https://claude.ai/code/session_01FIRST"
  @other_url "https://claude.ai/code/session_01OTHER"
  @last "https://claude.ai/code/session_01LAST"

  defp bridge(url),
    do: %{"type" => "user", "attachment" => %{"type" => "remote_session_change", "url" => url}}

  defp line(record), do: Jason.encode!(record) <> "\n"

  defp fixture do
    root = Path.join(System.tmp_dir!(), "shuttle_link_#{System.unique_integer([:positive])}")
    claude = Path.join(root, "claude")
    pi = Path.join(root, "pi")
    codex = Path.join(root, "codex")
    Enum.each([claude, pi, codex], &File.mkdir_p!/1)
    on_exit(fn -> File.rm_rf(root) end)
    [root: claude, pi_root: pi, codex_root: codex]
  end

  defp start_resolver(roots, start_opts \\ []) do
    table = String.to_atom("session_links_#{System.unique_integer([:positive])}")
    supervisor_id = make_ref()

    supervisor =
      start_supervised!(
        Supervisor.child_spec({DynamicSupervisor, strategy: :one_for_one}, id: supervisor_id)
      )

    child_spec =
      Supervisor.child_spec(
        {SessionLink, Keyword.merge([table: table, name: nil], start_opts)},
        id: table,
        restart: :temporary
      )

    {:ok, pid} = DynamicSupervisor.start_child(supervisor, child_spec)
    {pid, Keyword.merge(roots, server: pid, table: table, test_supervisor: supervisor)}
  end

  defp claude_path(roots, session \\ @session) do
    dir = Path.join(Keyword.fetch!(roots, :root), "project")
    File.mkdir_p!(dir)
    Path.join(dir, "#{session}.jsonl")
  end

  defp eventually(fun, attempts \\ 300)
  defp eventually(fun, 0), do: fun.()

  defp eventually(fun, attempts) do
    case fun.() do
      {:ok, value} ->
        value

      :retry ->
        Process.sleep(5)
        eventually(fun, attempts - 1)

      other ->
        flunk("unexpected wait result: #{inspect(other)}")
    end
  end

  defp ready(session, opts) do
    eventually(fn ->
      case SessionLink.resolve(session, opts) do
        %{availability: :resolving} -> :retry
        link -> {:ok, link}
      end
    end)
  end

  test "a blocked resolver never blocks a request and a miss is explicitly resolving" do
    roots = fixture()
    path = claude_path(roots)
    File.write!(path, line(bridge(@first)))
    {pid, opts} = start_resolver(roots)
    :sys.suspend(pid)
    request = Task.async(fn -> SessionLink.resolve(@session, opts) end)
    assert {:ok, %{availability: :resolving, url: nil}} = Task.yield(request, 1_000)
    lookup = Task.async(fn -> SessionLink.cached_url(@session, opts) end)
    assert {:ok, nil} = Task.yield(lookup, 1_000)
    :sys.resume(pid)
    assert %{url: @first} = ready(@session, opts)
  end

  test "a missing resolver never falls back to synchronous transcript I/O" do
    roots = fixture()
    File.write!(claude_path(roots), line(bridge(@first)))

    opts =
      Keyword.merge(roots,
        server: :session_link_missing_server,
        table: :session_link_missing_table
      )

    assert %{availability: :resolving, url: nil} = SessionLink.resolve(@session, opts)
    assert SessionLink.cached_url(@session, opts) == nil
  end

  test "a real open failure is retried and does not become a permanent miss" do
    roots = fixture()
    path = claude_path(roots)
    File.write!(path, line(bridge(@first)))
    File.chmod!(path, 0o000)
    {_pid, opts} = start_resolver(roots)
    assert %{availability: :resolving} = SessionLink.resolve(@session, opts)

    eventually(fn ->
      if SessionLink.stats(opts[:server]).queued == 0, do: {:ok, :attempted}, else: :retry
    end)

    File.chmod!(path, 0o600)

    assert %{url: @first} =
             eventually(
               fn ->
                 case SessionLink.resolve(@session, opts) do
                   %{url: @first} = link -> {:ok, link}
                   _ -> :retry
                 end
               end,
               400
             )
  end

  test "persistent failures use bounded exponential retry delays and warn once per reason" do
    roots = fixture()
    path = claude_path(roots)
    File.write!(path, line(bridge(@first)))
    File.chmod!(path, 0o000)
    {_pid, opts} = start_resolver(roots, retry_base_ms: 1, retry_max_ms: 8)
    assert %{availability: :resolving} = SessionLink.resolve(@session, opts)

    delays =
      eventually(fn ->
        state = :sys.get_state(opts[:server])

        case Map.values(state.retry_delays) do
          [[1, 2, 4, 8, 8 | _] = history] -> {:ok, history}
          _ -> :retry
        end
      end)

    assert Enum.take(delays, 5) == [1, 2, 4, 8, 8]
    state = :sys.get_state(opts[:server])
    assert Enum.any?(state.retrying, fn {_key, retry} -> retry.delay_ms == 8 end)
    assert Enum.count(state.warned, fn {_key, reason} -> reason == {:open, :eacces} end) == 1

    File.chmod!(path, 0o600)

    assert %{url: @first} =
             eventually(fn ->
               case SessionLink.resolve(@session, opts) do
                 %{url: @first} = link -> {:ok, link}
                 _ -> :retry
               end
             end)
  end

  test "an inaccessible remembered path keeps its published URL and retries stat errors" do
    roots = fixture()
    path = claude_path(roots)
    directory = Path.dirname(path)
    File.write!(path, line(bridge(@first)))
    {_pid, opts} = start_resolver(roots, retry_base_ms: 1, retry_max_ms: 4)
    assert %{url: @first} = ready(@session, opts)

    File.chmod!(directory, 0o000)

    try do
      assert %{availability: :available_local, url: @first} =
               SessionLink.resolve(@session, opts)

      eventually(fn ->
        state = :sys.get_state(opts[:server])

        if Enum.any?(state.retrying, fn {_key, _retry} -> true end) and
             Enum.any?(state.warned, fn {_key, reason} -> reason == {:stat_path, :eacces} end),
           do: {:ok, :retrying},
           else: :retry
      end)

      assert SessionLink.cached_url(@session, opts) == @first
    after
      File.chmod!(directory, 0o700)
    end

    assert %{url: @first} = ready(@session, opts)
  end

  test "the complete baseline finds a late first URL beyond a large prefix" do
    roots = fixture()
    path = claude_path(roots)
    prefix = String.duplicate(~s({"type":"user","message":"quiet"}\n), 35_000)
    File.write!(path, prefix <> line(bridge(@first)))
    {_pid, opts} = start_resolver(roots)
    assert %{url: @first, availability: :available_local} = ready(@session, opts)

    assert SessionLink.stats(opts[:server]).bytes_read ==
             byte_size(prefix <> line(bridge(@first)))
  end

  test "appends are incremental, changed positives refresh, and null records do not clear" do
    roots = fixture()
    path = claude_path(roots)
    initial = line(bridge(@first))
    File.write!(path, initial)
    {_pid, opts} = start_resolver(roots)
    assert %{url: @first} = ready(@session, opts)
    before = SessionLink.stats(opts[:server]).bytes_read

    append = line(bridge(@last)) <> line(bridge(nil))
    File.write!(path, append, [:append])

    eventually(fn ->
      case SessionLink.resolve(@session, opts) do
        %{url: @last} = link -> {:ok, link}
        _ -> :retry
      end
    end)

    assert SessionLink.stats(opts[:server]).bytes_read == before + byte_size(append)

    stable = SessionLink.stats(opts[:server]).bytes_read
    SessionLink.resolve(@session, opts)
    Process.sleep(20)
    assert SessionLink.stats(opts[:server]).bytes_read == stable
  end

  test "an incomplete final JSONL line is retained and parsed only after newline" do
    roots = fixture()
    path = claude_path(roots)
    record = Jason.encode!(bridge(@first))
    File.write!(path, record)
    {_pid, opts} = start_resolver(roots)
    assert %{availability: :available_local, url: nil} = ready(@session, opts)
    File.write!(path, "\n", [:append])

    assert %{url: @first} =
             eventually(fn ->
               case SessionLink.resolve(@session, opts) do
                 %{url: @first} = link -> {:ok, link}
                 _ -> :retry
               end
             end)
  end

  test "truncation and inode replacement rebuild the projection" do
    roots = fixture()
    path = claude_path(roots)
    File.write!(path, line(bridge(@first)) <> String.duplicate(" ", 200))
    {_pid, opts} = start_resolver(roots)
    assert %{url: @first} = ready(@session, opts)

    File.write!(path, line(bridge(@last)))

    assert %{url: @last} =
             eventually(fn ->
               case SessionLink.resolve(@session, opts) do
                 %{url: @last} = link -> {:ok, link}
                 _ -> :retry
               end
             end)

    replacement = path <> ".replacement"
    File.write!(replacement, line(bridge(@first)))
    File.rename!(replacement, path)

    assert %{url: @first} =
             eventually(fn ->
               case SessionLink.resolve(@session, opts) do
                 %{url: @first} = link -> {:ok, link}
                 _ -> :retry
               end
             end)
  end

  test "a same-inode shrink below the observed end resets an in-flight baseline" do
    roots = fixture()
    path = claude_path(roots)
    File.write!(path, line(bridge(@first)))
    parent = self()
    arm = :atomics.new(1, [])

    after_pass = fn key, result, cursors ->
      if elem(key, 0) == @session and result == :continue and :atomics.exchange(arm, 1, 0) == 1 do
        cursor = Map.fetch!(cursors, key)
        send(parent, {:pass_complete, cursor.offset, cursor.observed_size})
        receive do: (:release_pass -> :ok)
      end
    end

    {pid, opts} = start_resolver(roots, chunk_bytes: 4_096, after_pass: after_pass)
    assert %{url: @first} = ready(@session, opts)
    before = SessionLink.stats(pid).bytes_read

    :atomics.put(arm, 1, 1)

    File.write!(path, line(bridge(@last)) <> String.duplicate(~s({"type":"user"}\n), 20_000), [
      :append
    ])

    SessionLink.resolve(@session, opts)
    assert_receive {:pass_complete, offset, observed_size}, 1_000
    assert offset > before
    assert offset < observed_size
    shorter_size = offset + 64

    replacement =
      String.duplicate(" \n", div(shorter_size, 2)) <>
        if(rem(shorter_size, 2) == 1, do: " ", else: "")

    File.write!(path, replacement)
    send(pid, :release_pass)

    assert %{availability: :available_local, url: nil} =
             eventually(fn ->
               case SessionLink.resolve(@session, opts) do
                 %{availability: :available_local, url: nil} = link -> {:ok, link}
                 _ -> :retry
               end
             end)
  end

  test "native Pi and Codex records with adversarial markers are never streamed" do
    roots = fixture()
    pi_dir = Path.join(roots[:pi_root], "project")
    codex_dir = Path.join(roots[:codex_root], "2026/10/29")
    File.mkdir_p!(pi_dir)
    File.mkdir_p!(codex_dir)
    pi = "01a042f4-6b7f-7f79-9c6c-8140ffd0126c"
    codex = "01a0b39f-d9d0-7d02-9adf-c24f825c3342"
    File.write!(Path.join(pi_dir, "2026-10-29T00-00-00Z_#{pi}.jsonl"), line(bridge(@first)))

    File.write!(
      Path.join(codex_dir, "rollout-2026-10-29T00-00-00-#{codex}.jsonl"),
      line(bridge(@first))
    )

    {_pid, opts} = start_resolver(Keyword.put(roots, :today, ~D[2026-10-29]))
    assert %{harness: "pi", url: nil} = ready(pi, opts)
    assert %{harness: "codex", url: nil} = ready(codex, opts)
    assert SessionLink.stats(opts[:server]).bytes_read == 0
  end

  test "missing transcript becomes available after creation, and roots do not share cache entries" do
    roots = Keyword.put(fixture(), :missing_retry_ms, 0)
    {_pid, opts} = start_resolver(roots)
    assert %{availability: :transcript_missing} = ready(@other, opts)
    File.write!(claude_path(roots, @other), line(bridge(@first)))

    assert %{url: @first} =
             eventually(fn ->
               case SessionLink.resolve(@other, opts) do
                 %{url: @first} = link -> {:ok, link}
                 _ -> :retry
               end
             end)

    roots2 = fixture()
    File.write!(claude_path(roots2, @other), line(bridge(@last)))
    {_pid2, opts2} = start_resolver(roots2)
    assert %{url: @last} = ready(@other, opts2)
  end

  test "forget invalidates queued work before it can republish a stale answer" do
    roots = fixture()
    File.write!(claude_path(roots), line(bridge(@first)))
    {pid, opts} = start_resolver(roots)
    :sys.suspend(pid)
    assert %{availability: :resolving} = SessionLink.resolve(@session, opts)
    forgetter = Task.async(fn -> SessionLink.forget(@session, opts) end)
    Process.sleep(5)
    :sys.resume(pid)
    assert :ok = Task.await(forgetter)
    assert %{availability: :resolving} = SessionLink.resolve(@session, opts)
    assert %{url: @first} = ready(@session, opts)
  end

  test "a same-size changed mtime invalidates the scanned prefix" do
    roots = fixture()
    path = claude_path(roots)
    original = line(bridge(@first))
    changed = line(bridge(@other_url))
    assert byte_size(original) == byte_size(changed)
    File.write!(path, original)
    {_pid, opts} = start_resolver(roots)
    assert %{url: @first} = ready(@session, opts)
    {:ok, %{mtime: {{year, month, day}, {hour, minute, second}}}} = File.stat(path)
    File.write!(path, changed)

    next_mtime =
      :calendar.datetime_to_gregorian_seconds({{year, month, day}, {hour, minute, second}})
      |> Kernel.+(2)
      |> :calendar.gregorian_seconds_to_datetime()

    File.touch!(path, next_mtime)

    assert %{url: @other_url} =
             eventually(fn ->
               case SessionLink.resolve(@session, opts) do
                 %{url: @other_url} = link -> {:ok, link}
                 _ -> :retry
               end
             end)
  end

  test "concurrent callers dedupe one source; restart and forget rebuild without stale answers" do
    roots = fixture()
    path = claude_path(roots)
    body = line(bridge(@first))
    File.write!(path, body)
    {pid, opts} = start_resolver(roots)
    1..30 |> Task.async_stream(fn _ -> SessionLink.resolve(@session, opts) end) |> Enum.to_list()
    assert %{url: @first} = ready(@session, opts)
    assert SessionLink.stats(pid).bytes_read == byte_size(body)

    SessionLink.forget(@session, opts)
    assert %{availability: :resolving} = SessionLink.resolve(@session, opts)
    assert %{url: @first} = ready(@session, opts)

    DynamicSupervisor.terminate_child(opts[:test_supervisor], pid)
    table = opts[:table]

    child_spec =
      Supervisor.child_spec({SessionLink, [table: table, name: nil]},
        id: table,
        restart: :temporary
      )

    {:ok, next} = DynamicSupervisor.start_child(opts[:test_supervisor], child_spec)
    opts = Keyword.put(opts, :server, next)
    assert %{availability: :resolving} = SessionLink.resolve(@session, opts)
    assert %{url: @first} = ready(@session, opts)
    assert SessionLink.stats(next).bytes_read == byte_size(body)
  end

  test "desktop routes and the URL allowlist stay narrow" do
    assert SessionLink.desktop_url(@session) == "codex://threads/" <> @session
    assert SessionLink.desktop_url("bad") == nil
    refute SessionLink.claude_url?("https://claude.ai.evil.example/x")
    assert SessionLink.claude_url?(@first)
  end
end
