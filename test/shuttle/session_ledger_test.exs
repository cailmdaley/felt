defmodule Shuttle.SessionLedgerTest do
  @moduledoc """
  The session ledger's own behavior: what gets written, what gets refused, and
  what comes back out.

  The three writer *sites* (dispatch, claim, resume) are asserted through the
  real code paths in `Shuttle.DispatchIntegrationTest` and `Shuttle.PollerTest`;
  this file pins the record shape and the read path.
  """
  # Sync: `default_path/0`'s test mutates SHUTTLE_SESSIONS_FILE / SHUTTLE_DATA_DIR,
  # which every other test's ledger resolution reads.
  use ExUnit.Case, async: false

  alias Shuttle.SessionLedger

  setup do
    path =
      Path.join(System.tmp_dir!(), "shuttle_ledger_#{System.unique_integer([:positive])}.jsonl")

    on_exit(fn ->
      File.rm(path)
      File.rm(path <> ".1")
    end)

    {:ok, path: path}
  end

  defp lines(path), do: path |> File.read!() |> String.split("\n", trim: true)
  defp decoded(path), do: Enum.map(lines(path), &Jason.decode!/1)

  describe "record/1" do
    test "writes one line carrying the whole pairing", %{path: path} do
      SessionLedger.record(
        path: path,
        fiber: "work/paper/edits",
        session: "0883ade1-08e0-4457-94c6-7ac12137eb0f",
        tmux: "edits-01KTS261GJMMRDRHS2QDMEFV3K-shuttle",
        harness: "claude-code",
        host: "dapmcw68",
        at: 1_786_203_000_000,
        kind: :dispatch
      )

      assert [record] = decoded(path)

      assert record == %{
               "fiber" => "work/paper/edits",
               "uid" => "01KTS261GJMMRDRHS2QDMEFV3K",
               "session" => "0883ade1-08e0-4457-94c6-7ac12137eb0f",
               "harness" => "claude-code",
               "host" => "dapmcw68",
               "tmux" => "edits-01KTS261GJMMRDRHS2QDMEFV3K-shuttle",
               "at" => 1_786_203_000_000,
               "kind" => "dispatch"
             }
    end

    test "derives the fiber uid from the tmux session name", %{path: path} do
      SessionLedger.record(
        path: path,
        fiber: "f",
        session: "s",
        tmux: "morning-post-01KTCA2CY6X6P126ZMBK9686SH-shuttle",
        kind: :dispatch
      )

      assert [%{"uid" => "01KTCA2CY6X6P126ZMBK9686SH"}] = decoded(path)
    end

    test "prefers an explicitly supplied uid over the tmux-derived one", %{path: path} do
      SessionLedger.record(
        path: path,
        fiber: "f",
        session: "s",
        uid: "01EXPLICITUID00000000000000",
        tmux: "leaf-01KTCA2CY6X6P126ZMBK9686SH-shuttle",
        kind: :claim
      )

      assert [%{"uid" => "01EXPLICITUID00000000000000"}] = decoded(path)
    end

    test "nils the uid when the tmux name carries no ULID", %{path: path} do
      SessionLedger.record(
        path: path,
        fiber: "f",
        session: "s",
        tmux: "leaf-shuttle",
        kind: :claim
      )

      assert [%{"uid" => nil, "tmux" => "leaf-shuttle"}] = decoded(path)
    end

    test "stamps `at` and `host` when not supplied", %{path: path} do
      before = System.system_time(:millisecond)
      SessionLedger.record(path: path, fiber: "f", session: "s", kind: :dispatch)

      assert [%{"at" => at, "host" => host}] = decoded(path)
      assert at >= before and at <= System.system_time(:millisecond)
      # config/test.exs pins SHUTTLE_HOST for the suite.
      assert host == Shuttle.Poller.own_host_id()
    end

    test "accepts each of the three kinds, as atom or string", %{path: path} do
      for kind <- [:dispatch, :claim, :resume, "dispatch", "claim", "resume"] do
        SessionLedger.record(path: path, fiber: "f", session: "s", kind: kind)
      end

      assert Enum.map(decoded(path), & &1["kind"]) ==
               ~w(dispatch claim resume dispatch claim resume)
    end

    test "refuses a record with no session uuid — an unpaired line is the thing this file rules out",
         %{path: path} do
      SessionLedger.record(path: path, fiber: "f", session: nil, kind: :dispatch)
      SessionLedger.record(path: path, fiber: "f", session: "", kind: :dispatch)

      refute File.exists?(path)
    end

    test "refuses a record with no fiber or an unknown kind", %{path: path} do
      SessionLedger.record(path: path, fiber: nil, session: "s", kind: :dispatch)
      SessionLedger.record(path: path, fiber: "", session: "s", kind: :dispatch)
      SessionLedger.record(path: path, fiber: "f", session: "s", kind: :invented)
      SessionLedger.record(path: path, fiber: "f", session: "s", kind: nil)

      refute File.exists?(path)
    end

    test "appends rather than truncating", %{path: path} do
      for i <- 1..3,
          do: SessionLedger.record(path: path, fiber: "f#{i}", session: "s#{i}", kind: :dispatch)

      assert length(lines(path)) == 3
      assert Enum.map(decoded(path), & &1["fiber"]) == ["f1", "f2", "f3"]
    end

    test "an unwritable path is swallowed, not raised — a ledger append cannot fail a dispatch" do
      assert SessionLedger.record(
               path: "/proc/nonexistent/sessions.jsonl",
               fiber: "f",
               session: "s",
               kind: :dispatch
             ) == :ok
    end
  end

  describe "read_since/2" do
    test "returns everything at or after the bound, oldest first", %{path: path} do
      for {fiber, at} <- [{"old", 100}, {"edge", 200}, {"new", 300}] do
        SessionLedger.record(
          path: path,
          fiber: fiber,
          session: "s-#{fiber}",
          at: at,
          kind: :dispatch
        )
      end

      assert Enum.map(SessionLedger.read_since(200, path: path), & &1["fiber"]) == ["edge", "new"]

      assert Enum.map(SessionLedger.read_since(0, path: path), & &1["fiber"]) == [
               "old",
               "edge",
               "new"
             ]

      assert SessionLedger.read_since(301, path: path) == []
    end

    test "reads the rotated sibling too, and orders across both files", %{path: path} do
      File.write!(
        path <> ".1",
        Enum.join(
          [
            Jason.encode!(%{
              "fiber" => "rotated",
              "session" => "s1",
              "at" => 100,
              "kind" => "dispatch"
            }),
            Jason.encode!(%{
              "fiber" => "rotated-late",
              "session" => "s2",
              "at" => 250,
              "kind" => "claim"
            })
          ],
          "\n"
        ) <> "\n"
      )

      SessionLedger.record(path: path, fiber: "live", session: "s3", at: 200, kind: :dispatch)

      assert Enum.map(SessionLedger.read_since(150, path: path), & &1["fiber"]) ==
               ["live", "rotated-late"]
    end

    test "skips malformed lines, blank lines, and records with no usable `at`", %{path: path} do
      File.write!(
        path,
        Enum.join(
          [
            "{ not json at all",
            "",
            "   ",
            Jason.encode!(%{"fiber" => "no-at", "session" => "s"}),
            Jason.encode!(%{"fiber" => "string-at", "session" => "s", "at" => "100"}),
            Jason.encode!(%{
              "fiber" => "good",
              "session" => "s",
              "at" => 100,
              "kind" => "dispatch"
            })
          ],
          "\n"
        ) <> "\n"
      )

      assert Enum.map(SessionLedger.read_since(0, path: path), & &1["fiber"]) == ["good"]
    end

    test "an absent ledger reads as empty", %{path: path} do
      assert SessionLedger.read_since(0, path: path) == []
    end
  end

  describe "latest_for_uid/2" do
    test "returns the newest session-bearing line for the fiber's uid", %{path: path} do
      uid = "01KTS261GJMMRDRHS2QDMEFV3K"

      for {session, at} <- [
            {"aaaaaaaa-0000-0000-0000-000000000001", 1_000},
            {"bbbbbbbb-0000-0000-0000-000000000002", 2_000}
          ] do
        SessionLedger.record(
          path: path,
          fiber: "work/paper/edits",
          uid: uid,
          session: session,
          harness: "claude-code",
          host: "dapmcw68",
          at: at,
          kind: :dispatch
        )
      end

      # A different fiber's newer line must not shadow ours.
      SessionLedger.record(
        path: path,
        fiber: "other/fiber",
        uid: "01KTS261GJMMRDRHS2QDMEFVXX",
        session: "cccccccc-0000-0000-0000-000000000003",
        harness: "codex",
        host: "dapmcw68",
        at: 3_000,
        kind: :dispatch
      )

      assert %{"session" => "bbbbbbbb-0000-0000-0000-000000000002", "harness" => "claude-code"} =
               SessionLedger.latest_for_uid(uid, path: path)
    end

    test "nil for an unknown uid, a blank uid, or nil", %{path: path} do
      assert SessionLedger.latest_for_uid("01KTS261GJMMRDRHS2QDMEFVZZ", path: path) == nil
      assert SessionLedger.latest_for_uid("", path: path) == nil
      assert SessionLedger.latest_for_uid(nil, path: path) == nil
    end
  end

  describe "harness_for_cli/1" do
    test "maps the registry's cli to the harness name, and refuses to guess" do
      assert SessionLedger.harness_for_cli("claude") == "claude-code"
      assert SessionLedger.harness_for_cli("codex") == "codex"
      assert SessionLedger.harness_for_cli("pi") == "pi"
      assert SessionLedger.harness_for_cli("something-else") == nil
      assert SessionLedger.harness_for_cli(nil) == nil
    end
  end

  describe "default_path/0" do
    test "honors SHUTTLE_SESSIONS_FILE, then SHUTTLE_DATA_DIR, then ~/.shuttle" do
      previous = Map.new(~w(SHUTTLE_SESSIONS_FILE SHUTTLE_DATA_DIR), &{&1, System.get_env(&1)})

      on_exit(fn ->
        Enum.each(previous, fn {k, v} ->
          if v, do: System.put_env(k, v), else: System.delete_env(k)
        end)
      end)

      System.put_env("SHUTTLE_SESSIONS_FILE", "/explicit/sessions.jsonl")
      assert SessionLedger.default_path() == "/explicit/sessions.jsonl"

      System.delete_env("SHUTTLE_SESSIONS_FILE")
      System.put_env("SHUTTLE_DATA_DIR", "/data")
      assert SessionLedger.default_path() == "/data/sessions.jsonl"

      System.delete_env("SHUTTLE_DATA_DIR")
      assert SessionLedger.default_path() =~ ~r{/\.shuttle/sessions\.jsonl$}
    end
  end
end
