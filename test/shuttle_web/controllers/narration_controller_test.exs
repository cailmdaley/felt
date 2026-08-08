defmodule ShuttleWeb.NarrationControllerTest do
  @moduledoc """
  Reader + wiring for `GET /api/v1/narration` — the commit strip beside the
  temporal view.

  The reader (`Shuttle.Narration`) runs against real throwaway git repos built
  in tmp, because the thing under test *is* the `git log` invocation: the
  civil-day bounds, their inclusivity, and the degradation to `[]` when the
  store root is not a repo. Commits are dated at local midday, so no
  timezone can push one across a day boundary.
  """
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  defp tmp_dir(prefix) do
    path = Path.join(System.tmp_dir!(), "#{prefix}_#{System.unique_integer([:positive])}")
    File.mkdir_p!(path)
    on_exit(fn -> File.rm_rf(path) end)
    path
  end

  # A repo with one empty commit per {date, subject}, committed at local midday
  # on that date.
  defp repo_with_commits(commits) do
    repo = tmp_dir("shuttle_narration_repo")
    {_, 0} = System.cmd("git", ["init", "-q", "-b", "main"], cd: repo, stderr_to_stdout: true)

    for {date, subject} <- commits do
      when_at = "#{date} 12:00:00"

      {_, 0} =
        System.cmd(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            subject
          ],
          cd: repo,
          env: [{"GIT_AUTHOR_DATE", when_at}, {"GIT_COMMITTER_DATE", when_at}],
          stderr_to_stdout: true
        )
    end

    repo
  end

  defp subjects(repo, from, to) do
    Shuttle.Narration.commits(Date.from_iso8601!(from), Date.from_iso8601!(to), store_root: repo)
    |> Enum.map(& &1.subject)
  end

  describe "Shuttle.Narration.commits/3" do
    test "returns the subjects in the range, newest first, with an ISO committer date" do
      repo =
        repo_with_commits([
          {"2026-08-05", "shuttle-launch: guarantee ~/.local/bin on the daemon's PATH"},
          {"2026-08-06", "linux: a Linux host can be the hub, not just a worker"}
        ])

      commits =
        Shuttle.Narration.commits(~D[2026-08-05], ~D[2026-08-06], store_root: repo)

      assert Enum.map(commits, & &1.subject) == [
               "linux: a Linux host can be the hub, not just a worker",
               "shuttle-launch: guarantee ~/.local/bin on the daemon's PATH"
             ]

      # `%cI` — strict ISO 8601 with an offset — for every entry, dated the day
      # the commit was made.
      assert Enum.map(commits, &String.slice(&1.iso, 0, 10)) == ["2026-08-06", "2026-08-05"]

      assert Enum.all?(commits, fn c ->
               match?({:ok, _, _}, DateTime.from_iso8601(c.iso))
             end)
    end

    test "both civil-day ends are inclusive and commits outside are excluded" do
      repo =
        repo_with_commits([
          {"2026-08-03", "before: out"},
          {"2026-08-05", "from-day: in"},
          {"2026-08-06", "middle: in"},
          {"2026-08-07", "to-day: in"},
          {"2026-08-09", "after: out"}
        ])

      assert subjects(repo, "2026-08-05", "2026-08-07") == [
               "to-day: in",
               "middle: in",
               "from-day: in"
             ]
    end

    test "a single-day range returns just that day" do
      repo =
        repo_with_commits([
          {"2026-08-05", "the day: in"},
          {"2026-08-06", "next day: out"}
        ])

      assert subjects(repo, "2026-08-05", "2026-08-05") == ["the day: in"]
    end

    test "a subject containing unusual characters survives the split" do
      # The date/subject delimiter is \x1f precisely so a subject with colons,
      # pipes, tabs, or unicode cannot break parsing.
      subject = "fiber: a | b\tc — “quoted” 100%"
      repo = repo_with_commits([{"2026-08-05", subject}])

      assert subjects(repo, "2026-08-05", "2026-08-05") == [subject]
    end

    test "a repo with no commits in range yields no commits" do
      repo = repo_with_commits([{"2026-08-05", "only: this"}])
      assert subjects(repo, "2026-01-01", "2026-01-02") == []
    end

    test "a directory that is not a git repo yields no commits (never raises)" do
      assert subjects(tmp_dir("shuttle_narration_plain"), "2026-08-05", "2026-08-06") == []
    end

    test "a nonexistent store root yields no commits (never raises)" do
      assert subjects("/no/such/felt/store", "2026-08-05", "2026-08-06") == []
    end

    test "a git repo with zero commits yields no commits" do
      repo = tmp_dir("shuttle_narration_empty")
      {_, 0} = System.cmd("git", ["init", "-q", "-b", "main"], cd: repo, stderr_to_stdout: true)

      assert subjects(repo, "2026-08-05", "2026-08-06") == []
    end
  end

  describe "GET /api/v1/narration" do
    test "200 with the primary felt store's commits for the range" do
      repo = repo_with_commits([{"2026-08-05", "felt-temporal: land the data layer"}])
      with_felt_store(repo)

      conn = get(api_conn(), "/api/v1/narration?from=2026-08-05&to=2026-08-05")

      assert conn.status == 200

      assert %{"commits" => [%{"subject" => "felt-temporal: land the data layer", "iso" => iso}]} =
               json_response(conn, 200)

      assert String.starts_with?(iso, "2026-08-05")
    end

    test "200 with an empty list when the store root is not a git repo" do
      with_felt_store(tmp_dir("shuttle_narration_nonrepo"))

      conn = get(api_conn(), "/api/v1/narration?from=2026-08-05&to=2026-08-06")
      assert json_response(conn, 200) == %{"commits" => []}
    end

    test "400 when a date is missing or malformed" do
      for query <- [
            "",
            "?from=2026-08-05",
            "?to=2026-08-05",
            "?from=nonsense&to=2026-08-05",
            "?from=2026-13-01&to=2026-08-05",
            "?from=2026-08-05&to=05/08/2026"
          ] do
        conn = get(api_conn(), "/api/v1/narration" <> query)
        assert conn.status == 400, "expected 400 for #{inspect(query)}"
        assert %{"error" => _} = json_response(conn, 400)
      end
    end

    test "400 when the range is inverted" do
      conn = get(api_conn(), "/api/v1/narration?from=2026-08-06&to=2026-08-05")

      assert conn.status == 400
      assert %{"error" => error} = json_response(conn, 400)
      assert error =~ "on or after"
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
