defmodule Shuttle.StoreSyncTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Shuttle.Test.ApiConn

  alias Shuttle.Host
  alias Shuttle.StoreSync
  alias Shuttle.Test.Env

  @endpoint ShuttleWeb.Endpoint
  @moduletag :tmp_dir

  setup_all do
    repo_root = Path.expand("../../..", __DIR__)
    bin_dir = Path.join(System.tmp_dir!(), "shuttle-store-sync-felt-#{System.unique_integer([:positive])}")
    File.mkdir_p!(bin_dir)
    felt_bin = Path.join(bin_dir, "felt")

    {output, status} =
      System.cmd("go", ["build", "-o", felt_bin, "./cmd/felt"],
        cd: repo_root,
        stderr_to_stdout: true
      )

    if status != 0 do
      raise "failed to build worktree felt binary: #{output}"
    end

    on_exit(fn -> File.rm_rf!(bin_dir) end)
    {:ok, felt_bin_dir: bin_dir}
  end

  setup %{tmp_dir: tmp, felt_bin_dir: felt_bin_dir} do
    Env.put_env("SHUTTLE_HOST_CONFIG_FILE", Path.join(tmp, "host.json"))
    Env.put_env("PATH", felt_bin_dir <> ":" <> System.get_env("PATH", ""))
    :ok
  end

  # ── Git fixture helpers ──

  defp git!(dir, args) do
    {output, status} =
      System.cmd("git", ["-C", dir | args],
        stderr_to_stdout: true,
        env: [
          {"GIT_AUTHOR_NAME", "Test"},
          {"GIT_AUTHOR_EMAIL", "test@example.com"},
          {"GIT_COMMITTER_NAME", "Test"},
          {"GIT_COMMITTER_EMAIL", "test@example.com"},
          {"GIT_TERMINAL_PROMPT", "0"}
        ]
      )

    assert status == 0, "git #{Enum.join(args, " ")} in #{dir} failed (#{status}): #{output}"
    String.trim(output)
  end

  defp create_store_fixture(tmp, name) do
    base = Path.join(tmp, name)
    bare = Path.join(base, "origin.git")
    peer = Path.join(base, "peer")
    store = Path.join(base, "store")

    File.mkdir_p!(base)
    {_, 0} = System.cmd("git", ["init", "--bare", "--initial-branch=main", bare])
    {_, 0} = System.cmd("git", ["clone", bare, peer], stderr_to_stdout: true)

    File.mkdir_p!(Path.join(peer, ".felt"))
    File.write!(Path.join(peer, ".felt/note.md"), "# initial\n")
    git!(peer, ["add", ".felt/note.md"])
    git!(peer, ["commit", "-m", "initial fiber"])
    git!(peer, ["push", "-u", "origin", "main"])

    {_, 0} = System.cmd("git", ["clone", bare, store], stderr_to_stdout: true)
    %{bare: bare, peer: peer, store: realpath(store)}
  end

  defp push_upstream_commit(%{peer: peer}, rel_path, content, message) do
    full = Path.join(peer, rel_path)
    File.mkdir_p!(Path.dirname(full))
    File.write!(full, content)
    git!(peer, ["add", rel_path])
    git!(peer, ["commit", "-m", message])
    git!(peer, ["push"])
    git!(peer, ["rev-parse", "HEAD"])
  end

  defp realpath(path) do
    case Shuttle.Realpath.resolve(path) do
      {:ok, resolved} -> resolved
      {:error, _} -> path
    end
  end

  defp start_sync(opts) do
    Env.start_scoped!(
      {StoreSync,
       Keyword.merge(
         [name: nil, boot_delay_ms: :infinity, interval_ms: :infinity],
         opts
       )}
    )
  end

  # ── 1. Clean repo behind upstream ──

  test "clean repo behind upstream fast-forwards via felt sync --ff-only and reports :fast_forwarded",
       %{tmp_dir: tmp} do
    fixture = create_store_fixture(tmp, "clean-ff")
    prev_short = git!(fixture.store, ["rev-parse", "--short", "HEAD"])
    upstream_head = push_upstream_commit(fixture, ".felt/note.md", "# updated\n", "upstream update")

    pid = start_sync(enabled: true, stores: [fixture.store])
    status = StoreSync.sync_now(pid)

    assert status.enabled == true
    assert status.state == :idle
    assert [repo] = status.repos
    assert repo.path == fixture.store
    assert repo.status == :fast_forwarded
    assert repo.previous_sha == prev_short
    assert repo.sha == git!(fixture.store, ["rev-parse", "--short", "HEAD"])
    assert repo.commits == 1
    assert repo.ahead == 0
    assert repo.behind == 0
    assert is_binary(repo.synced_at)

    assert git!(fixture.store, ["rev-parse", "HEAD"]) == upstream_head
    assert File.read!(Path.join(fixture.store, ".felt/note.md")) == "# updated\n"

    status2 = StoreSync.sync_now(pid)
    assert [%{status: :up_to_date, ahead: 0, behind: 0}] = status2.repos
  end

  # ── 2. Dirty repo (modified tracked file OR untracked file) behind upstream ──

  test "dirty repo with modified tracked file does not pull and preserves bytes", %{tmp_dir: tmp} do
    fixture = create_store_fixture(tmp, "dirty-tracked")
    local_head = git!(fixture.store, ["rev-parse", "HEAD"])
    _upstream_head = push_upstream_commit(fixture, ".felt/other.md", "# other\n", "upstream other")

    local_bytes = "# local uncommitted edit\n"
    File.write!(Path.join(fixture.store, ".felt/note.md"), local_bytes)

    pid = start_sync(enabled: true, stores: [fixture.store])
    status = StoreSync.sync_now(pid)

    assert [repo] = status.repos
    assert repo.status == :stale_dirty
    assert repo.behind == 1
    assert repo.ahead == 0
    assert repo.reason =~ "uncommitted"

    assert git!(fixture.store, ["rev-parse", "HEAD"]) == local_head
    assert File.read!(Path.join(fixture.store, ".felt/note.md")) == local_bytes
    refute File.exists?(Path.join(fixture.store, ".felt/other.md"))
  end

  test "dirty repo with untracked file does not pull and preserves bytes", %{tmp_dir: tmp} do
    fixture = create_store_fixture(tmp, "dirty-untracked")
    local_head = git!(fixture.store, ["rev-parse", "HEAD"])
    _upstream_head = push_upstream_commit(fixture, ".felt/other.md", "# other\n", "upstream other")

    untracked_path = Path.join(fixture.store, ".felt/draft.md")
    untracked_bytes = "# untracked draft\n"
    File.write!(untracked_path, untracked_bytes)

    pid = start_sync(enabled: true, stores: [fixture.store])
    status = StoreSync.sync_now(pid)

    assert [repo] = status.repos
    assert repo.status == :stale_dirty
    assert repo.behind == 1
    assert repo.reason =~ "uncommitted"

    assert git!(fixture.store, ["rev-parse", "HEAD"]) == local_head
    assert File.read!(untracked_path) == untracked_bytes
    refute File.exists?(Path.join(fixture.store, ".felt/other.md"))
  end

  # ── 3. Diverged repo & ahead-only repo ──

  test "diverged repo does not pull, rebase, or reset and reports :stale_diverged", %{
    tmp_dir: tmp
  } do
    fixture = create_store_fixture(tmp, "diverged")
    _upstream_head = push_upstream_commit(fixture, ".felt/remote.md", "# remote\n", "remote commit")

    File.write!(Path.join(fixture.store, ".felt/local.md"), "# local\n")
    git!(fixture.store, ["add", ".felt/local.md"])
    git!(fixture.store, ["commit", "-m", "local commit"])
    local_head = git!(fixture.store, ["rev-parse", "HEAD"])

    pid = start_sync(enabled: true, stores: [fixture.store])
    status = StoreSync.sync_now(pid)

    assert [repo] = status.repos
    assert repo.status == :stale_diverged
    assert repo.ahead == 1
    assert repo.behind == 1
    assert repo.reason =~ "diverged"
    assert git!(fixture.store, ["rev-parse", "HEAD"]) == local_head
  end

  test "repo with local unpushed commit and behind == 0 stays untouched and reports :ahead", %{
    tmp_dir: tmp
  } do
    fixture = create_store_fixture(tmp, "ahead-only")
    File.write!(Path.join(fixture.store, ".felt/local.md"), "# local\n")
    git!(fixture.store, ["add", ".felt/local.md"])
    git!(fixture.store, ["commit", "-m", "local commit"])
    local_head = git!(fixture.store, ["rev-parse", "HEAD"])

    pid = start_sync(enabled: true, stores: [fixture.store])
    status = StoreSync.sync_now(pid)

    assert [repo] = status.repos
    assert repo.status == :ahead
    assert repo.ahead == 1
    assert repo.behind == 0
    assert git!(fixture.store, ["rev-parse", "HEAD"]) == local_head
  end

  # ── 4. Symlinked mounted repo (loom/.felt/pando -> pando/.felt) ──

  test "discovers and independently syncs symlinked mounted repo without duplicate work", %{
    tmp_dir: tmp
  } do
    loom = create_store_fixture(tmp, "loom")
    pando = create_store_fixture(tmp, "pando")

    File.ln_s!(Path.join(pando.store, ".felt"), Path.join(loom.store, ".felt/pando"))
    File.write!(Path.join(loom.store, ".gitignore"), ".felt/pando\n")
    git!(loom.store, ["add", ".gitignore"])
    git!(loom.store, ["commit", "-m", "ignore mounted pando"])
    git!(loom.store, ["push"])
    git!(loom.peer, ["pull"])

    loom_head = push_upstream_commit(loom, ".felt/loom-new.md", "# loom\n", "loom update")
    pando_head = push_upstream_commit(pando, ".felt/pando-new.md", "# pando\n", "pando update")

    # Even if both loom and pando appear in configured_stores, each repo is reported once.
    pid = start_sync(enabled: true, stores: [loom.store, pando.store])
    status = StoreSync.sync_now(pid)

    assert length(status.repos) == 2
    by_path = Map.new(status.repos, &{&1.path, &1})

    assert by_path[loom.store].status == :fast_forwarded
    assert by_path[pando.store].status == :fast_forwarded
    assert git!(loom.store, ["rev-parse", "HEAD"]) == loom_head
    assert git!(pando.store, ["rev-parse", "HEAD"]) == pando_head
  end

  # ── 5. Fetch failure & older felt binary error handling ──

  test "broken remote does not crash and reports :fetch_failed", %{tmp_dir: tmp} do
    fixture = create_store_fixture(tmp, "broken-remote")
    git!(fixture.store, ["remote", "set-url", "origin", Path.join(tmp, "does-not-exist.git")])

    pid = start_sync(enabled: true, stores: [fixture.store])

    log =
      capture_log(fn ->
        status = StoreSync.sync_now(pid)
        assert status.state == :idle
        assert [repo] = status.repos
        assert repo.status == :fetch_failed
        assert is_binary(repo.reason) and repo.reason != ""
      end)

    assert log =~ "fetch failed"
    assert Process.alive?(pid)
  end

  defmodule OlderFeltRunner do
    def cmd("felt", _args, _opts), do: {"Error: unknown flag: --ff-only\n", 1}
  end

  test "older felt binary without --ff-only reports :error gracefully without crashing", %{
    tmp_dir: tmp
  } do
    fixture = create_store_fixture(tmp, "older-felt")
    pid = start_sync(enabled: true, stores: [fixture.store], runner: OlderFeltRunner)

    log =
      capture_log(fn ->
        status = StoreSync.sync_now(pid)
        assert status.state == :idle
        assert [repo] = status.repos
        assert repo.status == :error
        assert repo.reason =~ "unknown flag: --ff-only"
      end)

    assert log =~ "unknown flag: --ff-only"
    assert Process.alive?(pid)
  end

  # ── 6. Disabled mode & Host.auto_ff_stores?/0 ──

  test "disabled store sync never touches git and reports enabled: false", %{tmp_dir: tmp} do
    fixture = create_store_fixture(tmp, "disabled")
    local_head = git!(fixture.store, ["rev-parse", "HEAD"])
    _upstream_head = push_upstream_commit(fixture, ".felt/note.md", "# updated\n", "upstream")

    pid = start_sync(enabled: false, stores: [fixture.store])
    status = StoreSync.sync_now(pid)

    assert status.enabled == false
    assert status.state == :disabled
    assert status.repos == []
    assert git!(fixture.store, ["rev-parse", "HEAD"]) == local_head
  end

  describe "Host.auto_ff_stores?/0" do
    test "defaults off on single-user, on on shared-multi-user and exposed, and honors overrides",
         %{tmp_dir: tmp} do
      file = Path.join(tmp, "host.json")

      refute Host.auto_ff_stores?()

      for {body, want} <- [
            {~s({"class":"single-user"}), false},
            {~s({"class":"shared-multi-user"}), true},
            {~s({"class":"exposed"}), true},
            {~s({"class":"single-user","auto_ff_stores":true}), true},
            {~s({"class":"shared-multi-user","auto_ff_stores":false}), false},
            {~s({"class":"exposed","auto_ff_stores":false}), false},
            {~s({"auto_ff_stores":true}), true}
          ] do
        File.write!(file, body)
        assert Host.auto_ff_stores?() == want, body
      end

      File.write!(file, ~s({"class":"shared-multi-user","auto_ff_stores":"yes"}))

      assert capture_log(fn -> assert Host.auto_ff_stores?() end) =~
               ~s("auto_ff_stores" must be true or false)

      File.write!(file, "{broken json")

      assert capture_log(fn -> refute Host.auto_ff_stores?() end) =~
               "cannot read auto_ff_stores"
    end
  end

  # ── 7. /api/v1/version exposes store_sync ──

  test "/api/v1/version exposes store_sync status end-to-end", %{tmp_dir: tmp} do
    fixture = create_store_fixture(tmp, "version-endpoint")
    non_git = Path.join(System.tmp_dir!(), "shuttle-non-git-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(non_git) end)
    File.mkdir_p!(Path.join(non_git, ".felt"))
    {:ok, non_git_real} = Shuttle.Realpath.resolve(non_git)

    pid = start_sync(enabled: true, stores: [fixture.store, non_git])
    Env.put_server(StoreSync, pid)
    _ = StoreSync.sync_now(pid)

    body =
      api_conn()
      |> get("/api/v1/version")
      |> json_response(200)

    assert %{"enabled" => true, "state" => "idle", "repos" => repos} = body["store_sync"]
    by_path = Map.new(repos, &{&1["path"], &1})
    assert by_path[fixture.store]["status"] == "up_to_date"
    assert by_path[non_git_real]["status"] == "error"
    assert is_binary(by_path[non_git_real]["reason"]) and by_path[non_git_real]["reason"] != ""
  end
end
