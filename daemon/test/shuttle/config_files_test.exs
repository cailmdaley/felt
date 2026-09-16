defmodule Shuttle.ConfigFilesTest do
  @moduledoc """
  `Shuttle.ConfigFiles` — the four operator files as addressable bytes.

  Every test points ALL FOUR `*_FILE` env vars at throwaway paths and clears the
  two compact `FELT_STORES` / `FELT_PROJECTS` forms, so nothing here can read or
  write the developer's real `~/.config/felt/` — nor the suite-wide fixtures
  `test_helper.exs` pins `FELT_AGENTS_FILE` / `FELT_REMOTES_FILE` at, which this
  module would otherwise happily overwrite.

  The felt shell-out `validate/2` runs for `:remotes` / `:agents` is stubbed at
  the `:felt_runner` seam, so a real felt on the developer's PATH never decides
  whether these tests pass.
  """
  use ExUnit.Case, async: false
  import Shuttle.Test.EnvHelpers

  alias Shuttle.ConfigFiles

  # Each file's path override, in `ConfigFiles.ids/0` order.
  @file_vars [
    stores: "FELT_STORES_FILE",
    projects: "FELT_PROJECTS_FILE",
    agents: "FELT_AGENTS_FILE",
    remotes: "FELT_REMOTES_FILE"
  ]

  # The two compact comma-separated forms — the only ones that exist.
  @compact_vars [stores: "FELT_STORES", projects: "FELT_PROJECTS"]

  @stores_doc ~s({"version":1,"felt_stores":["/tmp/one","/tmp/two"]})

  # A felt that records what it was asked — argv, the env override, and the
  # bytes staged at the path that override names AT CALL TIME — and answers
  # from a script. The staged read has to happen inside `cmd/3`: the candidate
  # is deleted the moment `validate/2` returns, which is the point of test
  # "cleans up the candidate".
  defmodule MockFelt do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []),
      do:
        Agent.start_link(
          fn -> %{reply: fn _call -> {"", 0} end, calls: []} end,
          name: __MODULE__
        )

    @doc "Script the reply. `fun` receives the recorded call, so it can echo the candidate's path."
    def reply_with(fun), do: Agent.update(__MODULE__, &Map.put(&1, :reply, fun))

    def calls, do: Agent.get(__MODULE__, & &1.calls)
    def last, do: calls() |> List.last()

    @impl true
    def cmd(command, args, opts) do
      tmp =
        case Keyword.get(opts, :env, []) do
          [{_var, path} | _] -> path
          _ -> nil
        end

      call = %{
        command: command,
        args: args,
        env: Keyword.get(opts, :env, []),
        opts: opts,
        tmp: tmp,
        staged: tmp && File.read(tmp)
      }

      Agent.update(__MODULE__, fn state -> %{state | calls: state.calls ++ [call]} end)
      Agent.get(__MODULE__, & &1.reply).(call)
    end
  end

  setup do
    previous_files = Enum.map(@file_vars, fn {_id, var} -> {var, System.get_env(var)} end)
    previous_compact = Enum.map(@compact_vars, fn {_id, var} -> {var, System.get_env(var)} end)
    previous_runner = Application.get_env(:shuttle, :felt_runner)

    dir =
      Path.join(System.tmp_dir!(), "shuttle-config-files-#{System.unique_integer([:positive])}")

    File.mkdir_p!(dir)

    paths =
      Map.new(@file_vars, fn {id, var} ->
        path = Path.join(dir, "#{id}.json")
        System.put_env(var, path)
        {id, Path.expand(path)}
      end)

    # The compact forms win over the files ENTIRELY, so an operator shell
    # exporting one would leak into every `env_override` assertion below.
    Enum.each(@compact_vars, fn {_id, var} -> System.delete_env(var) end)

    Application.put_env(:shuttle, :felt_runner, MockFelt)
    start_supervised!(MockFelt)

    on_exit(fn ->
      File.rm_rf(dir)
      Enum.each(previous_files, fn {var, value} -> restore_env(var, value) end)
      Enum.each(previous_compact, fn {var, value} -> restore_env(var, value) end)
      restore_app_env(:felt_runner, previous_runner)
    end)

    {:ok, dir: dir, paths: paths}
  end

  describe "parse_id/1" do
    test "accepts the four file stems, which are also `ids/0`" do
      assert ConfigFiles.parse_id("stores") == {:ok, :stores}
      assert ConfigFiles.parse_id("projects") == {:ok, :projects}
      assert ConfigFiles.parse_id("agents") == {:ok, :agents}
      assert ConfigFiles.parse_id("remotes") == {:ok, :remotes}

      assert ConfigFiles.ids() == [:stores, :projects, :agents, :remotes]
    end

    test "rejects anything it does not name" do
      for raw <- ["", "store", "Stores", "stores.json", "remotes ", "host", "../stores"] do
        assert ConfigFiles.parse_id(raw) == :error, "expected #{inspect(raw)} to be refused"
      end
    end
  end

  describe "path/1" do
    test "honours each file's own *_FILE override", %{paths: paths} do
      for id <- ConfigFiles.ids() do
        assert ConfigFiles.path(id) == paths[id]
      end
    end

    test "falls back to ~/.config/felt/<stem>.json when nothing overrides it" do
      # Cleared and restored in one breath: while a `*_FILE` var is absent every
      # other reader in the VM resolves at the developer's real config, and this
      # suite's whole job is to never go near it.
      previous = Enum.map(@file_vars, fn {_id, var} -> {var, System.get_env(var)} end)
      Enum.each(@file_vars, fn {_id, var} -> System.delete_env(var) end)
      resolved = Map.new(ConfigFiles.ids(), &{&1, ConfigFiles.path(&1)})
      Enum.each(previous, fn {var, value} -> restore_env(var, value) end)

      assert resolved == %{
               stores: Path.expand("~/.config/felt/stores.json"),
               projects: Path.expand("~/.config/felt/projects.json"),
               agents: Path.expand("~/.config/felt/agents.json"),
               remotes: Path.expand("~/.config/felt/remotes.json")
             }
    end
  end

  describe "summary/1" do
    test "a file that does not exist is a state, not a failure", %{paths: paths} do
      assert ConfigFiles.summary(:remotes) == %{
               id: :remotes,
               path: paths[:remotes],
               exists: false,
               size: 0,
               updated_at: nil,
               env_override: nil,
               digest: nil
             }
    end

    test "a present file reports its real size and mtime", %{paths: paths} do
      File.write!(paths[:stores], @stores_doc)

      summary = ConfigFiles.summary(:stores)

      assert summary.exists == true
      assert summary.size == byte_size(@stores_doc)
      assert is_integer(summary.updated_at)
      assert summary.updated_at == File.stat!(paths[:stores], time: :posix).mtime
    end

    test "names the compact env form overriding a path-list file" do
      System.put_env("FELT_STORES", "/tmp/a,/tmp/b")
      System.put_env("FELT_PROJECTS", "/tmp/c")
      on_exit(fn -> Enum.each(@compact_vars, fn {_id, var} -> System.delete_env(var) end) end)

      assert ConfigFiles.summary(:stores).env_override == %{
               var: "FELT_STORES",
               value: "/tmp/a,/tmp/b"
             }

      assert ConfigFiles.summary(:projects).env_override == %{
               var: "FELT_PROJECTS",
               value: "/tmp/c"
             }
    end

    test "the fleet and agent files never report one — they have no compact form" do
      # Even with same-named variables exported, which a confused operator will
      # do sooner or later: `FELT_REMOTES` is not a thing felt reads, and saying
      # it overrode the file would be a lie in the other direction.
      System.put_env("FELT_REMOTES", "/tmp/a,/tmp/b")
      System.put_env("FELT_AGENTS", "/tmp/c")
      on_exit(fn -> Enum.each(["FELT_REMOTES", "FELT_AGENTS"], &System.delete_env/1) end)

      assert ConfigFiles.summary(:remotes).env_override == nil
      assert ConfigFiles.summary(:agents).env_override == nil
    end
  end

  describe "digest/1" do
    test "is a content hash that moves with the bytes, and nil when there is no file", %{
      paths: paths
    } do
      assert ConfigFiles.digest(:stores) == nil

      File.write!(paths[:stores], @stores_doc)
      digest = ConfigFiles.digest(:stores)

      assert digest == :crypto.hash(:sha256, @stores_doc) |> Base.encode16(case: :lower)
      assert ConfigFiles.summary(:stores).digest == digest

      # An mtime is second-granular; a hash is not. Two writes inside the same
      # second must still read as two different files.
      File.write!(paths[:stores], ~s({"version":1,"felt_stores":["/tmp/three"]}))
      refute ConfigFiles.digest(:stores) == digest
    end
  end

  describe "read/1" do
    test "an absent file reads as empty text rather than an error", %{paths: paths} do
      assert {:ok, file} = ConfigFiles.read(:remotes)
      assert file.text == ""
      assert file.exists == false
      assert file.path == paths[:remotes]
    end

    test "a present file reads its bytes verbatim, alongside its summary row", %{paths: paths} do
      File.write!(paths[:agents], @stores_doc)

      assert {:ok, file} = ConfigFiles.read(:agents)
      assert file.text == @stores_doc
      assert file.exists == true
      assert file.size == byte_size(@stores_doc)
    end
  end

  describe "write/2" do
    test "commits atomically, leaving no staging file behind", %{dir: dir, paths: paths} do
      assert {:ok, file} = ConfigFiles.write(:stores, @stores_doc)

      assert file.text == @stores_doc
      assert file.exists == true
      assert File.read!(paths[:stores]) == @stores_doc
      # The whole directory, not just `<path>.tmp` — what matters is that the
      # staging copy is gone, whatever it was called.
      assert File.ls!(dir) == ["stores.json"]
    end

    test "leaves no staging file behind when the commit itself fails", %{dir: dir, paths: paths} do
      # A directory where the file belongs: the staging write succeeds and the
      # rename onto it cannot, which is the only branch that can strand one.
      File.mkdir_p!(paths[:stores])

      assert {:error, message} = ConfigFiles.write(:stores, @stores_doc)
      assert message =~ paths[:stores]
      assert File.ls!(dir) == ["stores.json"]
    end

    test "whitespace-only text removes the file", %{paths: paths} do
      File.write!(paths[:remotes], @stores_doc)

      assert {:ok, file} = ConfigFiles.write(:remotes, "  \n\t ")
      assert file.exists == false
      assert file.text == ""
      assert file.size == 0
      assert file.digest == nil
      refute File.exists?(paths[:remotes])
    end

    test "removing a file that is already absent is a success, not an error" do
      assert {:ok, file} = ConfigFiles.write(:remotes, "")
      assert file.exists == false
    end

    test "a refused write leaves the file byte-identical", %{dir: dir, paths: paths} do
      File.write!(paths[:stores], @stores_doc)

      assert {:error, _} = ConfigFiles.write(:stores, ~s({"felt_stores":["/tmp/one",42]}))

      assert File.read!(paths[:stores]) == @stores_doc
      assert File.ls!(dir) == ["stores.json"]
    end
  end

  describe "write/3 with an expected digest" do
    setup %{paths: paths} do
      File.write!(paths[:stores], @stores_doc)
      {:ok, digest: ConfigFiles.digest(:stores)}
    end

    test "a digest matching what is on disk commits", %{paths: paths, digest: digest} do
      replacement = ~s({"version":1,"felt_stores":["/tmp/new"]})

      assert {:ok, file} = ConfigFiles.write(:stores, replacement, expected_digest: digest)
      assert file.text == replacement
      assert File.read!(paths[:stores]) == replacement
    end

    test "a stale digest is refused and writes nothing", %{paths: paths} do
      stale = String.duplicate("0", 64)

      assert {:error, message} = ConfigFiles.write(:stores, "[]", expected_digest: stale)
      assert message =~ "changed since you opened it"
      assert File.read!(paths[:stores]) == @stores_doc
    end

    test "a digest for a file deleted underneath the editor says so", %{
      paths: paths,
      digest: digest
    } do
      File.rm!(paths[:stores])

      assert {:error, message} = ConfigFiles.write(:stores, "[]", expected_digest: digest)
      assert message =~ "was deleted since you opened it"
      refute File.exists?(paths[:stores])
    end

    test "nil against an absent file is an editor that correctly read nothing", %{paths: paths} do
      File.rm!(paths[:stores])

      assert {:ok, file} = ConfigFiles.write(:stores, @stores_doc, expected_digest: nil)
      assert file.text == @stores_doc
      assert File.read!(paths[:stores]) == @stores_doc
    end

    test "nil against a file that DOES exist is a conflict", %{paths: paths} do
      assert {:error, message} = ConfigFiles.write(:stores, "[]", expected_digest: nil)
      assert message =~ "changed since you opened it"
      assert File.read!(paths[:stores]) == @stores_doc
    end

    test "the default is :any — last-write-wins, for a caller that said nothing", %{paths: paths} do
      assert {:ok, _} = ConfigFiles.write(:stores, "[]")
      assert File.read!(paths[:stores]) == "[]"
    end

    test "a stale digest refuses a REMOVAL too", %{paths: paths} do
      stale = String.duplicate("0", 64)

      assert {:error, message} = ConfigFiles.write(:stores, "", expected_digest: stale)
      assert message =~ "changed since you opened it"
      assert File.read!(paths[:stores]) == @stores_doc
    end
  end

  describe "validate/2" do
    test "rejects text that is not JSON at all" do
      for id <- ConfigFiles.ids() do
        assert {:error, message} = ConfigFiles.validate(id, "{not json")
        assert message =~ "not valid JSON"
      end
    end
  end

  describe "validate/2 for the path-list files" do
    test "accepts the {version, key} document and a bare array" do
      assert ConfigFiles.validate(:stores, @stores_doc) == :ok
      assert ConfigFiles.validate(:stores, ~s(["/tmp/one","/tmp/two"])) == :ok

      assert ConfigFiles.validate(:projects, ~s({"version":1,"projects":["/tmp/talks"]})) == :ok
      assert ConfigFiles.validate(:projects, ~s([])) == :ok
    end

    test "names the index of an entry that is not a path string" do
      assert ConfigFiles.validate(:stores, ~s({"felt_stores":["/tmp/one",42]})) ==
               {:error, ~s("felt_stores"[1] is not a string — every entry must be a path)}

      assert ConfigFiles.validate(:projects, ~s([null,"/tmp/talks"])) ==
               {:error, ~s("projects"[0] is not a string — every entry must be a path)}
    end

    test "rejects an object of the wrong shape, naming the shape it wanted" do
      assert ConfigFiles.validate(:stores, ~s({"version":1,"stores":["/tmp/one"]})) ==
               {:error,
                ~s(expected an object with a "felt_stores" array, or a bare array of paths)}

      assert ConfigFiles.validate(:stores, ~s({"felt_stores":"/tmp/one"})) ==
               {:error,
                ~s(expected an object with a "felt_stores" array, or a bare array of paths)}

      assert ConfigFiles.validate(:projects, ~s("just a string")) ==
               {:error, ~s(expected an object with a "projects" array, or a bare array of paths)}
    end

    test "never shells felt — no CLI verb reads these files" do
      assert ConfigFiles.validate(:stores, @stores_doc) == :ok
      assert ConfigFiles.validate(:projects, ~s([])) == :ok
      assert MockFelt.calls() == []
    end
  end

  describe "validate/2 for the felt-owned files" do
    @remotes_doc ~s({"remotes":[{"name":"candide","port":4001}]})
    @agents_doc ~s({"version":1,"agents":[]})

    test "stages the candidate and points felt's own *_FILE var at it" do
      assert ConfigFiles.validate(:remotes, @remotes_doc) == :ok

      call = MockFelt.last()
      assert call.command == "felt"
      assert call.args == ["shuttle", "remotes", "list", "--json"]
      assert [{"FELT_REMOTES_FILE", tmp}] = call.env
      assert call.opts[:timeout_ms] == 15_000
      assert call.opts[:stderr_to_stdout] == true

      # A throwaway copy, never the real file: what felt reads back is exactly
      # the bytes the caller sent, and a refused edit cannot have touched disk.
      assert tmp == call.tmp
      assert String.starts_with?(tmp, Path.join(System.tmp_dir!(), "shuttle-config-check"))
      refute tmp == ConfigFiles.path(:remotes)
      assert call.staged == {:ok, @remotes_doc}
    end

    test "asks the agents verb about the agents file, under FELT_AGENTS_FILE" do
      assert ConfigFiles.validate(:agents, @agents_doc) == :ok

      call = MockFelt.last()
      assert call.args == ["shuttle", "agents", "--json"]
      assert [{"FELT_AGENTS_FILE", tmp}] = call.env
      refute tmp == ConfigFiles.path(:agents)
      assert call.staged == {:ok, @agents_doc}
    end

    test "a non-zero exit becomes felt's own stdout, verbatim" do
      MockFelt.reply_with(fn _call ->
        {~s(remote "hub-a": port 4001 already used by "hub-b"\n), 1}
      end)

      assert ConfigFiles.validate(:remotes, @remotes_doc) ==
               {:error, ~s(remote "hub-a": port 4001 already used by "hub-b")}
    end

    test "scrubs the candidate's path out of the message" do
      # felt names the file it was reading, and that file is our temporary copy
      # — a path the human has never seen and cannot act on.
      MockFelt.reply_with(fn call ->
        {"#{call.tmp}: duplicate remote \"hub-a\"\n", 1}
      end)

      assert ConfigFiles.validate(:remotes, @remotes_doc) ==
               {:error, ~s(duplicate remote "hub-a")}

      MockFelt.reply_with(fn call -> {"could not read #{call.tmp} while checking", 1} end)

      assert ConfigFiles.validate(:remotes, @remotes_doc) ==
               {:error, "could not read the candidate while checking"}
    end

    test "cleans up the candidate whether felt accepts or refuses" do
      assert ConfigFiles.validate(:remotes, @remotes_doc) == :ok
      accepted = MockFelt.last()
      assert accepted.staged == {:ok, @remotes_doc}
      refute File.exists?(accepted.tmp)

      MockFelt.reply_with(fn _call -> {"nope", 1} end)
      assert {:error, "nope"} = ConfigFiles.validate(:remotes, @remotes_doc)
      refused = MockFelt.last()
      assert refused.staged == {:ok, @remotes_doc}
      refute File.exists?(refused.tmp)
    end

    test "a refused candidate leaves the real file byte-identical", %{dir: dir, paths: paths} do
      File.write!(paths[:remotes], @remotes_doc)
      MockFelt.reply_with(fn _call -> {"nope", 1} end)

      assert {:error, "nope"} = ConfigFiles.write(:remotes, ~s({"remotes":[]}))

      assert File.read!(paths[:remotes]) == @remotes_doc
      assert File.ls!(dir) == ["remotes.json"]
    end
  end

  describe "index/0" do
    test "is one summary row per id, in reading order", %{paths: paths} do
      File.write!(paths[:stores], @stores_doc)

      rows = ConfigFiles.index()

      assert Enum.map(rows, & &1.id) == ConfigFiles.ids()
      assert Enum.map(rows, & &1.path) == Enum.map(ConfigFiles.ids(), &paths[&1])
      assert Enum.map(rows, & &1.exists) == [true, false, false, false]
    end
  end
end
