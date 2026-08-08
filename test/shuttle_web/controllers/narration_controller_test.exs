defmodule ShuttleWeb.NarrationControllerTest do
  @moduledoc """
  Reader + wiring for `GET /api/v1/narration` — the commit strip beside the
  temporal view.

  The reader (`Shuttle.Narration`) runs against real throwaway git repos built
  in tmp, because the thing under test *is* the `git log` invocation: the
  window bounds, their inclusivity, merge exclusion, and the degradation to
  `[]` when the store is unreachable. Every fixture commits at an explicit UTC
  instant and every window is built from UTC, so no test can pass or fail on
  the machine's timezone — which is the property the instant form exists for.
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  @identity ["-c", "user.name=Test", "-c", "user.email=test@example.com"]

  # A runner that forces git's timezone, so one test process can ask the same
  # question of two daemons-in-different-zones. Everything else defers to the
  # real bounded runner, so this exercises the production path.
  defmodule TzRunner do
    @behaviour Shuttle.Runner

    def cmd(command, args, opts) do
      zone = Process.get(:tz_runner_zone, "UTC")
      Shuttle.Runner.Default.cmd(command, args, Keyword.put(opts, :env, [{"TZ", zone}]))
    end
  end

  # Captures the argv and replays a canned result — for asserting the shape of
  # the bounds handed to git, and for simulating a wedged store.
  defmodule ScriptedRunner do
    @behaviour Shuttle.Runner
    use Agent

    def start_link(_ \\ []),
      do: Agent.start_link(fn -> %{result: {"", 0}, last_args: nil} end, name: __MODULE__)

    def script(result), do: Agent.update(__MODULE__, &Map.put(&1, :result, result))
    def last_args, do: Agent.get(__MODULE__, & &1.last_args)

    def cmd(_command, args, _opts) do
      Agent.update(__MODULE__, &Map.put(&1, :last_args, args))
      Agent.get(__MODULE__, & &1.result)
    end
  end

  # Echoes the options the reader passed, so a test can assert the call is
  # bounded without depending on the exact timeout value.
  defmodule TimeoutProbe do
    @behaviour Shuttle.Runner

    def cmd(_command, _args, opts) do
      send(self(), {:opts, opts})
      {"", 0}
    end
  end

  defp tmp_dir(prefix) do
    path = Path.join(System.tmp_dir!(), "#{prefix}_#{System.unique_integer([:positive])}")
    File.mkdir_p!(path)
    on_exit(fn -> File.rm_rf(path) end)
    path
  end

  defp git!(repo, args, env \\ []) do
    {out, status} =
      System.cmd("git", @identity ++ args, cd: repo, env: env, stderr_to_stdout: true)

    assert status == 0, "git #{Enum.join(args, " ")} failed: #{out}"
    out
  end

  defp commit!(repo, when_at, subject) do
    git!(repo, ["commit", "--allow-empty", "-q", "-m", subject], [
      {"GIT_AUTHOR_DATE", when_at},
      {"GIT_COMMITTER_DATE", when_at}
    ])
  end

  defp new_repo(prefix) do
    repo = tmp_dir(prefix)
    git!(repo, ["init", "-q", "-b", "main"])
    repo
  end

  # One empty commit per {instant, subject}. Chronological order matters:
  # `git log --since` prunes traversal when it meets a commit older than the
  # cutoff, so a repo built out of date order would answer nothing for reasons
  # unrelated to what is under test.
  defp repo_with_utc_commits(commits) do
    repo = new_repo("shuttle_narration_utc")
    for {instant, subject} <- commits, do: commit!(repo, instant, subject)
    repo
  end

  defp ms(iso) do
    {:ok, dt, _} = DateTime.from_iso8601(iso)
    DateTime.to_unix(dt, :millisecond)
  end

  defp subjects_between(repo, from_iso, to_iso, opts \\ []) do
    Shuttle.Narration.commits_between(
      ms(from_iso),
      ms(to_iso),
      Keyword.put(opts, :store_root, repo)
    )
    |> Enum.map(& &1.subject)
  end

  describe "Shuttle.Narration.commits_between/3 (instant form)" do
    test "returns the subjects inside the instant window, newest first, with an ISO date" do
      repo =
        repo_with_utc_commits([
          {"2026-08-04T12:00:00+00:00", "aug4: out"},
          {"2026-08-05T08:00:00+00:00", "morning: in"},
          {"2026-08-05T23:30:00+00:00", "late: in"},
          {"2026-08-07T12:00:00+00:00", "aug7: out"}
        ])

      commits =
        Shuttle.Narration.commits_between(
          ms("2026-08-05T00:00:00Z"),
          ms("2026-08-05T23:59:59Z"),
          store_root: repo
        )

      assert Enum.map(commits, & &1.subject) == ["late: in", "morning: in"]
      assert Enum.all?(commits, &match?({:ok, _, _}, DateTime.from_iso8601(&1.iso)))
    end

    test "both instant bounds are inclusive" do
      repo =
        repo_with_utc_commits([
          {"2026-08-05T00:00:00+00:00", "at-from: in"},
          {"2026-08-05T12:00:00+00:00", "middle: in"},
          {"2026-08-05T23:59:59+00:00", "at-to: in"}
        ])

      assert subjects_between(repo, "2026-08-05T00:00:00Z", "2026-08-05T23:59:59Z") ==
               ["at-to: in", "middle: in", "at-from: in"]
    end

    test "hands git raw-seconds bounds, not a bare wall-clock datetime" do
      # The zone-independence of the instant form rests entirely on the `@secs`
      # form reaching git. Pin it so a well-meaning refactor to a readable
      # datetime string cannot silently reintroduce the timezone bug.
      start_supervised!(ScriptedRunner)
      ScriptedRunner.script({"", 0})

      Shuttle.Narration.commits_between(
        ms("2026-08-05T00:00:00Z"),
        ms("2026-08-05T23:59:59Z"),
        store_root: "/anywhere",
        runner: ScriptedRunner
      )

      args = ScriptedRunner.last_args()
      assert "--since=@1785888000" in args
      assert "--until=@1785974399" in args
      refute Enum.any?(args, &String.contains?(&1, "00:00:00"))
    end

    test "the same window answers identically whatever timezone the daemon runs in" do
      # The property the instant form exists for, on the hardest case: a commit
      # at 23:30 UTC on Aug 5 sits on Aug 6 in Tokyo, so any window resolved in
      # the daemon's civil zone would disagree with itself across zones. The
      # `@secs` bounds do not.
      repo = repo_with_utc_commits([{"2026-08-05T23:30:00+00:00", "late aug5 utc"}])

      answers =
        for zone <- ["UTC", "Europe/Paris", "America/Los_Angeles", "Asia/Tokyo"] do
          Process.put(:tz_runner_zone, zone)
          subjects_between(repo, "2026-08-05T00:00:00Z", "2026-08-05T23:59:59Z", runner: TzRunner)
        end

      assert Enum.uniq(answers) == [["late aug5 utc"]]
    after
      Process.delete(:tz_runner_zone)
    end
  end

  describe "Shuttle.Narration — degradation and shell-out discipline" do
    test "excludes merge commits" do
      repo = new_repo("shuttle_narration_merge")
      commit!(repo, "2026-08-05T10:00:00+00:00", "base: first")
      git!(repo, ["checkout", "-q", "-b", "side"])
      commit!(repo, "2026-08-05T11:00:00+00:00", "side: work")
      git!(repo, ["checkout", "-q", "main"])
      commit!(repo, "2026-08-05T12:00:00+00:00", "main: work")

      git!(repo, ["merge", "--no-ff", "-q", "-m", "Merge branch 'side'", "side"], [
        {"GIT_AUTHOR_DATE", "2026-08-05T13:00:00+00:00"},
        {"GIT_COMMITTER_DATE", "2026-08-05T13:00:00+00:00"}
      ])

      found = subjects_between(repo, "2026-08-05T00:00:00Z", "2026-08-05T23:59:59Z")

      refute "Merge branch 'side'" in found
      assert Enum.sort(found) == ["base: first", "main: work", "side: work"]
    end

    test "a subject containing unusual characters survives the split" do
      subject = "fiber: a | b\tc — “quoted” 100%"
      repo = repo_with_utc_commits([{"2026-08-05T12:00:00+00:00", subject}])

      assert subjects_between(repo, "2026-08-05T00:00:00Z", "2026-08-05T23:59:59Z") == [subject]
    end

    test "a repo with no commits in range yields no commits" do
      repo = repo_with_utc_commits([{"2026-08-05T12:00:00+00:00", "only: this"}])
      assert subjects_between(repo, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z") == []
    end

    test "a directory that is not a git repo yields no commits (never raises)" do
      assert subjects_between(
               tmp_dir("shuttle_narration_plain"),
               "2026-08-05T00:00:00Z",
               "2026-08-06T00:00:00Z"
             ) == []
    end

    test "a nonexistent store root yields no commits (never raises)" do
      assert subjects_between(
               "/no/such/felt/store",
               "2026-08-05T00:00:00Z",
               "2026-08-06T00:00:00Z"
             ) == []
    end

    test "a git repo with zero commits yields no commits" do
      assert subjects_between(
               new_repo("shuttle_narration_empty"),
               "2026-08-05T00:00:00Z",
               "2026-08-06T00:00:00Z"
             ) == []
    end

    test "a wedged store times out into the empty list rather than hanging" do
      # The runner reports a timeout as the `:timeout` status, which is not 0,
      # so it lands on the same degradation path as any failed command.
      start_supervised!(ScriptedRunner)
      ScriptedRunner.script({"git log timed out after 10000ms", :timeout})

      assert Shuttle.Narration.commits_between(0, 1,
               store_root: "/anywhere",
               runner: ScriptedRunner
             ) == []
    end

    test "bounds the git call rather than leaving it unbounded" do
      # A shell-out in a request path with no timeout is the hazard
      # Shuttle.Runner was written for; assert the call carries a bound.
      Shuttle.Narration.commits_between(0, 1, store_root: "/anywhere", runner: TimeoutProbe)

      assert_received {:opts, opts}
      assert is_integer(Keyword.fetch!(opts, :timeout_ms))
      assert Keyword.fetch!(opts, :timeout_ms) <= 30_000
    end
  end

  describe "GET /api/v1/narration — instant form" do
    test "200 with the commits inside the instant window" do
      repo =
        repo_with_utc_commits([
          {"2026-08-04T12:00:00+00:00", "aug4: out"},
          {"2026-08-05T12:00:00+00:00", "felt-temporal: land the data layer"}
        ])

      with_felt_store(repo)

      from_ms = ms("2026-08-05T00:00:00Z")
      to_ms = ms("2026-08-05T23:59:59Z")
      conn = get(api_conn(), "/api/v1/narration?from_ms=#{from_ms}&to_ms=#{to_ms}")

      assert conn.status == 200

      assert %{"commits" => [%{"subject" => "felt-temporal: land the data layer", "iso" => iso}]} =
               json_response(conn, 200)

      assert String.contains?(iso, "2026-08-05")
    end

    test "stray civil-day params are ignored" do
      # `from`/`to` were a second, daemon-zone window form the endpoint once
      # accepted. They are gone; a caller still sending them gets the instant
      # window it asked for, not a 400 and not the civil window.
      repo =
        repo_with_utc_commits([
          {"2026-08-04T12:00:00+00:00", "aug4: outside the instant window"},
          {"2026-08-06T12:00:00+00:00", "aug6: inside it"}
        ])

      with_felt_store(repo)

      from_ms = ms("2026-08-06T00:00:00Z")
      to_ms = ms("2026-08-06T23:59:59Z")

      conn =
        get(
          api_conn(),
          "/api/v1/narration?from=2026-08-04&to=2026-08-04&from_ms=#{from_ms}&to_ms=#{to_ms}"
        )

      assert %{"commits" => [%{"subject" => "aug6: inside it"}]} = json_response(conn, 200)
    end

    test "200 with an empty list when the store root is not a git repo" do
      with_felt_store(tmp_dir("shuttle_narration_nonrepo"))

      from_ms = ms("2026-08-05T00:00:00Z")
      to_ms = ms("2026-08-06T00:00:00Z")

      conn = get(api_conn(), "/api/v1/narration?from_ms=#{from_ms}&to_ms=#{to_ms}")
      assert json_response(conn, 200) == %{"commits" => []}
    end

    test "400 when a bound is missing, unparseable, or absent entirely" do
      for query <- [
            "",
            "?from_ms=1785888000000",
            "?to_ms=1785888000000",
            "?from_ms=x&to_ms=1",
            "?from=2026-08-05&to=2026-08-06"
          ] do
        conn = get(api_conn(), "/api/v1/narration" <> query)
        assert conn.status == 400, "expected 400 for #{inspect(query)}"
        assert %{"error" => error} = json_response(conn, 400)
        assert error =~ "_ms", "expected an instant-form message, got #{inspect(error)}"
      end
    end

    test "400 on an inverted instant window" do
      conn = get(api_conn(), "/api/v1/narration?from_ms=1785888000000&to_ms=1785887999999")

      assert conn.status == 400
      assert %{"error" => error} = json_response(conn, 400)
      assert error =~ "on or after"
    end

    test "400 on an instant window wider than the cap" do
      from_ms = ms("2020-01-01T00:00:00Z")
      to_ms = from_ms + Shuttle.Narration.max_range_ms() + 1

      conn = get(api_conn(), "/api/v1/narration?from_ms=#{from_ms}&to_ms=#{to_ms}")

      assert conn.status == 400
      assert %{"error" => error} = json_response(conn, 400)
      assert error =~ "#{Shuttle.Narration.max_range_days()} days"
    end

    test "the cap admits a window exactly at the limit" do
      with_felt_store(tmp_dir("shuttle_narration_atlimit"))

      from_ms = ms("2026-01-01T00:00:00Z")
      to_ms = from_ms + Shuttle.Narration.max_range_ms()

      conn = get(api_conn(), "/api/v1/narration?from_ms=#{from_ms}&to_ms=#{to_ms}")
      assert conn.status == 200
    end
  end

  # Pin the daemon's primary felt store to `path`. FELT_STORES wins over the
  # persisted registry, and changing it invalidates FeltStores' expansion cache
  # (which is keyed by the base list), so each test sees its own repo.
  defp with_felt_store(path) do
    previous = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", path)

    on_exit(fn ->
      if previous,
        do: System.put_env("FELT_STORES", previous),
        else: System.delete_env("FELT_STORES")
    end)
  end

  defp api_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
  end
end
