defmodule Shuttle.Meeting.Control do
  @moduledoc false
  use GenServer

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, nil, Keyword.put(opts, :name, __MODULE__))

  def reconcile(identity), do: GenServer.call(__MODULE__, {:reconcile, identity})
  def claim_stop(identity), do: GenServer.call(__MODULE__, {:claim_stop, identity})

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:reconcile, identity}, _from, claim) do
    {:reply, :ok, if(claim == identity, do: claim, else: nil)}
  end

  def handle_call({:claim_stop, identity}, _from, identity),
    do: {:reply, :already_claimed, identity}

  def handle_call({:claim_stop, identity}, _from, _claim),
    do: {:reply, :claimed, identity}
end

defmodule Shuttle.Meeting do
  @moduledoc """
  Starts and observes the local hark capture in a dedicated tmux session.
  The transcript and `meeting.json` remain owned by hark; this module controls
  the local capture and derives its state from hark's lifecycle and tmux.
  """

  alias Shuttle.{Remote, Remotes, Runner, Tmux}

  @session "hark-meeting"
  @launch_option "@hark_launch"
  @active_phases ~w(loading live stopping)
  @tail_bytes 8_192
  @command_timeout_ms 5_000
  @tmux_status_format "\#{pane_dead}|\#{pane_dead_status}|\#{session_created}|\#{@hark_launch}"

  @type tmux_status ::
          :absent
          | %{state: :alive, session_created: integer(), launch: String.t() | nil}
          | %{state: {:dead, integer()}, session_created: integer(), launch: String.t() | nil}
  @type meeting :: map() | nil

  @doc false
  @spec derive(tmux_status(), map() | nil, boolean(), String.t() | nil) ::
          {meeting(), boolean()}
  def derive(tmux_status, meeting_json, pid_alive?, pane_tail \\ nil) do
    fresh = if fresh_for_session?(tmux_status, meeting_json), do: meeting_json, else: nil
    phase = if is_map(fresh), do: fresh["phase"], else: nil
    clean_end? = phase == "ended" and fresh["error"] in [nil, ""]

    case tmux_status do
      :absent ->
        if phase in @active_phases and pid_alive?,
          do: {meeting_row(fresh, phase, false), false},
          else: {nil, false}

      %{state: :alive} ->
        if phase in @active_phases and pid_alive?,
          do: {meeting_row(fresh, phase, true), false},
          else: {meeting_row(fresh, "starting", true), false}

      %{state: {:dead, 0}} when clean_end? ->
        {nil, true}

      %{state: {:dead, _status}} ->
        data = if is_map(fresh), do: fresh, else: %{}
        {meeting_row(data, "failed", true, first_error(data["error"], pane_tail)), false}
    end
  end

  @doc "Current local hark availability and meeting state."
  @spec show(keyword()) :: {:ok, map()} | {:error, term()}
  def show(opts \\ []) do
    with {:ok, snapshot, _context} <- inspect_current(opts), do: {:ok, snapshot}
  end

  @doc "Start hark locally and prepare the ordinary capture prompt."
  @spec start_capture(map(), String.t() | nil, String.t() | nil, String.t() | nil, keyword()) ::
          {:ok, %{meeting: map(), prompt: String.t()}} | {:error, term()}
  def start_capture(meeting, note, origin, surface, opts \\ []) do
    :global.trans({{__MODULE__, :start_capture}, self()}, fn ->
      do_start_capture(meeting, note, origin, surface, opts)
    end)
  end

  @doc "Stop the local meeting once, or dismiss a dead tmux pane."
  @spec stop(keyword()) :: {:ok, map()} | {:error, term()}
  def stop(opts \\ []) do
    with {:ok, snapshot, context} <- inspect_current(opts),
         {:ok, result} <- stop_current(snapshot, context, opts) do
      {:ok, result}
    end
  end

  @doc "The validated hark executable selected for this daemon."
  @spec hark_executable() :: String.t() | nil
  def hark_executable, do: find_hark([])

  @doc "Derive the meeting name and title from the first line of a note."
  @spec name_and_title(String.t() | nil, NaiveDateTime.t()) :: {String.t(), String.t()}
  def name_and_title(note, now \\ NaiveDateTime.local_now()) do
    first_line =
      (note || "")
      |> String.split(["\n", "\r"], parts: 2)
      |> List.first()
      |> String.trim()

    title = if first_line == "", do: "Meeting", else: String.slice(first_line, 0, 80)

    slug =
      first_line
      |> String.split(~r/\s+/u, trim: true)
      |> Enum.take(6)
      |> Enum.map(&slug_word/1)
      |> Enum.reject(&(&1 == ""))
      |> Enum.join("-")

    timestamp = Calendar.strftime(now, "%Y-%m-%d_%H%M")
    {if(slug == "", do: timestamp, else: timestamp <> "_" <> slug), title}
  end

  @doc """
  The facts a meeting capture's agent needs; the procedure lives in the shuttle
  skill's `references/meeting.md`.
  """
  @spec meeting_message(String.t(), String.t()) :: String.t()
  def meeting_message(mode, transcript_path) when mode in ["call", "room"] do
    "Meeting mode (#{mode}). hark is transcribing a live meeting to `#{transcript_path}` on this host. " <>
      "Read the shuttle skill's references/meeting.md before anything else and follow it. " <>
      "The user's note about the meeting follows (it may be empty)."
  end

  @doc "Resolve capture paths and remote mirror settings for a meeting."
  @spec meeting_paths(String.t(), String.t() | nil, keyword()) ::
          {:ok, map()} | {:error, term()}
  def meeting_paths(name, origin, opts \\ []) do
    local_transcript = Path.join([hark_dir(opts), "meetings", name <> ".txt"])

    case mirror_destination(origin, opts) do
      {:ok, nil, nil} ->
        {:ok,
         %{
           transcript: local_transcript,
           local_transcript: local_transcript,
           mirror: nil,
           mirror_host: nil
         }}

      {:ok, remote, ssh_alias} ->
        remote_transcript = "~/.hark/meetings/#{name}.txt"

        {:ok,
         %{
           transcript: remote_transcript,
           local_transcript: local_transcript,
           mirror: "#{ssh_alias}:#{remote_transcript}",
           mirror_host: remote.name
         }}

      {:error, _reason} = error ->
        error
    end
  end

  @doc false
  @spec parse_tmux_result(String.t(), non_neg_integer() | :timeout) ::
          {:ok, tmux_status()} | {:error, term()}
  def parse_tmux_result(output, 0) do
    case output |> String.trim() |> String.split("|", trim: false) do
      [dead, exit_status, created, launch] ->
        with {:ok, session_created} <- parse_integer(created),
             {:ok, state} <- parse_dead(dead, exit_status) do
          {:ok, %{state: state, session_created: session_created, launch: blank_to_nil(launch)}}
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

  defp do_start_capture(meeting, note, origin, surface, opts) do
    with {:ok, mode} <- validate_meeting(meeting),
         {:ok, note} <- validate_note(note),
         executable when is_binary(executable) <- find_hark(opts),
         {:ok, snapshot, context} <- inspect_current(opts),
         :ok <- ensure_startable(snapshot),
         :ok <- validate_surface(surface),
         {name, title} <-
           name_and_title(
             note,
             Keyword.get(
               opts,
               :now,
               Application.get_env(:shuttle, :meeting_now, NaiveDateTime.local_now())
             )
           ),
         {:ok, paths} <- meeting_paths(name, origin, opts),
         :ok <- File.mkdir_p(Path.dirname(paths.local_transcript)),
         :ok <- dismiss_failed(context, opts),
         launch_id <- launch_id(),
         argv <- hark_argv(executable, paths, title, mode, launch_id),
         :ok <- create_session(argv, launch_id, opts),
         {:ok, result} <- show(opts) do
      message = meeting_message(mode, paths.transcript)
      {:ok, %{meeting: result.meeting, prompt: message <> "\n\n" <> note}}
    else
      nil -> {:error, :unavailable}
      {:error, _reason} = error -> error
    end
  end

  defp validate_meeting(%{"mode" => mode}) when mode in ["call", "room"], do: {:ok, mode}

  defp validate_meeting(_),
    do: {:error, {:validation, "meeting.mode must be 'call' or 'room'"}}

  defp validate_surface("app"),
    do: {:error, {:validation, "meeting mode requires a terminal capture surface"}}

  defp validate_surface(_), do: :ok

  defp validate_note(nil), do: {:ok, ""}

  defp validate_note(note) when is_binary(note) do
    if String.contains?(note, <<0>>),
      do: {:error, {:validation, "prompt contains a NUL byte"}},
      else: {:ok, note}
  end

  defp validate_note(_), do: {:error, {:validation, "prompt must be a string"}}

  defp ensure_startable(%{meeting: nil}), do: :ok

  defp ensure_startable(%{meeting: %{state: state}} = snapshot)
       when state in ["starting", "loading", "live", "stopping"],
       do: {:error, {:conflict, snapshot.meeting}}

  defp ensure_startable(%{meeting: %{state: "failed"}}), do: :ok

  defp dismiss_failed(%{meeting: %{state: "failed"}}, opts), do: kill_session(opts)
  defp dismiss_failed(_context, _opts), do: :ok

  defp hark_argv(executable, paths, title, mode, launch_id) do
    [executable, "-o", paths.local_transcript, "--launch", launch_id, "--title", title] ++
      if(mode == "room", do: ["--room"], else: []) ++
      if(paths.mirror, do: ["--mirror", paths.mirror], else: [])
  end

  defp create_session(argv, launch_id, opts) do
    command = "exec " <> Enum.map_join(argv, " ", &shell_quote/1)

    args = [
      "new-session",
      "-d",
      "-P",
      "-F",
      "\#{session_id}",
      "-s",
      @session,
      "-c",
      home_dir(opts),
      "--",
      command,
      ";",
      "set-option",
      "-s",
      "-t",
      "=" <> @session,
      @launch_option,
      launch_id,
      ";",
      "set-option",
      "-w",
      "-t",
      "=" <> @session <> ":",
      "remain-on-exit",
      "on"
    ]

    {output, status} = run(opts, "tmux", args)
    created? = created_session_id?(output)

    if status == 0 and created? and session_launch(opts) == launch_id do
      :ok
    else
      if created? and session_launch(opts) == launch_id, do: kill_session(opts)

      {:error, {:operation, "tmux could not start hark (#{status}): #{String.trim(output)}"}}
    end
  end

  defp created_session_id?(output), do: Regex.match?(~r/^\$[0-9]+$/m, output)

  defp shell_quote(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"

  defp inspect_current(opts) do
    with {:ok, tmux} <- tmux_status(opts) do
      raw_meeting = read_meeting_json(opts)
      usable_meeting = if fresh_for_session?(tmux, raw_meeting), do: raw_meeting, else: nil
      pid_alive? = pid_mentions_hark?(usable_meeting, opts)
      tail = if failed_dead_pane?(tmux, usable_meeting), do: pane_tail(opts), else: nil
      {meeting, reap?} = derive(tmux, raw_meeting, pid_alive?, tail)
      identity = meeting_identity(tmux, usable_meeting, pid_alive?)
      :ok = Shuttle.Meeting.Control.reconcile(identity)

      with :ok <- if(reap?, do: kill_session(opts), else: :ok) do
        meeting =
          if is_map(meeting) do
            Map.put(meeting, :last_line, last_transcript_line(meeting.transcript))
          else
            nil
          end

        {:ok, %{available: not is_nil(find_hark(opts)), meeting: meeting},
         %{tmux: tmux, meeting_json: usable_meeting, meeting: meeting, identity: identity}}
      end
    end
  end

  defp stop_current(%{meeting: nil}, _context, _opts), do: {:error, :not_found}

  defp stop_current(%{meeting: %{state: "stopping"}}, _context, opts), do: show(opts)

  defp stop_current(%{meeting: %{state: state}}, context, opts)
       when state in ["loading", "live"] do
    with pid when not is_nil(pid) <- valid_pid(context.meeting_json),
         :claimed <- Shuttle.Meeting.Control.claim_stop({pid, launch_from(context.meeting_json)}),
         {output, 0} <- run(opts, "kill", ["-INT", pid]) do
      _ = output
      show(opts)
    else
      :already_claimed ->
        show(opts)

      nil ->
        {:error, {:operation, "meeting process has no valid pid"}}

      {output, status} ->
        {:error, {:operation, "could not signal hark (#{status}): #{String.trim(output)}"}}
    end
  end

  defp stop_current(%{meeting: %{state: "starting"}}, _context, opts) do
    with :ok <- kill_session(opts), do: show(opts)
  end

  defp stop_current(%{meeting: %{state: "failed"}}, _context, opts) do
    with :ok <- kill_session(opts), do: show(opts)
  end

  defp read_meeting_json(opts) do
    case File.read(Path.join(hark_dir(opts), "meeting.json")) do
      {:ok, content} ->
        case Jason.decode(content) do
          {:ok, data} when is_map(data) -> data
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp pid_mentions_hark?(meeting_json, opts) do
    with pid when not is_nil(pid) <- valid_pid(meeting_json),
         {command, 0} <- run(opts, "ps", ["-p", pid, "-o", "command="]) do
      command |> String.downcase() |> String.contains?("hark")
    else
      _ -> false
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

  defp tmux_status(opts) do
    case run(opts, "tmux", ["has-session", "-t", "=" <> @session]) do
      {_output, 0} ->
        {output, status} =
          run(opts, "tmux", [
            "display-message",
            "-p",
            "-t",
            "=" <> @session <> ":",
            @tmux_status_format
          ])

        parse_tmux_result(output, status)

      {output, _status} ->
        if Tmux.absence_message?(output),
          do: {:ok, :absent},
          else: {:error, {:tmux, String.trim(output)}}
    end
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

  defp fresh_for_session?(:absent, meeting_json), do: is_map(meeting_json)

  defp fresh_for_session?(%{launch: launch}, meeting_json) when is_binary(launch),
    do: is_map(meeting_json) and meeting_json["launch"] == launch

  defp fresh_for_session?(_tmux, _meeting_json), do: false

  defp failed_dead_pane?(%{state: {:dead, status}}, meeting_json),
    do:
      not (status == 0 and is_map(meeting_json) and meeting_json["phase"] == "ended" and
             meeting_json["error"] in [nil, ""])

  defp failed_dead_pane?(_tmux, _meeting_json), do: false

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

  defp session_launch(opts) do
    case tmux_status(opts) do
      {:ok, %{launch: launch}} -> launch
      _ -> nil
    end
  end

  defp last_transcript_line(path) when is_binary(path) and path != "" do
    case read_file_tail(path, @tail_bytes) do
      nil ->
        nil

      content ->
        content
        |> String.split("\n")
        |> Enum.map(&String.trim/1)
        |> Enum.reject(&(&1 == "" or String.starts_with?(&1, "#")))
        |> List.last()
    end
  end

  defp last_transcript_line(_), do: nil

  defp read_file_tail(path, limit) do
    case :file.open(String.to_charlist(path), [:read, :binary]) do
      {:ok, file} ->
        try do
          with {:ok, size} <- :file.position(file, :eof),
               {:ok, _} <- :file.position(file, max(size - limit, 0)),
               {:ok, data} <- :file.read(file, min(size, limit)) do
            data
          else
            _ -> nil
          end
        after
          :file.close(file)
        end

      _ ->
        nil
    end
  end

  defp meeting_row(data, state, tmux_exists?, error \\ nil) do
    data = if is_map(data), do: data, else: %{}

    %{
      state: state,
      title: data["title"],
      started_at: data["started"],
      last_line: nil,
      transcript: data["transcript"],
      mirror_host: mirror_host(data["mirror"]),
      tmux_session: if(tmux_exists?, do: @session, else: nil),
      error: error || data["error"]
    }
  end

  defp first_error(error, _fallback) when is_binary(error) and error != "", do: error
  defp first_error(_error, fallback) when is_binary(fallback) and fallback != "", do: fallback
  defp first_error(_error, _fallback), do: nil

  defp meeting_identity(:absent, %{"phase" => phase} = data, true)
       when phase in @active_phases do
    identity_for(data)
  end

  defp meeting_identity(%{} = _tmux, %{"phase" => phase} = data, _pid_alive?)
       when phase in @active_phases do
    identity_for(data)
  end

  defp meeting_identity(_tmux, _data, _pid_alive?), do: nil

  defp identity_for(data) do
    case valid_pid(data) do
      nil -> nil
      pid -> {pid, launch_from(data)}
    end
  end

  defp launch_from(%{"launch" => launch}) when is_binary(launch) and launch != "", do: launch
  defp launch_from(_), do: nil

  defp mirror_host(mirror) when is_binary(mirror) and mirror != "" do
    [alias_name | _] = String.split(mirror, ":", parts: 2)

    case Enum.find(Remotes.configured(), &(Remote.ssh_host(&1) == alias_name)) do
      %Remote{name: name} -> name
      nil -> alias_name
    end
  end

  defp mirror_host(_), do: nil

  defp mirror_destination(origin, opts) do
    case Shuttle.OriginRouter.route(origin, origin_router_opts(opts)) do
      :local ->
        {:ok, nil, nil}

      {:remote, %Remote{} = remote} ->
        case Remote.ssh_host(remote) do
          alias_name when is_binary(alias_name) and alias_name != "" -> {:ok, remote, alias_name}
          _ -> {:error, {:validation, "remote origin has no SSH alias for transcript mirroring"}}
        end
    end
  end

  defp origin_router_opts(opts) do
    opts
    |> Keyword.take([:own_host_id, :remotes])
    |> Keyword.put_new(:own_host_id, Shuttle.Poller.own_host_id())
  end

  defp slug_word(word) do
    word
    |> String.normalize(:nfd)
    |> String.replace(~r/\p{Mn}/u, "")
    |> String.downcase()
    |> String.replace(~r/[^\p{L}\p{N}]+/u, "-")
    |> String.trim("-")
  end

  defp launch_id, do: Base.url_encode64(:crypto.strong_rand_bytes(18), padding: false)

  defp find_hark(opts) do
    configured = Keyword.get(opts, :hark_path, Application.get_env(:shuttle, :hark_path))

    candidates =
      case configured do
        false -> []
        path when is_binary(path) -> [path]
        _ -> [System.find_executable("hark"), Path.expand("~/.local/bin/hark")]
      end

    Enum.find(candidates, &executable_file?/1)
    |> case do
      nil -> nil
      path -> Path.expand(path)
    end
  end

  defp executable_file?(path) when is_binary(path) and path != "" do
    case File.stat(path) do
      {:ok, %File.Stat{type: :regular, mode: mode}} -> Bitwise.band(mode, 0o111) != 0
      _ -> false
    end
  end

  defp executable_file?(_), do: false

  defp hark_dir(opts) do
    Keyword.get(opts, :hark_dir) || Application.get_env(:shuttle, :hark_dir) ||
      case System.get_env("HARK_DIR") do
        path when is_binary(path) and path != "" -> Path.expand(path)
        _ -> Path.expand("~/.hark")
      end
  end

  defp home_dir(opts) do
    Keyword.get(opts, :home_dir) ||
      case System.get_env("HOME") do
        path when is_binary(path) and path != "" -> path
        _ -> Path.expand("~")
      end
  end

  defp run(opts, command, args) do
    runner =
      Keyword.get(opts, :runner, Application.get_env(:shuttle, :meeting_runner, Runner.Default))

    runner.cmd(command, args, stderr_to_stdout: true, timeout_ms: @command_timeout_ms)
  end
end
