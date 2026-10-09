defmodule ShuttleWeb.LifecycleControllerTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.ApiConn
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # Interactivity is retired: install never forwards --interactive, even if a
  # stale client still posts the key. The flag is silently dropped, not relayed.
  test "install drops a stale interactive key rather than forwarding it" do
    store = fixture_store!("shuttle-lifecycle-install", "tests/interactive", "Interactive")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "install",
          "fiber" => "tests/interactive",
          "project_dir" => "/tmp/project",
          "interactive" => true
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\ninstall\ntests/interactive\n--project-dir\n/tmp/project\n"
  end

  # rest puts a card in Resting without review; the controller forwards it to
  # `shuttle rest` with --local, like pause.
  test "rest delegates to shuttle with --local" do
    store = fixture_store!("shuttle-lifecycle-rest", "tests/operator", "Operator")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "rest", "fiber" => "tests/operator"})
      )

    assert conn.status == 200
    assert File.read!(args_file) == "-C\n#{store}\nrest\ntests/operator\n--local\n"
  end

  test "dated and undated rest pass the date through the serialized writer" do
    store = fixture_store!("shuttle-rest-date", "tests/operator", "Operator")
    args_file = install_fake_cli!()

    for until <- ["2099-06-12", ""] do
      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(%{"action" => "rest", "fiber" => "tests/operator", "until" => until})
        )

      assert conn.status == 200

      assert File.read!(args_file) ==
               "-C\n#{store}\nrest\ntests/operator\n--until\n#{until}\n--local\n"
    end
  end

  test "pin is no longer a lifecycle action" do
    fixture_store!("shuttle-lifecycle-nopin", "tests/operator", "Operator")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "pin", "fiber" => "tests/operator"})
      )

    assert conn.status == 400
    refute File.exists?(args_file)
  end

  # `reshape` is the surgical shape edit on an existing block: the kind rides as
  # an optional POSITIONAL right after the fiber, then the schedule flags. It
  # rides the same id-resolution clause as `install`, so the store
  # flag still lands ahead of the verb.
  test "reshape delegates to shuttle with kind as a positional" do
    store = fixture_store!("shuttle-lifecycle-reshape", "tests/nightly", "Nightly")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "reshape",
          "fiber" => "tests/nightly",
          "kind" => "standing",
          "schedule" => "0 7 * * *",
          "tz" => "Europe/Paris"
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\nreshape\ntests/nightly\nstanding\n--schedule\n0 7 * * *\n" <>
               "--tz\nEurope/Paris\n--local\n"
  end

  # A schedule-only edit passes NO kind positional — the CLI keeps the current
  # kind. Nothing may be invented in its place (an echoed kind would be the
  # controller choosing the shape the user didn't touch).
  test "reshape omits the kind positional for a schedule-only edit" do
    store = fixture_store!("shuttle-lifecycle-reshape-sched", "tests/cadence", "Cadence")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "reshape",
          "fiber" => "tests/cadence",
          "schedule" => "30 6 * * 1",
          "tz" => "UTC"
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\nreshape\ntests/cadence\n--schedule\n30 6 * * 1\n--tz\nUTC\n--local\n"
  end

  # Only the legal kinds reach the CLI — an arbitrary string, or the retired
  # `pinned`, is rejected here rather than forwarded as a positional felt would
  # have to argue with.
  test "reshape rejects a kind outside oneshot/standing" do
    fixture_store!("shuttle-lifecycle-reshape-badkind", "tests/badkind", "Bad kind")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "reshape",
          "fiber" => "tests/badkind",
          "kind" => "perpetual"
        })
      )

    assert conn.status == 400
    assert conn.resp_body =~ "unknown shuttle kind"
    refute File.exists?(args_file)
  end

  # Regression: a project whose `.felt` symlinks INTO a subtree of the loom sees
  # its fibers under project-relative ids (`lightcone/desk`), while the loom that
  # actually owns the file sees `ai-futures/lightcone/lightcone/desk`. The board
  # sends whichever id served the card's row. A write that forwarded that id raw
  # against the default store would die with `no fiber found matching
  # "lightcone/desk"`. The controller must resolve to the OWNING store and
  # rewrite the id owner-relative; reshape carries the guard here.
  test "reshape rewrites a project-relative id to its owning store" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-nested-#{System.unique_integer([:positive])}")

    loom = Path.join(root, "loom")
    nested = Path.join([loom, ".felt", "ai-futures", "lightcone"])
    fiber_dir = Path.join([nested, "lightcone", "desk"])
    File.mkdir_p!(fiber_dir)
    File.write!(Path.join(fiber_dir, "desk.md"), "---\nname: Desk\n---\n\n")

    # The project store is a symlink into the loom subtree — the real topology
    # that produces two valid ids for one file.
    project = Path.join(root, "LightconeResearch")
    File.mkdir_p!(project)
    File.ln_s!(nested, Path.join(project, ".felt"))

    args_file = install_fake_cli!()
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", "#{loom},#{project}")
    on_exit(fn -> File.rm_rf(root) end)

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "reshape",
          "fiber" => "lightcone/desk",
          "kind" => "oneshot"
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{loom}\nreshape\nai-futures/lightcone/lightcone/desk\noneshot\n--local\n"
  end

  test "close and reopen delegate through the existing lifecycle endpoint" do
    close_store =
      fixture_store!("shuttle-lifecycle-close-route", "tests/close-route", "Close route")

    close_args = install_fake_cli!()

    close_conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "close", "fiber" => "tests/close-route", "tempered" => true})
      )

    assert close_conn.status == 200

    assert File.read!(close_args) ==
             "-C\n#{close_store}\nclose\ntests/close-route\n--tempered=true\n--local\n"

    reopen_store =
      fixture_store!("shuttle-lifecycle-reopen-route", "tests/reopen-route", "Reopen route")

    reopen_args = install_fake_cli!()

    reopen_conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "reopen",
          "fiber" => "tests/reopen-route",
          "as_draft" => true,
          "project_dir" => "/tmp/project"
        })
      )

    assert reopen_conn.status == 200

    assert File.read!(reopen_args) ==
             "-C\n#{reopen_store}\nreopen\ntests/reopen-route\n--as-draft\n--project-dir\n/tmp/project\n--local\n"
  end

  # set-interactive is retired: the controller no longer allows the action, so a
  # stale client gets a clean rejection rather than a shuttle invocation.
  test "set-interactive is rejected as an unknown lifecycle action" do
    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "set-interactive",
          "fiber" => "tests/interactive",
          "interactive" => false
        })
      )

    assert conn.status == 400
    assert conn.resp_body =~ "unknown lifecycle action"
  end

  test "set-outcome delegates to shuttle, preserving a multi-line value as one arg" do
    store = fixture_store!("shuttle-lifecycle-outcome", "tests/outcome-edit", "Outcome edit")

    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "set-outcome",
          "fiber" => "tests/outcome-edit",
          "outcome" => "Blocked: waiting on ADS token\nsecond line"
        })
      )

    assert conn.status == 200

    # The multi-line outcome rides as a single argv element (one `--outcome`
    # value), so the block scalar survives without stdin piping.
    assert File.read!(args_file) ==
             "-C\n#{store}\nset-outcome\ntests/outcome-edit\n--outcome\nBlocked: waiting on ADS token\nsecond line\n--local\n"
  end

  # T2: pause is the kanban's most-hit lifecycle write — the drag-a-card-off
  # column gesture. This argv is built by `Shuttle.CLI.run_lifecycle/4`
  # (destructuring `run/2`'s `[verb, fiber_id | rest]`), not a per-callsite
  # hand-rolled list; this locks in that the store flag lands BEFORE the verb
  # and the verb/fiber_id/flags land in the right order after it — the exact
  # shape a real `shuttle` binary requires.
  test "pause delegates to shuttle with the store flag ahead of the verb" do
    store = fixture_store!("shuttle-lifecycle-pause", "tests/pause-edit", "Pause edit")

    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "pause", "fiber" => "tests/pause-edit"})
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\npause\ntests/pause-edit\n--local\n"
  end

  test "pause --no-kill appends the flag after the verb and fiber id" do
    store =
      fixture_store!("shuttle-lifecycle-pause-nokill", "tests/pause-nokill", "Pause no-kill")

    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "pause", "fiber" => "tests/pause-nokill", "no_kill" => true})
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\npause\ntests/pause-nokill\n--no-kill\n--local\n"
  end

  # set-agent composes base agent × effort × chrome in one validated write.
  # The agent positional is optional and the axes ride as flags; chrome always
  # renders explicitly (`--chrome=true|false`) so a toggle-off is unambiguous,
  # and effort passes through verbatim.
  test "set-agent forwards agent plus effort and chrome axes to shuttle" do
    store = fixture_store!("shuttle-lifecycle-set-agent", "tests/axes-edit", "Axes edit")

    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "set-agent",
          "fiber" => "tests/axes-edit",
          "agent" => "claude-opus",
          "effort" => "xhigh",
          "chrome" => true
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\nset-agent\ntests/axes-edit\nclaude-opus\n--effort\nxhigh\n--chrome=true\n--local\n"
  end

  test "set-agent can update project_dir without changing agent axes" do
    store =
      fixture_store!("shuttle-lifecycle-set-project-dir", "tests/project-dir", "Project dir")

    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "set-agent",
          "fiber" => "tests/project-dir",
          "project_dir" => "/tmp/project"
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\nset-agent\ntests/project-dir\n--project-dir\n/tmp/project\n--local\n"
  end

  test "seat forwards the role, or --clear, to shuttle" do
    store = fixture_store!("shuttle-lifecycle-seat", "tests/hub", "Hub")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "seat",
          "fiber" => "tests/hub",
          "role" => "cmbx-chair",
          "clear" => false
        })
      )

    assert conn.status == 200
    assert File.read!(args_file) == "-C\n#{store}\nseat\ntests/hub\ncmbx-chair\n--local\n"

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "seat", "fiber" => "tests/hub", "clear" => true})
      )

    assert conn.status == 200
    assert File.read!(args_file) == "-C\n#{store}\nseat\ntests/hub\n--clear\n--local\n"
  end

  defmodule SeatRunner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", ["-C", _store, "seat" | _] = args, opts) do
      send(Shuttle.Env.app(:seat_writer_observer), {:seat_writer, self(), args})
      Shuttle.Runner.Default.cmd("shuttle", args, opts)
    end

    def cmd(command, args, opts) when command in ["felt", "shuttle"],
      do: Shuttle.Runner.Default.cmd(command, args, opts)

    def cmd(_command, _args, _opts), do: {"", 1}
  end

  test "seat set and clear execute in the Poller, serialized with lifecycle writes" do
    store = fixture_store!("shuttle-seat-serialized", "tests/hub", "Hub")
    install_fake_cli!()
    Shuttle.Test.Env.put_app_env(:seat_writer_observer, self())
    Shuttle.Test.Env.put_app_env(:felt_runner, SeatRunner)

    {:ok, poller} =
      Shuttle.Test.PollerHelpers.start_poller!(
        runner: SeatRunner,
        felt_stores: [store],
        poll_interval_ms: 60_000
      )

    for {params, seat_args} <- [
          {%{"role" => "cmbx-chair"}, ["cmbx-chair"]},
          {%{"clear" => true}, ["--clear"]}
        ] do
      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(Map.merge(params, %{"action" => "seat", "fiber" => "tests/hub"}))
        )

      assert conn.status == 200
      assert_receive {:seat_writer, writer, args}
      assert writer == poller
      assert args == ["-C", store, "seat", "tests/hub"] ++ seat_args ++ ["--local"]
    end
  end

  test "seat without a role or --clear is refused before shelling" do
    fixture_store!("shuttle-lifecycle-seat-bare", "tests/bare", "Bare")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "seat", "fiber" => "tests/bare", "clear" => false})
      )

    assert conn.status in 400..499
    refute File.exists?(args_file)
  end

  test "set-model shells shuttle in the resolved owning store" do
    store =
      fixture_store!(
        "shuttle-lifecycle-set-model-store",
        "science/cmbx/explorations/spt-talk-push",
        "Road to the SPT Summer-2026 talk"
      )

    write_fiber!(
      store,
      "science/cmbx/explorations/spt-talk-push",
      "---\nname: Road to the SPT Summer-2026 talk\nstatus: active\nshuttle:\n  kind: oneshot\n  host: cineca\n  agent: claude-opus\n---\n\n"
    )

    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "set-model",
          "fiber" => "science/cmbx/explorations/spt-talk-push",
          "agent" => "codex"
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\nset-model\nscience/cmbx/explorations/spt-talk-push\ncodex\n--local\n"
  end

  test "command errors collapse duplicated cobra error lines" do
    store =
      fixture_store!(
        "shuttle-lifecycle-command-error",
        "science/cmbx/explorations/spt-talk-push",
        "Road to the SPT Summer-2026 talk"
      )

    write_fiber!(
      store,
      "science/cmbx/explorations/spt-talk-push",
      "---\nname: Road to the SPT Summer-2026 talk\nstatus: active\nshuttle:\n  kind: oneshot\n  host: cineca\n  agent: claude-opus\n---\n\n"
    )

    install_fake_cli!("""
    printf 'Error: no fiber found matching "science/cmbx/explorations/spt-talk-push"\\nno fiber found matching "science/cmbx/explorations/spt-talk-push"\\n'
    exit 1
    """)

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "set-model",
          "fiber" => "science/cmbx/explorations/spt-talk-push",
          "agent" => "codex"
        })
      )

    assert conn.status == 422

    assert conn.resp_body ==
             ~s(shuttle exited 1: no fiber found matching "science/cmbx/explorations/spt-talk-push")
  end

  # accept and resume are Shuttle's to write: the controller runs
  # `shuttle <verb> <fiber> --local` in the fiber's owning store (through
  # the Poller when one is running — none is in this suite) and relays Shuttle's
  # answer. The document write is covered by the CLI's Go tests
  # (internal/shuttlecli/lifecycle_test.go).
  for verb <- ~w(accept resume) do
    test "#{verb} runs Shuttle's writer with --local in the owning store" do
      store = fixture_store!("shuttle-lifecycle-#{unquote(verb)}", "tests/standing", "Standing")
      args_file = install_fake_cli!()

      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(%{"action" => unquote(verb), "fiber" => "tests/standing"})
        )

      assert conn.status == 200
      assert conn.resp_body == "ok\n"

      assert File.read!(args_file) ==
               "-C\n#{store}\n#{unquote(verb)}\ntests/standing\n--local\n"
    end
  end

  test "accept relays Shuttle's refusal as a 422 with the cobra prefix stripped" do
    fixture_store!("shuttle-lifecycle-accept-refused", "tests/standing-tempered", "Tempered")

    install_fake_cli!("""
    printf 'Error: fiber tests/standing-tempered is not acceptable (accept requires status active|closed + untempered)\\n' >&2
    exit 1
    """)

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "accept", "fiber" => "tests/standing-tempered"})
      )

    assert conn.status == 422

    assert conn.resp_body ==
             "shuttle exited 1: fiber tests/standing-tempered is not acceptable " <>
               "(accept requires status active|closed + untempered)"
  end

  # The lifecycle controller shells felt for fiber-store resolution and
  # shuttle for the lifecycle write. This fixture provides both binaries so
  # tests exercise the executable boundary as well as the argv ordering.
  defp install_fake_cli!(shuttle_body \\ nil) do
    args_file =
      Path.join(
        System.tmp_dir!(),
        "shuttle-lifecycle-args-#{System.unique_integer([:positive])}"
      )

    real_felt = Shuttle.Test.FakeCli.real!("felt")

    shuttle_body =
      shuttle_body ||
        """
        printf '%s\\n' "$@" > "$SHUTTLE_ARGS_FILE"
        printf 'ok\\n'
        """

    Shuttle.Test.FakeCli.install!(%{
      "felt" => """
      #!/bin/sh
      exec "#{real_felt}" "$@"
      """,
      "shuttle" => """
      #!/bin/sh
      #{shuttle_body}
      """
    })

    Shuttle.Test.Env.put_env("SHUTTLE_ARGS_FILE", args_file)
    on_exit(fn -> File.rm(args_file) end)

    args_file
  end

  # A throwaway single-store felt root holding one empty fiber at `slug`, wired
  # to `SHUTTLE_STORES` for the duration of the test. Lifecycle verbs resolve the
  # posted id against the configured stores, so a test that posts an id needs
  # that id to actually exist somewhere — otherwise the controller (correctly)
  # answers 400 `fiber not found` before it ever shells out to felt.
  defp fixture_store!(prefix, slug, name) do
    root =
      System.tmp_dir!()
      |> Path.join("#{prefix}-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt" | Path.split(slug)])
    File.mkdir_p!(fiber_dir)
    File.write!(Path.join(fiber_dir, "#{Path.basename(slug)}.md"), "---\nname: #{name}\n---\n\n")

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", store)
    on_exit(fn -> File.rm_rf(root) end)

    store
  end

  # Overwrite the fixture fiber's file with a body this test needs (schedules,
  # runtime frontmatter, …) and hand back its path. Separate from
  # `fixture_store!` because these bodies interpolate the store path itself.
  defp write_fiber!(store, slug, content) do
    path = Path.join([store, ".felt" | Path.split(slug)] ++ ["#{Path.basename(slug)}.md"])
    File.write!(path, content)
    path
  end
end
