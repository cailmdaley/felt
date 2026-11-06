# Executed in an isolated VM with production config, all production children,
# a private home and stubbed external services. The Go CLIs are real.
try do
  root = System.fetch_env!("BOOT_ROOT")
  mode = System.fetch_env!("BOOT_MODE")
  File.mkdir_p!(root)
  bin = Path.join(root, "bin")
  File.mkdir_p!(bin)

  for name <- ~w(tmux codex tailscale rex hark) do
    path = Path.join(bin, name)
    File.write!(path, "#!/bin/sh\nexit 1\n")
    File.chmod!(path, 0o755)
  end

  # The private terminal fixture has no workers in the host process table.
  File.write!(bin <> "/ps", "#!/bin/sh\nexit 0\n")
  File.chmod!(bin <> "/ps", 0o755)

  for {key, value} <- %{
        "HOME" => root,
        "PATH" => bin <> ":" <> System.get_env("PATH", ""),
        "SHUTTLE_HOST" => "production-boot",
        "SHUTTLE_DATA_DIR" => root <> "/data",
        "SHUTTLE_HOST_CONFIG_FILE" => root <> "/host.json",
        "SHUTTLE_VOICE_FILE" => root <> "/voice.json",
        "HARK_DIR" => root <> "/hark",
        "SHUTTLE_STORES_FILE" => root <> "/stores.json",
        "SHUTTLE_PROJECTS_FILE" => root <> "/projects.json",
        "SHUTTLE_REMOTES_FILE" => root <> "/remotes.json",
        "SHUTTLE_AGENTS_FILE" => root <> "/agents.json",
        "SHUTTLE_SESSIONS_FILE" => root <> "/sessions.jsonl",
        "SHUTTLE_COMMITS_FILE" => root <> "/commits.jsonl",
        "SHUTTLE_EVENTS_FILE" => root <> "/events.jsonl",
        "CODEX_HOME" => root <> "/codex",
        "CLAUDE_CONFIG_DIR" => root <> "/claude",
        "PI_CODING_AGENT_DIR" => root <> "/pi",
        "TMUX_TMPDIR" => root <> "/tmux"
      },
      do: System.put_env(key, value)

  for key <-
        ~w(SHUTTLE_STORES SHUTTLE_PROJECTS SHUTTLE_LISTEN SHUTTLE_PORT TMUX HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy),
      do: System.delete_env(key)

  File.write!(root <> "/host.json", ~s({"class":"single-user","terminal":"tmux"}))
  File.write!(root <> "/remotes.json", ~s({"defaults":{"tailscale_socket":"system"}}))

  status = %{
    "BackendState" => "Running",
    "Self" => %{"UserID" => 1},
    "Peer" =>
      Map.new(1..16, fn i ->
        {"peer-#{i}", %{"DNSName" => "probe-#{i}.invalid.", "UserID" => 1, "Online" => true}}
      end)
  }

  File.write!(bin <> "/tailscale", "#!/bin/sh\nprintf '%s\\n' '#{Jason.encode!(status)}'\n")

  if mode == "realistic" do
    File.rm!(bin <> "/tmux")
    true = is_binary(System.find_executable("tmux"))
    File.mkdir_p!(root <> "/tmux")
    File.chmod!(root <> "/tmux", 0o700)
    {_, 0} = System.cmd("tmux", ["new-session", "-d", "-s", "boot-gate", "sleep 60"])
    store = root <> "/store"

    for i <- 1..3_000 do
      name = "fiber-#{i}"
      dir = Path.join([store, ".felt", name])
      File.mkdir_p!(dir)
      uid = "01JZ" <> String.pad_leading(Integer.to_string(i), 22, "0")

      File.write!(
        Path.join(dir, name <> ".md"),
        "---\nid: #{uid}\nname: Fixture #{i}\nstatus: open\nshuttle:\n  kind: oneshot\n  host: production-boot\n  project_dir: #{inspect(store)}\n---\nFixture content.\n"
      )
    end

    File.write!(root <> "/stores.json", Jason.encode!(%{felt_stores: [store]}))

    File.write!(
      bin <> "/find",
      "#!/bin/sh\nif mkdir \"$BOOT_ROOT/find-delayed\" 2>/dev/null; then sleep 18; fi\nexec /usr/bin/find \"$@\"\n"
    )

    File.chmod!(bin <> "/find", 0o755)
  end

  if mode == "hung" do
    {_, 0} = System.cmd("mkfifo", [root <> "/stores.json"])
  else
    if mode != "realistic", do: File.write!(root <> "/stores.json", ~s({"felt_stores":[]}))
  end

  expected_beam =
    Path.join(System.fetch_env!("BOOT_BUILD_DIR"), "lib/shuttle/ebin/Elixir.Shuttle.Env.beam")

  ^expected_beam = to_string(:code.which(Shuttle.Env))
  false = Shuttle.Env.scoped?()
  config = Config.Reader.read!("config/config.exs", env: :prod)
  Application.put_all_env(config)
  # Port zero gives the real listener a private ephemeral port.
  endpoint = Application.get_env(:shuttle, ShuttleWeb.Endpoint)

  Application.put_env(
    :shuttle,
    ShuttleWeb.Endpoint,
    Keyword.put(endpoint, :http, ip: {127, 0, 0, 1}, port: 0)
  )

  {:ok, _} = Application.ensure_all_started(:shuttle)
  {:ok, {_, port}} = ShuttleWeb.Endpoint.server_info(:http)
  url = ~c"http://127.0.0.1:" ++ Integer.to_charlist(port) ++ ~c"/api/v1/version"

  request = fn ->
    {:ok, {{_, 200, _}, _, body}} = :httpc.request(:get, {url, []}, [timeout: 2_000], [])
    Jason.decode!(body)
  end

  deadline = System.monotonic_time(:millisecond) + 50_000

  wait = fn wait, predicate ->
    version = request.()

    cond do
      predicate.(version) ->
        version

      System.monotonic_time(:millisecond) > deadline ->
        IO.inspect(Process.info(Process.whereis(Shuttle.Poller), :current_stacktrace),
          label: "Poller boot stack"
        )

        raise "boot failed to settle: #{inspect(version)}"

      true ->
        Process.sleep(20)
        wait.(wait, predicate)
    end
  end

  ready = &(&1["ready"] and &1["discovery"]["state"] != "pending")

  version =
    if mode in ["hung", "realistic"] do
      wait.(
        wait,
        &(get_in(&1, ["boot", "stage"]) == "store_inventory" and
            get_in(&1, ["boot", "elapsed_ms"]) >= 16_000)
      )
    else
      wait.(wait, ready)
    end

  # This manifest is deliberately independent of config/test.exs and of the
  # application builder: disabling a production child turns this gate red.
  for module <- [
        Shuttle.EventStream,
        Shuttle.Voice,
        Shuttle.RexFocus,
        Shuttle.Poller,
        Shuttle.InterruptWatcher,
        Shuttle.LogRotator,
        Shuttle.RemoteControl,
        Shuttle.TranscriptIndexer,
        Shuttle.TailnetPeers,
        Shuttle.TailnetDial,
        Shuttle.RemoteRegistry,
        Shuttle.RemoteFiberRegistry,
        Shuttle.RemoteTemporalRegistry,
        Shuttle.Local,
        Shuttle.Fleet
      ] do
    pid = Process.whereis(module)

    if not is_pid(pid) or not Process.alive?(pid),
      do: raise("production child absent: #{inspect(module)}")
  end

  16 = :erlang.system_info(:dirty_io_schedulers)
  16 = length(version["discovery"]["rejected"])

  if mode == "realistic" do
    false = version["ready"]
    nil = version["boot_hold"]
    "store_inventory" = version["boot"]["stage"]
    IO.puts("REALISTIC_SLOW_STAGE_OK " <> Jason.encode!(version["boot"]))
  end

  version =
    if mode == "hung" do
      false = version["ready"]
      nil = version["boot_hold"]
      "booting" = version["boot"]["reason"]
      dispatch = ~c"http://127.0.0.1:" ++ Integer.to_charlist(port) ++ ~c"/api/v1/dispatch"

      {:ok, {{_, 503, _}, _, body}} =
        :httpc.request(
          :post,
          {dispatch, [], ~c"application/json", ~c"{\"fiber_id\":\"held\",\"force\":true}"},
          [],
          []
        )

      "booting" = Jason.decode!(body)["error"]
      File.write!(root <> "/stores-ready.json", ~s({"felt_stores":[]}))

      {_, 0} =
        System.cmd("perl", [
          "-e",
          ~S(open my $f, ">", $ARGV[0] or die $!; print $f '{"felt_stores":[]}'; rename $ARGV[1], $ARGV[0] or die $!; close $f;),
          root <> "/stores.json",
          root <> "/stores-ready.json"
        ])

      wait.(wait, ready)
    else
      wait.(wait, ready)
    end

  if mode == "realistic" do
    warm = fn warm ->
      case Shuttle.Poller.cached_fiber_documents([]) do
        {:ok, %{fibers: fibers}} when length(fibers) == 3_000 ->
          :ok

        _ ->
          if System.monotonic_time(:millisecond) > deadline,
            do: raise("realistic store did not warm")

          Process.sleep(20)
          warm.(warm)
      end
    end

    warm.(warm)
  end

  true = version["ready"]
  nil = version["boot_hold"]
  true = Shuttle.Poller.snapshot().boot_quarantine

  if mode == "normal" do
    expected = Map.take(version, ["incarnation", "release_path"])
    :ok = Supervisor.terminate_child(Shuttle.Local, Shuttle.Poller)
    {:ok, _} = Supervisor.restart_child(Shuttle.Local, Shuttle.Poller)
    replacement = wait.(wait, &(&1["incarnation"] not in [nil, expected["incarnation"]]))

    release_url =
      ~c"http://127.0.0.1:" ++ Integer.to_charlist(port) ++ ~c"/api/v1/quarantine/release"

    release = fn identity ->
      body = Jason.encode!(%{expected: identity})

      {:ok, {{_, status, _}, _, response}} =
        :httpc.request(:post, {release_url, [], ~c"application/json", body}, [timeout: 5_000], [])

      {status, Jason.decode!(response)}
    end

    {409, %{"error" => "incarnation_mismatch"}} = release.(expected)
    true = Shuttle.Poller.snapshot().boot_quarantine
    {200, %{"ok" => true}} = release.(Map.take(replacement, ["incarnation", "release_path"]))
    false = Shuttle.Poller.snapshot().boot_quarantine
    IO.puts("INCARNATION_RELEASE_OK")
  end

  IO.puts("PRODUCTION_BOOT_OK " <> Jason.encode!(%{mode: mode, version: version}))
  :erlang.halt(0)
rescue
  error ->
    IO.puts(Exception.format(:error, error, __STACKTRACE__))
    :erlang.halt(1)
catch
  kind, reason ->
    IO.puts(Exception.format(kind, reason, __STACKTRACE__))
    :erlang.halt(1)
end
