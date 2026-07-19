defmodule ShuttleWeb.LifecycleControllerTest do
  use ExUnit.Case
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint ShuttleWeb.Endpoint

  # Interactivity is retired: install never forwards --interactive, even if a
  # stale client still posts the key. The flag is silently dropped, not relayed.
  test "install drops a stale interactive key rather than forwarding it" do
    store = fixture_store!("shuttle-lifecycle-install", "tests/interactive", "Interactive")
    args_file = install_fake_felt!()

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
             "--felt-store\n#{store}\ninstall\ntests/interactive\n--project-dir\n/tmp/project\n"
  end

  # pin reshapes a fiber to the schedule-less kind:pinned role — the board's
  # drag-onto-the-Pinned-strip gesture. The controller forwards model / project
  # / host to `felt shuttle pin`; no schedule (a pinned block has none).
  #
  # `--host` here is the cross-host INSTALL TARGET, unrelated to `--felt-store`
  # (which names the store the id resolves against). Both ride the same argv;
  # this locks in that they stay distinct.
  test "pin delegates to felt shuttle with model, project_dir and host" do
    store = fixture_store!("shuttle-lifecycle-pin", "tests/operator", "Operator")
    args_file = install_fake_felt!()

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
             "--felt-store\n#{store}\npin\ntests/operator\n--model\nclaude-fable\n" <>
               "--project-dir\n/tmp/loom\n--host\ndapmcw68\n"
  end

  # `repeat` rides the same id-resolution clause as `install` and `pin` — a
  # scheduled role reshaped from a card whose row came from a nested project
  # store must resolve to the owning store like any other lifecycle write.
  test "repeat delegates to felt shuttle with the store flag ahead of the verb" do
    store = fixture_store!("shuttle-lifecycle-repeat", "tests/nightly", "Nightly")
    args_file = install_fake_felt!()

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "repeat",
          "fiber" => "tests/nightly",
          "schedule" => "0 7 * * *",
          "tz" => "Europe/Paris",
          "reshape" => true
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "--felt-store\n#{store}\nrepeat\ntests/nightly\n--schedule\n0 7 * * *\n" <>
               "--tz\nEurope/Paris\n--reshape\n"
  end

  # Regression: a project whose `.felt` symlinks INTO a subtree of the loom sees
  # its fibers under project-relative ids (`lightcone/desk`), while the loom that
  # actually owns the file sees `ai-futures/lightcone/lightcone/desk`. The board
  # sends whichever id served the card's row. Before the fix, `pin` forwarded
  # that id raw against the default store and died with
  # `no felt found matching "lightcone/desk"`, stranding a de-pinned fiber in
  # Awaiting review. The controller must resolve to the OWNING store and rewrite
  # the id owner-relative.
  test "pin rewrites a project-relative id to its owning store" do
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

    args_file = install_fake_felt!()
    old_felt_stores = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", "#{loom},#{project}")

    on_exit(fn ->
      restore_env("FELT_STORES", old_felt_stores)
      File.rm_rf(root)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{
          "action" => "pin",
          "fiber" => "lightcone/desk",
          "model" => "claude-fable",
          "reshape" => true
        })
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "--felt-store\n#{loom}\npin\nai-futures/lightcone/lightcone/desk\n" <>
               "--model\nclaude-fable\n--reshape\n"
  end

  # set-interactive is retired: the controller no longer allows the action, so a
  # stale client gets a clean rejection rather than a felt shuttle invocation.
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

  test "set-outcome delegates to felt shuttle, preserving a multi-line value as one arg" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-outcome-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "outcome-edit"])
    File.mkdir_p!(fiber_dir)
    File.write!(Path.join(fiber_dir, "outcome-edit.md"), "---\nname: Outcome edit\n---\n\n")

    args_file = install_fake_felt!()
    old_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", store)

    on_exit(fn ->
      restore_env("FELT_STORES", old_loom_homes)
      File.rm_rf(root)
    end)

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
             "--felt-store\n#{store}\nset-outcome\ntests/outcome-edit\n--outcome\nBlocked: waiting on ADS token\nsecond line\n"
  end

  # T2: pause is the kanban's most-hit lifecycle write — the drag-a-card-off
  # column gesture. Post-C2 this argv is built by `Shuttle.Felt.Shuttle.run/4`
  # (destructuring `run/2`'s `[verb, fiber_id | rest]`), not a per-callsite
  # hand-rolled list; this locks in that the store flag lands BEFORE the verb
  # and the verb/fiber_id/flags land in the right order after it — the exact
  # shape a real `felt` binary requires.
  test "pause delegates to felt shuttle with the store flag ahead of the verb" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-pause-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "pause-edit"])
    File.mkdir_p!(fiber_dir)
    File.write!(Path.join(fiber_dir, "pause-edit.md"), "---\nname: Pause edit\n---\n\n")

    args_file = install_fake_felt!()
    old_felt_stores = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", store)

    on_exit(fn ->
      restore_env("FELT_STORES", old_felt_stores)
      File.rm_rf(root)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "pause", "fiber" => "tests/pause-edit"})
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "--felt-store\n#{store}\npause\ntests/pause-edit\n"
  end

  test "pause --no-kill appends the flag after the verb and fiber id" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-pause-nokill-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "pause-nokill"])
    File.mkdir_p!(fiber_dir)
    File.write!(Path.join(fiber_dir, "pause-nokill.md"), "---\nname: Pause no-kill\n---\n\n")

    args_file = install_fake_felt!()
    old_felt_stores = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", store)

    on_exit(fn ->
      restore_env("FELT_STORES", old_felt_stores)
      File.rm_rf(root)
    end)

    conn =
      post(
        api_conn(),
        "/api/v1/lifecycle",
        Jason.encode!(%{"action" => "pause", "fiber" => "tests/pause-nokill", "no_kill" => true})
      )

    assert conn.status == 200

    assert File.read!(args_file) ==
             "--felt-store\n#{store}\npause\ntests/pause-nokill\n--no-kill\n"
  end

  # set-agent composes base agent × effort × chrome in one validated write.
  # The agent positional is optional and the axes ride as flags; chrome always
  # renders explicitly (`--chrome=true|false`) so a toggle-off is unambiguous,
  # and effort passes through verbatim.
  test "set-agent forwards agent plus effort and chrome axes to felt shuttle" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-set-agent-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "axes-edit"])
    File.mkdir_p!(fiber_dir)
    File.write!(Path.join(fiber_dir, "axes-edit.md"), "---\nname: Axes edit\n---\n\n")

    args_file = install_fake_felt!()
    old_loom_homes = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", store)

    on_exit(fn ->
      restore_env("FELT_STORES", old_loom_homes)
      File.rm_rf(root)
    end)

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
             "--felt-store\n#{store}\nset-agent\ntests/axes-edit\nclaude-opus\n--effort\nxhigh\n--chrome=true\n"
  end

  test "set-model shells felt shuttle in the resolved owning store" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-set-model-store-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "science", "cmbx", "explorations", "spt-talk-push"])
    File.mkdir_p!(fiber_dir)
    File.write!(
      Path.join(fiber_dir, "spt-talk-push.md"),
      "---\nname: Road to the SPT Summer-2026 talk\nstatus: active\nshuttle:\n  kind: oneshot\n  host: cineca\n  agent: claude-opus\n---\n\n"
    )

    args_file = install_fake_felt!()

    with_env(%{"FELT_STORES" => store}, fn ->
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
               "--felt-store\n#{store}\nset-model\nscience/cmbx/explorations/spt-talk-push\ncodex\n"
    end)

    File.rm_rf(root)
  end

  test "command errors collapse duplicated cobra error lines" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-command-error-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "science", "cmbx", "explorations", "spt-talk-push"])
    File.mkdir_p!(fiber_dir)
    File.write!(
      Path.join(fiber_dir, "spt-talk-push.md"),
      "---\nname: Road to the SPT Summer-2026 talk\nstatus: active\nshuttle:\n  kind: oneshot\n  host: cineca\n  agent: claude-opus\n---\n\n"
    )

    install_fake_felt!("""
    printf 'Error: no felt found matching "science/cmbx/explorations/spt-talk-push"\\nno felt found matching "science/cmbx/explorations/spt-talk-push"\\n'
    exit 1
    """)

    with_env(%{"FELT_STORES" => store}, fn ->
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
      assert conn.resp_body == ~s(shuttle exited 1: no felt found matching "science/cmbx/explorations/spt-talk-push")
    end)

    File.rm_rf(root)
  end

  test "accept for standing roles re-arms from the doc and evicts runtime frontmatter" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-accept-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "standing-accept"])
    File.mkdir_p!(fiber_dir)
    path = Path.join(fiber_dir, "standing-accept.md")

    # Awaiting is the document itself — `status: closed` + untempered. accept
    # re-arms straight from the doc schedule; there is no `review` axis and no
    # runtime row (slice 6: runtime store gone). next_due is recomputed from the
    # cron schedule on the next poll.
    File.write!(path, """
    ---
    name: Standing accept
    status: closed
    outcome: digest
    closed-at: 2026-06-01T09:30:00Z
    shuttle:
      kind: standing
      host: #{Shuttle.Poller.own_host_id()}
      project_dir: #{store}
      schedule:
        expr: 0 9 * * 1-5
        tz: UTC
    ---

    Body.
    """)

    with_env(%{"FELT_STORES" => store}, fn ->
      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(%{
            "action" => "accept",
            "fiber" => "tests/standing-accept"
          })
        )

      assert conn.status == 200
      assert conn.resp_body =~ "accepted run for tests/standing-accept"
      # accept re-arms the role; the precise next tick rides the board's polled
      # snapshot (felt is the cron authority — Stage 4b), not this message.
      assert conn.resp_body =~ "next run on the schedule's next tick"

      text = File.read!(path)
      frontmatter = frontmatter(text)
      refute frontmatter =~ "review:"
      refute frontmatter =~ "closed-at:"
      assert frontmatter =~ "status: active"
      # accept PRESERVES the prior run's outcome — it stays the card headline
      # until the next run overwrites it (accept no longer blanks it).
      assert frontmatter =~ "outcome: digest"
      assert frontmatter =~ "schedule:"
    end)

    File.rm_rf(root)
  end

  test "accept re-arms a standing role awaiting review (temper resumes it)" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-accept-reenable-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "standing-accept-reenable"])
    File.mkdir_p!(fiber_dir)
    path = Path.join(fiber_dir, "standing-accept-reenable.md")

    # A standing role whose last run is awaiting (status: closed + untempered).
    # Accepting it ("temper") re-arms from the doc schedule — status: active is
    # the sole dispatch gate (slice 5: no enabled flag), and any stale enabled
    # key is wiped on the rewrite.
    File.write!(path, """
    ---
    name: Standing accept reenable
    status: closed
    closed-at: 2026-06-01T09:30:00Z
    shuttle:
      enabled: false
      kind: standing
      host: #{Shuttle.Poller.own_host_id()}
      project_dir: #{store}
      schedule:
        expr: 0 9 * * 1-5
        tz: UTC
    ---

    Body.
    """)

    with_env(%{"FELT_STORES" => store}, fn ->
      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(%{
            "action" => "accept",
            "fiber" => "tests/standing-accept-reenable"
          })
        )

      assert conn.status == 200

      frontmatter = frontmatter(File.read!(path))
      assert frontmatter =~ "status: active"
      # Clean cutover: no enabled flag survives the re-arm rewrite.
      refute frontmatter =~ "enabled"
    end)

    File.rm_rf(root)
  end

  test "resume for standing roles re-arms from the doc and evicts runtime frontmatter" do
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-resume-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "standing-resume"])
    File.mkdir_p!(fiber_dir)
    path = Path.join(fiber_dir, "standing-resume.md")

    # Awaiting is `status: closed` + untempered. resume re-arms from the doc for
    # immediate dispatch — no review axis, no runtime row (slice 6).
    File.write!(path, """
    ---
    name: Standing resume
    status: closed
    outcome: digest
    closed-at: 2026-06-01T09:12:00Z
    shuttle:
      kind: standing
      host: #{Shuttle.Poller.own_host_id()}
      project_dir: #{store}
      schedule:
        expr: 0 9 * * 1-5
        tz: UTC
    ---

    Body.
    """)

    with_env(%{"FELT_STORES" => store}, fn ->
      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(%{
            "action" => "resume",
            "fiber" => "tests/standing-resume"
          })
        )

      assert conn.status == 200
      assert conn.resp_body =~ "re-queued for immediate dispatch"

      frontmatter = path |> File.read!() |> frontmatter()
      refute frontmatter =~ "review:"
      refute frontmatter =~ "closed-at:"
      assert frontmatter =~ "status: active"
      assert frontmatter =~ "outcome: digest"
    end)

    File.rm_rf(root)
  end

  test "accept re-arms a status:active role idempotently (temper mid-run)" do
    # Accept reads ONLY the document (slice 4 deleted the review overlay, slice 6
    # the runtime store). An armed (`status: active`) untempered role ACCEPTS —
    # the kanban's Temper gesture can land while the run is still in flight
    # (worker alive or just killed, exit writer not yet run), and refusing here
    # is what let the transition fall through to close-tempered (the
    # morning-post temper bug, 2026-06-12). Re-arm from active is idempotent.
    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-accept-armed-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "standing-accept-armed"])
    File.mkdir_p!(fiber_dir)
    path = Path.join(fiber_dir, "standing-accept-armed.md")

    File.write!(path, """
    ---
    name: Standing accept armed
    status: active
    outcome: digest
    shuttle:
      kind: standing
      host: #{Shuttle.Poller.own_host_id()}
      project_dir: #{store}
      schedule:
        expr: 0 9 * * 1-5
        tz: UTC
    ---

    Body.
    """)

    with_env(%{"FELT_STORES" => store}, fn ->
      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(%{
            "action" => "accept",
            "fiber" => "tests/standing-accept-armed"
          })
        )

      assert conn.status == 200

      # The document stays armed and untempered — no verdict written.
      fm = frontmatter(File.read!(path))
      assert fm =~ "status: active"
      refute fm =~ "tempered"
    end)

    File.rm_rf(root)
  end

  test "accept fails closed instead of falling back to felt shuttle frontmatter writes" do
    args_file = install_fake_felt!()

    root =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-accept-fail-closed-#{System.unique_integer([:positive])}")

    store = Path.join(root, "loom")
    fiber_dir = Path.join([store, ".felt", "tests", "standing-accept-fail"])
    File.mkdir_p!(fiber_dir)

    File.write!(Path.join(fiber_dir, "standing-accept-fail.md"), """
    ---
    name: Standing accept fail
    status: closed
    tempered: true
    shuttle:
      enabled: true
      kind: standing
      schedule:
        expr: 0 9 * * 1-5
        tz: UTC
    ---

    Body.
    """)

    with_env(%{"FELT_STORES" => store}, fn ->
      conn =
        post(
          api_conn(),
          "/api/v1/lifecycle",
          Jason.encode!(%{
            "action" => "accept",
            "fiber" => "tests/standing-accept-fail"
          })
        )

      assert conn.status == 400
      assert conn.resp_body =~ "not acceptable"
      refute File.exists?(args_file)
    end)

    File.rm_rf(root)
  end

  defp api_conn do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> put_req_header("accept", "application/json")
  end

  defp frontmatter(content) do
    [_, frontmatter | _] = String.split(content, "---\n", parts: 3)
    frontmatter
  end

  defp with_env(vars, fun) do
    old = Map.new(vars, fn {key, _value} -> {key, System.get_env(key)} end)

    Enum.each(vars, fn {key, value} -> System.put_env(key, value) end)

    try do
      fun.()
    after
      Enum.each(old, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end
  end

  # The lifecycle controller now shells `felt shuttle <verb>` for the write, but
  # ALSO shells the real felt (`felt -C <store> show <id> -j`) to resolve the
  # owning store first. So the stub is a fake `felt` that captures ONLY the
  # `shuttle` subcommand (dropping it and logging the verb + flags the per-verb
  # assertions check) and delegates every other felt call to the real binary —
  # exactly the separation the old `shuttle-ctl`-named stub got for free.
  defp install_fake_felt!(shuttle_body \\ nil) do
    dir =
      System.tmp_dir!()
      |> Path.join("shuttle-lifecycle-controller-#{System.unique_integer([:positive])}")

    File.mkdir_p!(dir)

    bin = Path.join(dir, "felt")
    args_file = Path.join(dir, "args")
    real_felt = System.find_executable("felt") || "felt"

    shuttle_body =
      shuttle_body ||
        """
        shift  # drop the `shuttle` subcommand; log the verb + flags
        printf '%s\\n' "$@" > "$FELT_SHUTTLE_ARGS_FILE"
        printf 'ok\\n'
        """

    File.write!(bin, """
    #!/bin/sh
    if [ "$1" = shuttle ]; then
      #{shuttle_body}
    else
      exec "#{real_felt}" "$@"   # store resolution etc. → the real felt
    fi
    """)

    File.chmod!(bin, 0o755)

    old_path = System.get_env("PATH")
    old_args_file = System.get_env("FELT_SHUTTLE_ARGS_FILE")

    System.put_env("PATH", dir <> ":" <> (old_path || ""))
    System.put_env("FELT_SHUTTLE_ARGS_FILE", args_file)

    on_exit(fn ->
      restore_env("PATH", old_path)
      restore_env("FELT_SHUTTLE_ARGS_FILE", old_args_file)
      File.rm_rf(dir)
    end)

    args_file
  end

  # A throwaway single-store felt root holding one empty fiber at `slug`, wired
  # to `FELT_STORES` for the duration of the test. Lifecycle verbs resolve the
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

    old_felt_stores = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", store)

    on_exit(fn ->
      restore_env("FELT_STORES", old_felt_stores)
      File.rm_rf(root)
    end)

    store
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
