defmodule Shuttle.Recorder.Control do
  @moduledoc false
  use GenServer

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, nil, Keyword.put(opts, :name, __MODULE__))

  def reconcile(identity), do: GenServer.call(__MODULE__, {:reconcile, identity})
  def claim_stop(identity), do: GenServer.call(__MODULE__, {:claim_stop, identity})
  def release_stop(identity), do: GenServer.call(__MODULE__, {:release_stop, identity})
  def confirm_stop(identity), do: GenServer.call(__MODULE__, {:confirm_stop, identity})

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:reconcile, identity}, _from, claim) do
    {:reply, :ok, if(match?({^identity, _}, claim), do: claim, else: nil)}
  end

  def handle_call({:claim_stop, identity}, _from, {identity, status} = claim),
    do: {:reply, status, claim}

  def handle_call({:claim_stop, identity}, _from, _claim),
    do: {:reply, :claimed, {identity, :unconfirmed}}

  def handle_call({:confirm_stop, identity}, _from, {identity, _}),
    do: {:reply, :ok, {identity, :already_claimed}}

  def handle_call({:confirm_stop, _identity}, _from, claim), do: {:reply, :ok, claim}

  def handle_call({:release_stop, identity}, _from, claim),
    do: {:reply, :ok, if(match?({^identity, _}, claim), do: nil, else: claim)}
end

