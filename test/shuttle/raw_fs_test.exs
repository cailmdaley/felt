defmodule Shuttle.RawFSTest do
  use ExUnit.Case, async: true

  alias Shuttle.RawFS

  # These functions exist to be used INSTEAD of `File.*` on every path the
  # daemon might stall on, so the contract that matters is that they answer the
  # same question. A divergence here would be silent: the daemon would keep
  # running and quietly disagree with itself about what is on disk.
  describe "parity with the File.* calls they replace" do
    setup do
      dir = Path.join(System.tmp_dir!(), "raw_fs_test_#{System.unique_integer([:positive])}")
      File.mkdir_p!(Path.join(dir, "sub"))
      File.write!(Path.join(dir, "file.txt"), "contents\n")
      File.ln_s!(Path.join(dir, "file.txt"), Path.join(dir, "link"))
      File.ln_s!(Path.join(dir, "nowhere"), Path.join(dir, "dangling"))
      on_exit(fn -> File.rm_rf!(dir) end)
      {:ok, dir: dir}
    end

    test "ls returns File.ls's names", %{dir: dir} do
      assert {:ok, raw} = RawFS.ls(dir)
      assert {:ok, cooked} = File.ls(dir)
      assert Enum.sort(raw) == Enum.sort(cooked)
      assert RawFS.ls(Path.join(dir, "nope")) == File.ls(Path.join(dir, "nope"))
    end

    test "dir?, regular? and exists? agree with File", %{dir: dir} do
      for path <- ["sub", "file.txt", "link", "dangling", "nope"] do
        full = Path.join(dir, path)
        assert RawFS.dir?(full) == File.dir?(full), "dir? disagreed on #{path}"
        assert RawFS.regular?(full) == File.regular?(full), "regular? disagreed on #{path}"
        assert RawFS.exists?(full) == File.exists?(full), "exists? disagreed on #{path}"
      end
    end

    test "lstat sees the symlink where stat sees through it", %{dir: dir} do
      assert {:ok, %{type: :symlink}} = RawFS.lstat(Path.join(dir, "link"))
      assert {:ok, %{type: :regular, size: 9}} = RawFS.stat(Path.join(dir, "link"))
      assert {:error, :enoent} = RawFS.stat(Path.join(dir, "dangling"))
      assert {:ok, %{type: :symlink}} = RawFS.lstat(Path.join(dir, "dangling"))
    end

    test "stat carries the same posix mtime File does", %{dir: dir} do
      path = Path.join(dir, "file.txt")
      assert {:ok, %{mtime: raw}} = RawFS.stat(path)
      assert {:ok, %File.Stat{mtime: cooked}} = File.stat(path, time: :posix)
      assert raw == cooked
    end

    test "read and read_link match File", %{dir: dir} do
      assert RawFS.read(Path.join(dir, "file.txt")) == File.read(Path.join(dir, "file.txt"))
      assert RawFS.read(Path.join(dir, "nope")) == File.read(Path.join(dir, "nope"))
      assert {:ok, target} = RawFS.read_link(Path.join(dir, "link"))
      assert target == Path.join(dir, "file.txt")
      assert {:error, _} = RawFS.read_link(Path.join(dir, "file.txt"))
    end

    test "write and rename land the same bytes File would", %{dir: dir} do
      source = Path.join(dir, "written.txt")
      assert RawFS.write(source, ["one\n", "two\n"]) == :ok
      assert File.read!(source) == "one\ntwo\n"

      destination = Path.join(dir, "renamed.txt")
      assert RawFS.rename(source, destination) == :ok
      assert File.read!(destination) == "one\ntwo\n"
      refute File.exists?(source)

      assert {:error, :enoent} = RawFS.write(Path.join(dir, "no/such/dir/f.txt"), "x")
      assert {:error, :enoent} = RawFS.rename(source, destination)
    end

    test "mkdir_p creates parents, is idempotent, and refuses a path through a file",
         %{dir: dir} do
      deep = Path.join([dir, "a", "b", "c"])
      assert RawFS.mkdir_p(deep) == :ok
      assert File.dir?(deep)
      assert RawFS.mkdir_p(deep) == :ok
      assert RawFS.mkdir_p(dir) == File.mkdir_p(dir)

      # A regular file where a directory belongs fails — the atom differs from
      # `File.mkdir_p/1`'s (`:eexist` vs `:enotdir`), which the moduledoc says
      # out loud; that both refuse is the part callers rely on.
      assert {:error, _} = RawFS.mkdir_p(Path.join(dir, "file.txt"))
      assert {:error, _} = RawFS.mkdir_p(Path.join([dir, "file.txt", "sub"]))
    end

    test "find_executable matches System.find_executable, hits and misses alike" do
      for command <- ["sh", "ls", "env", "definitely-not-installed-#{System.unique_integer()}"] do
        assert RawFS.find_executable(command) == System.find_executable(command),
               "disagreed on #{command}"
      end
    end

    # `:os.find_executable/1` joins a relative name onto each PATH entry even
    # when it contains a slash — it does NOT resolve against the current
    # directory. Diverging here would make the daemon run binaries the stock
    # resolver refuses to find, which matters because command names can come
    # from the agent registry.
    test "find_executable handles an explicit path the way System.cmd would" do
      assert RawFS.find_executable("/bin/sh") == "/bin/sh"
      assert RawFS.find_executable("/bin/definitely-not-here") == nil
      # A directory is not an executable, even though it exists and is +x.
      assert RawFS.find_executable("/bin") == nil
    end
  end
end
