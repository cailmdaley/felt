defmodule Shuttle.FSTest do
  use ExUnit.Case, async: true
  alias Shuttle.FS
  @moduletag :tmp_dir

  test "private writes refuse existing files and symlinks", %{tmp_dir: root} do
    target = Path.join(root, "target")
    link = Path.join(root, "link")
    File.write!(target, "unchanged")
    File.ln_s!(target, link)

    assert {:error, :eexist} = FS.write_private(target, "secret")
    assert {:error, :eexist} = FS.write_private(link, "secret")
    assert File.read!(target) == "unchanged"
  end

  test "private writes create owner-only files", %{tmp_dir: root} do
    for mode <- [0o600, 0o700] do
      path = Path.join(root, Integer.to_string(mode))
      assert :ok = FS.write_private(path, "secret", mode)
      assert File.read!(path) == "secret"
      assert {:ok, %{mode: actual}} = File.stat(path)
      assert Bitwise.band(actual, 0o777) == mode
    end
  end

  test "raw operations work while the shared file server is suspended", %{tmp_dir: root} do
    # A separate VM avoids stopping the test runner's own code loader.
    script = ~S"""
    root = System.fetch_env!("FS_TEST_ROOT")
    :ok = :sys.suspend(:file_server_2)
    try do
      alias Shuttle.FS
      :ok = FS.mkdir_p(root <> "/nested")
      path = root <> "/nested/data"
      :ok = FS.write(path, "one\ntwo\n")
      {:ok, "one\ntwo\n"} = FS.read(path)
      {:ok, %{size: 8}} = FS.stat(path)
      {:ok, ["data"]} = FS.ls(root <> "/nested")
      ["one\n", "two\n"] = Enum.to_list(FS.stream!(path))
      [^path] = FS.wildcard(root <> "/**/data")
      :ok = FS.chmod(path, 0o600)
      :ok = FS.touch(path)
      :ok = FS.write_atomic(path, "atomic")
      {:ok, 6} = FS.copy(path, path <> ".copy")
      :ok = FS.rename(path, path <> ".moved")
      {:ok, _} = FS.rm_rf(root <> "/nested")
    after
      :sys.resume(:file_server_2)
    end
    IO.puts("raw-ok")
    """

    Code.ensure_loaded!(FS)
    # Load the wildcard backend and stream machinery before suspending the server.
    Enum.to_list(FS.stream!(__ENV__.file))
    FS.wildcard(root <> "/*")

    preload =
      "Code.ensure_loaded!(Shuttle.FS); Code.ensure_loaded!(Shuttle.FS.Wildcard); Enum.to_list(Shuttle.FS.stream!(\"#{__ENV__.file}\")); Shuttle.FS.wildcard(\"/nonexistent/*\");\n"

    {out, status} =
      System.cmd(
        "elixir",
        ["--erl", "+SDio 16", "-pa", Path.dirname(:code.which(FS)), "-e", preload <> script],
        env: [{"FS_TEST_ROOT", root}],
        stderr_to_stdout: true
      )

    assert status == 0, out
    assert out =~ "raw-ok"
  end

  test "default metadata is universal even in a negative-offset host zone", %{tmp_dir: root} do
    path = Path.join(root, "timestamps")
    File.write!(path, "data")

    script = ~S"""
    alias Shuttle.FS
    path = System.fetch_env!("FS_TEST_PATH")
    true = :calendar.local_time() != :calendar.universal_time()
    for {raw, normal} <- [{FS.stat(path), File.stat(path)}, {FS.lstat(path), File.lstat(path)}] do
      {:ok, raw} = raw
      {:ok, normal} = normal
      true = raw.mtime == normal.mtime
      true = raw.atime == normal.atime
    end
    {:ok, local} = FS.stat(path, time: :local)
    {:ok, universal} = FS.stat(path)
    true = local.mtime != universal.mtime
    {:ok, posix} = FS.stat(path, time: :posix)
    true = is_integer(posix.mtime)
    :ok = FS.touch(path)
    {:ok, touched} = File.stat(path, time: :posix)
    true = abs(touched.mtime - System.os_time(:second)) < 5
    IO.puts("utc-ok")
    """

    {out, status} =
      System.cmd("elixir", ["-pa", Path.dirname(:code.which(FS)), "-e", script],
        env: [{"TZ", "Etc/GMT+7"}, {"FS_TEST_PATH", path}],
        stderr_to_stdout: true
      )

    assert status == 0, out
    assert out =~ "utc-ok"
  end

  test "protected roots match components, not directory name prefixes", %{tmp_dir: root} do
    protected = Path.join(root, "Documents")
    assert FS.protected?(protected, [protected])
    assert FS.protected?(protected <> "/store", [protected])
    refute FS.protected?(protected <> "-public/store", [protected])
    refute FS.protected?(root, [protected])
  end

  test "empty directories and bang failures retain File result shapes", %{tmp_dir: root} do
    assert {:ok, []} = FS.ls(root)
    assert {:error, :enoent} = FS.read(root <> "/missing")
    assert_raise File.Error, fn -> FS.read!(root <> "/missing") end
  end

  if :os.type() == {:unix, :darwin} do
    test "store inventory excludes protected folders and aliases before walking them", %{
      tmp_dir: root
    } do
      Shuttle.Test.Env.put_env("HOME", root)
      protected = Path.join(root, "Documents/store")
      File.mkdir_p!(Path.join(protected, ".felt"))
      alias_path = Path.join(root, "alias")
      File.ln_s!(protected, alias_path)

      for store <- [protected, alias_path] do
        Shuttle.Test.Env.put_env("SHUTTLE_STORES", store)

        log =
          ExUnit.CaptureLog.capture_log(fn ->
            assert Shuttle.FeltStores.configured_stores() == []
          end)

        assert log =~ "Autonomous store walk excluded #{store}"

        assert [%{path: ^store, reason: "protected_folder"}] =
                 Shuttle.FeltStores.excluded_stores()

        conn = ShuttleWeb.VersionController.show(Plug.Test.conn(:get, "/api/v1/version"), %{})

        assert [%{"path" => ^store, "reason" => "protected_folder"}] =
                 Jason.decode!(conn.resp_body)["excluded_stores"]
      end
    end
  end

  test "raw line streams enable read-ahead and preserve an explicit buffer", %{tmp_dir: root} do
    path = Path.join(root, "events.jsonl")
    File.write!(path, :binary.copy("{\"event\":1}\n", 100_000))
    observer = self()

    worker =
      spawn(fn ->
        receive do
          :go ->
            for modes <- [[], [{:read_ahead, 8192}]] do
              send(observer, {:lines, Enum.count(Shuttle.FS.stream!(path, modes))})
            end
        end
      end)

    session = :trace.session_create(:stream_read_ahead, self(), [])
    :trace.function(session, {:file, :open, 2}, true, [:local])
    :trace.process(session, worker, true, [:call])

    try do
      send(worker, :go)
      assert_receive {:trace, ^worker, :call, {:file, :open, [^path, defaults]}}
      assert :raw in defaults
      assert :read_ahead in defaults
      assert_receive {:lines, 100_000}
      assert_receive {:trace, ^worker, :call, {:file, :open, [^path, explicit]}}
      assert {:read_ahead, 8192} in explicit
      refute :read_ahead in explicit
      assert_receive {:lines, 100_000}
    after
      :trace.session_destroy(session)
      Process.exit(worker, :kill)
    end
  end

  test "daemon file calls cannot bypass the raw boundary" do
    paths = Path.wildcard(Path.expand("../../lib/**/*.ex", __DIR__))
    boundary = Path.expand("../../lib/shuttle/fs.ex", __DIR__)

    violations =
      for path <- paths, path != boundary, reduce: [] do
        acc ->
          {_, found} =
            path
            |> File.read!()
            |> Code.string_to_quoted!()
            |> Macro.prewalk([], fn
              {{:., _, [{:__aliases__, _, [:File]}, name]}, meta, _args} = node, hits
              when is_atom(name) ->
                {node, [{path, meta[:line], name} | hits]}

              {{:., _, [:file, name]}, meta, _args} = node, hits ->
                {node, [{path, meta[:line], name} | hits]}

              {{:., _, [{:__aliases__, _, [:Path]}, :wildcard]}, meta, _args} = node, hits ->
                {node, [{path, meta[:line], :wildcard} | hits]}

              node, hits ->
                {node, hits}
            end)

          found ++ acc
      end

    assert violations == []
  end

  # procfs answers ENOENT for a new directory under /proc, a parent that exists;
  # mkdir_p must return that answer rather than recreate the parent forever.
  @tag :linux
  @tag timeout: 5_000
  test "mkdir_p returns ENOENT from a filesystem that refuses the directory" do
    assert FS.mkdir_p("/proc/nonexistent") == {:error, :enoent}
  end
end