defmodule Shuttle.Recorder do
  @moduledoc "Controls the one local live-voice recorder in a retained terminal."
  alias Shuttle.Runner
  alias Shuttle.Terminal.Tmux
  alias Shuttle.RetainedTerminal

  @session "hark-voice"
  @launch_option "@hark_launch"
  @active_phases ~w(loading live stopping)
  @command_timeout_ms 5_000
  @tmux_status_format "\#{pane_dead}|\#{pane_dead_status}|\#{session_created}|\#{@hark_launch}"

  @type tmux_status ::
          :absent
          | %{
              state: :alive | {:dead, integer()},
              session_created: integer(),
              launch: String.t() | nil
            }
  @type capture :: map() | nil

  @doc false
  @spec derive(tmux_status(), map() | nil, boolean(), String.t() | nil) ::
          {capture(), boolean()}
  def derive(tmux_status, capture_json, pid_alive?, pane_tail \\ nil) do
    fresh =
      if fresh_for_session?(tmux_status, capture_json) or
           (pid_alive? and compatible_launch?(tmux_status, capture_json)),
         do: capture_json,
         else: nil

    phase = if is_map(fresh), do: fresh["phase"], else: nil
    clean_end? = phase == "ended" and fresh["error"] in [nil, ""]

    case tmux_status do
      _ when phase in @active_phases and pid_alive? ->
        {capture_row(fresh, phase, tmux_status), false}

      _ when pid_alive? ->
        {capture_row(fresh, "failed", tmux_status, first_error(fresh["error"], pane_tail)), false}

      :absent ->
        if voice_document?(fresh) and phase != "ended",
          do: {capture_row(fresh, "failed", tmux_status), false},
          else: {nil, false}

      _ when phase == "failed" ->
        {capture_row(fresh, "failed", tmux_status, first_error(fresh["error"], pane_tail)), false}

      %{state: :alive} ->
        {capture_row(fresh, "starting", tmux_status), false}

      %{state: {:dead, 0}} when clean_end? ->
        {nil, true}

      %{state: {:dead, _status}} ->
        data = if is_map(fresh), do: fresh, else: %{}
        {capture_row(data, "failed", tmux_status, first_error(data["error"], pane_tail)), false}
    end
  end

  @doc "The recorder's current per-launch transcript, used for live speech previews."
  def current_transcript(opts \\ []) do
    with %{"kind" => "voice", "transcript" => path} when is_binary(path) <-
           read_capture_json(opts),
         do: {:ok, %{path: path}},
         else: (_ -> {:error, :not_found})
  end

  defp sources(available, opts) do
    cond do
      not available -> []
      Keyword.get(opts, :os_type, :os.type()) == {:unix, :darwin} -> ~w(desktop phone)
      true -> ~w(phone)
    end
  end

  @doc false
  def show(opts \\ []) do
    with {:ok, snapshot, _context} <- inspect_current(opts), do: {:ok, snapshot}
  end

  @doc false
  def reconcile_voice(enabled, opts \\ []) do
    with_recorder_lock(fn ->
      with {:ok, snapshot, context} <- inspect_current(opts),
           :ok <- sync_system_audio(snapshot, enabled, opts) do
        if snapshot.capture, do: sync_voice_mute(opts)

        cond do
          not enabled ->
            with :ok <- end_voice(snapshot, context, opts),
                 do: {:ok, %{snapshot | capture: nil}}

          snapshot.capture &&
              ((snapshot.capture.state != "starting" and
                  Keyword.get(opts, :source, source(snapshot.capture)) != source(snapshot.capture)) or
                 (snapshot.capture.state == "failed" and opts[:restart_voice])) ->
            with :ok <- end_voice(snapshot, context, opts), do: start_voice(opts)

          snapshot.capture ->
            {:ok, snapshot}

          true ->
            with :ok <- end_voice(snapshot, context, opts),
                 do: maybe_start_voice(opts, snapshot)
        end
      end
    end)
  end

  defp source(row), do: if(row[:phone], do: "phone", else: "desktop")

  # File observation wakes an idle, disabled Voice without shelling out. Boot
  # always performs a full observation, including retained orphan captures.
  @doc false
  def voice_observation_key(opts \\ []) do
    dir = hark_dir(opts)

    {Shuttle.FS.read(Path.join(dir, "meeting.json")),
     Shuttle.FS.exists?(Path.join(dir, "paused")),
     Shuttle.FS.exists?(Path.join(dir, "system-paused"))}
  end

  defp maybe_start_voice(opts, snapshot) do
    if Keyword.get(opts, :voice_start, true), do: start_voice(opts), else: {:ok, snapshot}
  end

  defp start_voice(opts) do
    with executable when is_binary(executable) <- find_hark(opts),
         launch <- "voice-" <> launch_id(),
         transcript <- Path.join([hark_dir(opts), "voice", launch <> ".txt"]),
         :ok <- Shuttle.FS.mkdir_p(Path.dirname(transcript)),
         :ok <- apply_voice_mute(executable, opts),
         started_at <- DateTime.to_iso8601(DateTime.utc_now()),
         :ok <-
           create_session(
             [
               executable,
               "--voice",
               "--settings",
               Shuttle.Voice.Config.path(),
               "--routes",
               Shuttle.Voice.routes_path(),
               "-o",
               transcript,
               "--launch=" <> launch,
               "--title=Live voice"
             ] ++
               if(Keyword.get(opts, :system_audio, false), do: ["--system-audio"], else: []) ++
               if(Keyword.get(opts, :source, "desktop") == "phone", do: ["--phone"], else: []),
             launch,
             opts
           ) do
      {:ok,
       %{
         available: true,
         sources: sources(true, opts),
         capture: %{
           kind: "voice",
           launch: launch,
           transcript: transcript,
           started_at: started_at,
           title: "Live voice",
           phone: Keyword.get(opts, :source, "desktop") == "phone",
           state: "starting",
           error: nil
         }
       }}
    else
      nil -> {:error, :unavailable}
      error -> error
    end
  end

  @doc """
  The live mic level hark publishes during capture, as `%{mic: dBFS, at: iso8601}`,
  or nil when hark has written none within the last second.
  """
  def mic_level(opts \\ []) do
    with {:ok, bytes} <- Shuttle.FS.read(Path.join(hark_dir(opts), "level.json")),
         {:ok, %{"mic" => mic, "t" => t}} when is_number(mic) and is_number(t) <-
           Jason.decode(bytes),
         at_ms = round(t * 1000),
         true <- System.os_time(:millisecond) - at_ms < 1000 do
      %{mic: mic, at: at_ms |> DateTime.from_unix!(:millisecond) |> DateTime.to_iso8601()}
    else
      _ -> nil
    end
  end

  @doc false
  def voice_muted?(opts \\ []), do: Shuttle.FS.exists?(Path.join(hark_dir(opts), "voice-muted"))

  @doc false
  def mute_voice(muted, opts \\ []) do
    with_recorder_lock(fn ->
      path = Path.join(hark_dir(opts), "voice-muted")

      with :ok <- Shuttle.FS.mkdir_p(hark_dir(opts)),
           :ok <- if(muted, do: Shuttle.FS.write(path, ""), else: remove_flag(path)),
           {:ok, snapshot, _context} <- inspect_current(opts) do
        if snapshot.capture, do: apply_voice_mute(find_hark(opts), opts), else: :ok
      end
    end)
  end

  defp sync_voice_mute(opts) do
    path = Path.join(hark_dir(opts), "voice-muted")

    if Shuttle.FS.exists?(Path.join(hark_dir(opts), "paused")),
      do: Shuttle.FS.write(path, ""),
      else: remove_flag(path)
  end

  defp remove_flag(path) do
    case Shuttle.FS.rm(path) do
      {:error, :enoent} -> :ok
      result -> result
    end
  end

  defp apply_voice_mute(executable, opts),
    do: set_track_pause(executable, voice_muted?(opts), [], opts)

  defp voice_document?(%{} = data),
    do: data["kind"] == "voice" or String.starts_with?(launch_from(data) || "", "voice-")

  defp voice_document?(_), do: false

  defp end_voice(snapshot, context, opts) do
    grace = Keyword.get(opts, :voice_stop_wait_ms, 3_000)

    case stop_current(snapshot, context, opts) do
      {:ok, _} ->
        await_voice_end(context, opts, System.monotonic_time(:millisecond) + grace)

      {:error, _} ->
        force_voice_end(context, opts)
    end
  end

  defp await_voice_end(context, opts, deadline) do
    case pid_observation(context.capture_json, opts) do
      :not_hark ->
        kill_launch(context.tmux, opts)

      _ ->
        if System.monotonic_time(:millisecond) >= deadline do
          force_voice_end(context, opts)
        else
          Process.sleep(50)
          await_voice_end(context, opts, deadline)
        end
    end
  end

  defp force_voice_end(context, opts) do
    # Closing a retained terminal is not evidence that its child released
    # the microphone. Verify the original recorder PID before proceeding.
    case pid_observation(context.capture_json, opts) do
      :not_hark ->
        kill_launch(context.tmux, opts)

      :hark ->
        run(opts, "kill", ["-KILL", valid_pid(context.capture_json)])
        deadline = System.monotonic_time(:millisecond) + 1_000
        await_voice_exit(context, opts, deadline)

      :unknown ->
        {:error, {:operation, "could not verify live voice exited"}}
    end
  end

  defp await_voice_exit(context, opts, deadline) do
    cond do
      pid_observation(context.capture_json, opts) == :not_hark ->
        kill_launch(context.tmux, opts)

      System.monotonic_time(:millisecond) >= deadline ->
        {:error, {:operation, "live voice process did not exit"}}

      true ->
        Process.sleep(10)
        await_voice_exit(context, opts, deadline)
    end
  end

  defp sync_system_audio(%{capture: %{state: "live", phone: false}}, true, opts) do
    case Keyword.fetch(opts, :system_audio) do
      {:ok, enabled} ->
        paused = Shuttle.FS.exists?(Path.join(hark_dir(opts), "system-paused"))

        if paused == enabled,
          do: set_track_pause(find_hark(opts), not enabled, ["--system"], opts),
          else: :ok

      :error ->
        :ok
    end
  end

  defp sync_system_audio(_snapshot, _enabled, _opts), do: :ok

  @doc "Apply the system transcription gate to the live recorder."
  def system_audio(enabled, opts \\ []) do
    with_recorder_lock(fn ->
      with {:ok, snapshot, _} <- inspect_current(opts) do
        if snapshot.capture && not snapshot.capture.phone,
          do: set_track_pause(find_hark(opts), not enabled, ["--system"], opts),
          else: :ok
      end
    end)
  end

  defp set_track_pause(nil, _paused, _track, _opts), do: {:error, :unavailable}

  defp set_track_pause(executable, paused, track, opts) do
    case run(
           opts,
           "env",
           [
             "HARK_DIR=" <> hark_dir(opts),
             executable,
             if(paused, do: "pause", else: "resume")
           ] ++ track
         ) do
      {_output, 0} ->
        :ok

      {output, status} ->
        {:error, {:operation, "could not change hark pause (#{status}): #{String.trim(output)}"}}
    end
  end

  @doc """
  Where the live phone capture takes its audio: hark's Unix socket, named in
  `meeting.json` as `phone`, with the launch id of the capture it belongs to.
  `:pending` while a launch has not yet written its lifecycle file; the socket
  itself is bound only once hark's models load, so a connect may still be
  refused for a while after `{:ok, _}`.
  """
  @spec phone_socket(keyword()) ::
          {:ok, %{path: String.t(), launch: String.t() | nil}}
          | :pending
          | {:error, :none | :not_phone | :ended | {:failed, String.t() | nil} | term()}
  def phone_socket(opts \\ []) do
    with {:ok, observed} <- observe(opts) do
      {row, _reap?} =
        derive(observed.tmux, observed.raw_capture, observed.pid_alive?)

      phone_target(row, observed.capture_json)
    end
  end

  defp phone_target(nil, _capture_json), do: {:error, :none}
  defp phone_target(%{state: "starting"}, _capture_json), do: :pending
  defp phone_target(%{state: "stopping"}, _capture_json), do: {:error, :ended}

  defp phone_target(%{state: "failed", error: error}, _capture_json),
    do: {:error, {:failed, error}}

  defp phone_target(%{state: state}, capture_json) when state in ["loading", "live"] do
    case phone_path(capture_json) do
      nil -> {:error, :not_phone}
      path -> {:ok, %{path: path, launch: launch_from(capture_json)}}
    end
  end

  defp phone_path(%{"phone" => path}) when is_binary(path) and path != "", do: path
  defp phone_path(_capture_json), do: nil

  def rex?(opts \\ []), do: RetainedTerminal.rex?(opts)

  @doc false
  @spec parse_tmux_result(String.t(), non_neg_integer() | :timeout) ::
          {:ok, tmux_status()} | {:error, term()}
  def parse_tmux_result(output, 0) do
    case output |> String.trim() |> String.split("|", trim: false) do
      [dead, exit_status, created, launch] ->
        with {:ok, session_created} <- parse_integer(created),
             {:ok, state} <- parse_dead(dead, exit_status) do
          {:ok,
           %{
             state: state,
             session_created: session_created,
             launch: blank_to_nil(launch)
           }}
        else
          _ -> {:error, {:tmux, "invalid pane status: #{String.trim(output)}"}}
        end

      _ ->
        {:error, {:tmux, "invalid pane status: #{String.trim(output)}"}}
    end
  end

  def parse_tmux_result(output, _status) do
    if Tmux.absence_message?(output),
      do: {:ok, :absent},
      else: {:error, {:tmux, String.trim(output)}}
  end

  defp create_session(argv, launch_id, opts) do
    if rex?(opts) do
      RetainedTerminal.start(
        @session,
        home_dir(opts),
        argv,
        %{"launch" => launch_id},
        recorder_runner(opts),
        Keyword.merge(opts, env: %{"HARK_DIR" => hark_dir(opts)})
      )
    else
      create_tmux_session(argv, launch_id, opts)
    end
  end

  defp create_tmux_session(argv, launch_id, opts) do
    command = "exec " <> Enum.map_join(argv, " ", &shell_quote/1)

    args =
      [
        "new-session",
        "-d",
        "-P",
        "-F",
        "\#{session_id}",
        "-s",
        @session,
        "-c",
        home_dir(opts),
        "-e",
        "HARK_DIR=" <> hark_dir(opts),
        "--",
        command,
        ";",
        "set-option",
        "-t",
        "=" <> @session <> ":",
        @launch_option,
        launch_id
      ] ++
        [
          ";",
          "set-option",
          "-w",
          "-t",
          "=" <> @session <> ":",
          "remain-on-exit",
          "on"
        ]

    # Once the session exists hark may be recording, so only a launch that
    # provably created nothing is an error; anything after that is observed.
    {output, status} = run(opts, "tmux", args)

    cond do
      status == 0 or created_session_id?(output) ->
        :ok

      match?({:ok, %{launch: ^launch_id}}, tmux_status(opts)) ->
        :ok

      true ->
        {:error, {:operation, "tmux could not start hark (#{status}): #{String.trim(output)}"}}
    end
  end

  # Start, stop and reaping share one lock. It is reentrant within a process, so
  # a reap reached from the launch wait (already locked) doesn't lock twice.
  defp with_recorder_lock(fun) do
    if Process.get(:shuttle_capture_lock) do
      fun.()
    else
      :global.trans({{__MODULE__, :capture}, self()}, fn ->
        Process.put(:shuttle_capture_lock, true)

        try do
          fun.()
        after
          Process.delete(:shuttle_capture_lock)
        end
      end)
    end
  end

  defp created_session_id?(output), do: Regex.match?(~r/^\$[0-9]+$/m, output)

  defp shell_quote(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"

  # The retained session, hark's lifecycle file as read and as trusted for that
  # launch, and whether its pid is still hark.
  defp observe(opts) do
    if rex?(opts), do: observe_retained(opts), else: observe_tmux(opts)
  end

  defp observe_tmux(opts) do
    with {:ok, tmux} <- tmux_status(opts) do
      raw_capture = read_capture_json(opts)
      usable_capture = if compatible_launch?(tmux, raw_capture), do: raw_capture, else: nil

      {:ok,
       %{
         tmux: tmux,
         raw_capture: raw_capture,
         capture_json: usable_capture,
         pid_alive?: pid_mentions_hark?(usable_capture, opts)
       }}
    end
  end

  defp observe_retained(opts) do
    case RetainedTerminal.observe(@session, recorder_runner(opts), opts) do
      :gone ->
        raw_capture = read_capture_json(opts)

        {:ok,
         %{
           tmux: :absent,
           raw_capture: raw_capture,
           capture_json: raw_capture,
           pid_alive?: pid_mentions_hark?(raw_capture, opts)
         }}

      {:ok, retained} ->
        metadata = retained.metadata
        launch = metadata["launch"]
        raw_capture = read_capture_json(opts)

        usable_capture =
          if is_map(raw_capture) and raw_capture["launch"] == launch,
            do: raw_capture,
            else: nil

        tmux = %{
          state: if(retained.dead, do: {:dead, retained.exit_status || 1}, else: :alive),
          session_created: retained.created,
          launch: launch
        }

        {:ok,
         %{
           tmux: tmux,
           raw_capture: usable_capture,
           capture_json: usable_capture,
           pid_alive?: pid_mentions_hark?(usable_capture, opts),
           retained: retained
         }}

      {:error, reason} ->
        {:error, {:retained_terminal, reason}}
    end
  end

  defp recorder_runner(opts),
    do: Keyword.get(opts, :runner, Shuttle.Env.app(:recorder_runner, Runner.Default))

  defp inspect_current(opts) do
    with {:ok, %{tmux: tmux, raw_capture: raw_capture, capture_json: usable_capture} = observed} <-
           observe(opts) do
      pid_alive? = observed.pid_alive?

      tail =
        cond do
          rex?(opts) and failed_dead_pane?(tmux, usable_capture) ->
            get_in(observed, [:retained, :screen]) |> Enum.join("\n") |> blank_to_nil()

          failed_dead_pane?(tmux, usable_capture) ->
            pane_tail(opts)

          true ->
            nil
        end

      {capture, reap?} = derive(tmux, raw_capture, pid_alive?, tail)
      :ok = Shuttle.Recorder.Control.reconcile(capture_identity(tmux, usable_capture, pid_alive?))

      with :ok <- if(reap?, do: with_recorder_lock(fn -> kill_launch(tmux, opts) end), else: :ok) do
        available = not is_nil(find_hark(opts))

        {:ok,
         %{
           available: available,
           sources: sources(available, opts),
           capture: capture
         },
         %{
           tmux: tmux,
           capture_json: usable_capture,
           capture: capture,
           retained: observed[:retained]
         }}
      end
    end
  end

  defp stop_current(%{capture: nil} = snapshot, _context, _opts), do: {:ok, snapshot}

  defp stop_current(%{capture: %{state: "stopping"}}, _context, opts), do: show(opts)

  defp stop_current(%{capture: %{state: state}}, context, opts)
       when state in ["loading", "live"],
       do: signal_stop(context, opts)

  defp stop_current(%{capture: %{state: state}}, context, opts)
       when state in ["starting", "failed"] do
    if rex?(opts) do
      if is_integer(context.retained && context.retained.pid) and not context.retained.dead do
        signal_stop(context, opts, context.retained.pid, context.tmux.launch)
      else
        with :ok <- kill_launch(context.tmux, opts), do: show(opts)
      end
    else
      case pid_observation(context.capture_json, opts) do
        :hark ->
          signal_stop(context, opts)

        :not_hark ->
          with :ok <- kill_launch(context.tmux, opts), do: show(opts)

        :unknown ->
          {:error, {:operation, "could not determine whether the capture process is hark"}}
      end
    end
  end

  defp signal_stop(context, opts) do
    signal_stop(context, opts, valid_pid(context.capture_json), launch_from(context.capture_json))
  end

  defp signal_stop(_context, opts, pid, launch) do
    pid = if is_integer(pid), do: Integer.to_string(pid), else: pid

    with pid when not is_nil(pid) <- pid,
         :claimed <- Shuttle.Recorder.Control.claim_stop({pid, launch}),
         {_output, 0} <- run(opts, "kill", ["-INT", pid]) do
      Shuttle.Recorder.Control.confirm_stop({pid, launch})
      show(opts)
    else
      :already_claimed ->
        show(opts)

      :unconfirmed ->
        {:error, {:operation, "capture stop is unconfirmed"}}

      nil ->
        {:error, {:operation, "capture process has no valid pid"}}

      {output, status} ->
        if is_integer(status), do: Shuttle.Recorder.Control.release_stop({pid, launch})
        {:error, {:operation, "could not signal hark (#{status}): #{String.trim(output)}"}}
    end
  end

  defp read_capture_json(opts) do
    case Shuttle.FS.read(Path.join(hark_dir(opts), "meeting.json")) do
      {:ok, content} ->
        case Jason.decode(content) do
          {:ok, data} when is_map(data) -> data
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp pid_mentions_hark?(capture_json, opts), do: pid_observation(capture_json, opts) == :hark

  defp pid_observation(capture_json, opts) do
    case valid_pid(capture_json) do
      nil ->
        :not_hark

      pid ->
        case run(opts, "ps", ["-p", pid, "-o", "command="]) do
          {command, 0} ->
            if String.contains?(String.downcase(command), "hark"), do: :hark, else: :not_hark

          {"", 1} ->
            case run(opts, "ps", ["-A", "-o", "pid="]) do
              {pids, 0} ->
                if pid in String.split(pids), do: :unknown, else: :not_hark

              _ ->
                :unknown
            end

          _ ->
            :unknown
        end
    end
  end

  defp valid_pid(%{"pid" => pid}) when is_integer(pid) and pid > 0,
    do: Integer.to_string(pid)

  defp valid_pid(%{"pid" => pid}) when is_binary(pid) do
    case Integer.parse(pid) do
      {value, ""} when value > 0 -> Integer.to_string(value)
      _ -> nil
    end
  end

  defp valid_pid(_), do: nil

  # An absent session answers `has-session` with tmux's absence message, which
  # `parse_tmux_result/2` reads as `:absent`.
  defp tmux_status(opts) do
    {output, status} =
      case run(opts, "tmux", ["has-session", "-t", "=" <> @session]) do
        {_output, 0} ->
          run(opts, "tmux", [
            "display-message",
            "-p",
            "-t",
            "=" <> @session <> ":",
            @tmux_status_format
          ])

        missing_or_failed ->
          missing_or_failed
      end

    parse_tmux_result(output, status)
  end

  defp parse_dead("0", _status), do: {:ok, :alive}

  defp parse_dead("1", status) do
    case parse_integer(status) do
      {:ok, exit_status} -> {:ok, {:dead, exit_status}}
      _ -> :error
    end
  end

  defp parse_dead(_, _), do: :error

  defp parse_integer(value) do
    case Integer.parse(String.trim(value)) do
      {integer, ""} -> {:ok, integer}
      _ -> :error
    end
  end

  defp blank_to_nil(value) do
    case String.trim(value) do
      "" -> nil
      value -> value
    end
  end

  # A missing launch stamp can be recovered through a live hark pid, but two
  # explicit, different launch ids must never be treated as the same recording.
  defp compatible_launch?(tmux, %{} = capture_json) do
    tmux_launch(tmux) in [nil, launch_from(capture_json)] or is_nil(launch_from(capture_json))
  end

  defp compatible_launch?(_tmux, _capture_json), do: false

  defp fresh_for_session?(:absent, capture_json), do: is_map(capture_json)

  defp fresh_for_session?(%{launch: launch}, capture_json) when is_binary(launch),
    do: is_map(capture_json) and capture_json["launch"] == launch

  defp fresh_for_session?(_tmux, _capture_json), do: false

  defp failed_dead_pane?(%{state: {:dead, status}}, capture_json),
    do:
      not (status == 0 and is_map(capture_json) and capture_json["phase"] == "ended" and
             capture_json["error"] in [nil, ""])

  defp failed_dead_pane?(_tmux, _capture_json), do: false

  defp pane_tail(opts) do
    case run(opts, "tmux", [
           "capture-pane",
           "-p",
           "-t",
           "=" <> @session <> ":",
           "-S",
           "-40"
         ]) do
      {output, _status} ->
        lines =
          output
          |> String.split("\n")
          |> Enum.map(&String.trim/1)
          |> Enum.reject(&(&1 == ""))
          |> Enum.take(-15)

        if lines == [], do: nil, else: Enum.join(lines, "\n")
    end
  end

  defp kill_session(opts) do
    case run(opts, "tmux", ["kill-session", "-t", "=" <> @session]) do
      {_output, 0} ->
        :ok

      {output, _status} ->
        if Tmux.absence_message?(output), do: :ok, else: {:error, {:tmux, String.trim(output)}}
    end
  end

  # Kill the hark-voice session only while it is still the launch that was
  # inspected; an unlocked reader (GET) must never kill a newer launch.
  defp kill_launch(%{launch: launch}, opts) do
    if rex?(opts) do
      case RetainedTerminal.observe(@session, recorder_runner(opts), opts) do
        {:ok, %{metadata: %{"launch" => ^launch}}} ->
          RetainedTerminal.stop(@session, recorder_runner(opts), opts)

        _ ->
          :ok
      end
    else
      case tmux_status(opts) do
        {:ok, %{launch: ^launch}} -> kill_session(opts)
        _ -> :ok
      end
    end
  end

  defp kill_launch(_tmux, _opts), do: :ok

  defp capture_row(data, state, tmux, error \\ nil) do
    data = if is_map(data), do: data, else: %{}
    tmux_exists? = tmux != :absent

    %{
      state: state,
      kind: "voice",
      title: data["title"],
      started_at: data["started"],
      tail: [],
      transcript: data["transcript"],
      phone: not is_nil(phone_path(data)),
      system_audio: data["system_audio"],
      launch: launch_from(data) || tmux_launch(tmux),
      tmux_session: if(tmux_exists?, do: @session, else: nil),
      error: error || data["error"]
    }
  end

  defp tmux_launch(%{launch: launch}), do: launch
  defp tmux_launch(_tmux), do: nil

  defp first_error(error, _fallback) when is_binary(error) and error != "", do: error
  defp first_error(_error, fallback) when is_binary(fallback) and fallback != "", do: fallback
  defp first_error(_error, _fallback), do: nil

  defp capture_identity(_tmux, %{} = data, true), do: identity_for(data)

  defp capture_identity(%{} = _tmux, %{"phase" => phase} = data, _pid_alive?)
       when phase in @active_phases do
    identity_for(data)
  end

  defp capture_identity(_tmux, _data, _pid_alive?), do: nil

  defp identity_for(data) do
    case valid_pid(data) do
      nil -> nil
      pid -> {pid, launch_from(data)}
    end
  end

  defp launch_from(%{"launch" => launch}) when is_binary(launch) and launch != "", do: launch
  defp launch_from(_), do: nil

  defp launch_id, do: Base.url_encode64(:crypto.strong_rand_bytes(18), padding: false)

  defp find_hark(opts) do
    configured = Keyword.get(opts, :hark_path, Shuttle.Env.app(:hark_path))

    candidates =
      case configured do
        false -> []
        path when is_binary(path) -> [path]
        _ -> [Shuttle.Env.find_executable("hark"), Shuttle.Env.expand("~/.local/bin/hark")]
      end

    Enum.find(candidates, &executable_file?/1)
    |> case do
      nil -> nil
      path -> Shuttle.Env.expand(path)
    end
  end

  defp executable_file?(path) when is_binary(path) and path != "" do
    case Shuttle.FS.stat(path) do
      {:ok, %File.Stat{type: :regular, mode: mode}} -> Bitwise.band(mode, 0o111) != 0
      _ -> false
    end
  end

  defp executable_file?(_), do: false

  defp hark_dir(opts) do
    Keyword.get(opts, :hark_dir) || Shuttle.Env.app(:hark_dir) ||
      case Shuttle.Env.get("HARK_DIR") do
        path when is_binary(path) and path != "" -> Shuttle.Env.expand(path)
        _ -> Shuttle.Env.expand("~/.hark")
      end
  end

  defp home_dir(opts) do
    Keyword.get(opts, :home_dir) ||
      case Shuttle.Env.get("HOME") do
        path when is_binary(path) and path != "" -> path
        _ -> Shuttle.Env.expand("~")
      end
  end

  defp run(opts, command, args) do
    runner =
      Keyword.get(opts, :runner, Shuttle.Env.app(:recorder_runner, Runner.Default))

    runner.cmd(command, args, stderr_to_stdout: true, timeout_ms: @command_timeout_ms)
  end
end
