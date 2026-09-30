defmodule ShuttleWeb.LifecycleControllerTest do
  use ExUnit.Case
  import Shuttle.Test.ApiConn
  import Shuttle.Test.EnvHelpers
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

  # pin CREATES a schedule-less kind:pinned block on a fiber that has none —
  # the board's drag-onto-the-Pinned-strip gesture for an unmanaged card (an
  # already-managed one reshapes instead). The controller forwards model /
  # project / host to `shuttle pin`; no schedule (a pinned block has none).
  #
  # `--host` here is the cross-host INSTALL TARGET, unrelated to `-C`
  # (which names the store the id resolves against). Both ride the same argv;
  # this locks in that they stay distinct.
  test "pin delegates to shuttle with model, project_dir and host" do
    store = fixture_store!("shuttle-lifecycle-pin", "tests/operator", "Operator")
    args_file = install_fake_cli!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "pin",
          "fiber" => "tests/operator",
          "model" => "claude-fable",
          "project_dir" => "/tmp/loom",
          "host" => "dapmcw68"
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{store}\npin\ntests/operator\n--model\nclaude-fable\n" <>
               "--project-dir\n/tmp/loom\n--host\ndapmcw68\n"
  end

  # `reshape` is the surgical shape edit on an existing block: the kind rides as
  # an optional POSITIONAL right after the fiber, then the schedule flags. It
  # rides the same id-resolution clause as `install` and `pin`, so the store
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

  # Only the three legal kinds reach the CLI — an arbitrary string is rejected
  # here rather than forwarded as a positional felt would have to argue with.
  test "reshape rejects a kind outside oneshot/standing/pinned" do
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
  # sends whichever id served the card's row. Before the fix, the pin-to-the-
  # strip write forwarded that id raw against the default store and died with
  # `no fiber found matching "lightcone/desk"`, stranding a de-pinned fiber in
  # Awaiting review. The controller must resolve to the OWNING store and rewrite
  # the id owner-relative — the gesture now posts `reshape pinned`, so the
  # id-rewrite guard rides that verb.
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
    old_felt_stores = System.get_env("SHUTTLE_STORES")
    System.put_env("SHUTTLE_STORES", "#{loom},#{project}")

    on_exit(fn ->
      restore_env("SHUTTLE_STORES", old_felt_stores)
      File.rm_rf(root)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "reshape",
          "fiber" => "lightcone/desk",
          "kind" => "pinned"
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "-C\n#{loom}\nreshape\nai-futures/lightcone/lightcone/desk\npinned\n--local\n"
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
  # the Poller when one is running — none is in this suite) and relays felt's
  # answer. What the write does to the document is pinned by felt's own suite
  # (cmd/shuttle_lifecycle_test.go).
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

  test "accept relays felt's refusal as a 422 with the cobra prefix stripped" do
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
    dir =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-controller-#{System.unique_integer([:positive])}")

    File.mkdir_p!(dir)

    felt_bin = Path.join(dir, "felt")
    shuttle_bin = Path.join(dir, "shuttle")
    args_file = Path.join(dir, "args")
    real_felt = System.find_executable("felt") || "felt"

    shuttle_body =
      shuttle_body ||
        """
        printf '%s\\n' "$@" > "$SHUTTLE_ARGS_FILE"
        printf 'ok\\n'
        """

    File.write!(felt_bin, """
    #!/bin/sh
    exec "#{real_felt}" "$@"
    """)

    File.write!(shuttle_bin, """
    #!/bin/sh
    #{shuttle_body}
    """)

    File.chmod!(felt_bin, 0o755)
    File.chmod!(shuttle_bin, 0o755)

    old_path = System.get_env("PATH")
    old_args_file = System.get_env("SHUTTLE_ARGS_FILE")

    System.put_env("PATH", dir <> ":" <> (old_path || ""))
    System.put_env("SHUTTLE_ARGS_FILE", args_file)

    on_exit(fn ->
      restore_env("PATH", old_path)
      restore_env("SHUTTLE_ARGS_FILE", old_args_file)
      File.rm_rf(dir)
    end)

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

    old_felt_stores = System.get_env("SHUTTLE_STORES")
    System.put_env("SHUTTLE_STORES", store)

    on_exit(fn ->
      restore_env("SHUTTLE_STORES", old_felt_stores)
      File.rm_rf(root)
    end)

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
