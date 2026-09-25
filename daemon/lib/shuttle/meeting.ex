defmodule Shuttle.Meeting do
  @moduledoc """
  Starts and observes the local `hark meeting` capture in a dedicated tmux
  session. The transcript and `meeting.json` remain owned by hark; this module
  only reads their current state and controls the tmux session or hark process.
  """

  alias Shuttle.{Remote, Remotes, Runner, Tmux}

  @session "hark-meeting"
  @active_phases %{"loading" => true, "live" => true, "local" => true, "stopping" => true}
  @tail_bytes 8_192
  @command_timeout_ms 5_000

  @type tmux_status :: :absent | :alive | {:dead, integer()}
  @type meeting :: map() | nil

  @doc """
  Derive the public meeting row and whether a clean, dead session should be
  reaped. `pid_alive?` is true only when `ps` finds the pid and its command
  line mentions hark. `pane_tail` is used only as the failed-state fallback.
  """
  @spec derive(tmux_status(), map() | nil, boolean(), String.t() | nil) ::
          {meeting(), boolean()}
  def derive(tmux_status, meeting_json, pid_alive?, pane_tail \\ nil)

  def derive(tmux_status, %{"phase" => phase} = data, true, _pane_tail)
      when is_map_key(@active_phases, phase) do
    {meeting_row(data, phase, tmux_status != :absent), false}
  end

  def derive(:alive, meeting_json, _pid_alive?, _pane_tail),
    do: {meeting_row(meeting_json || %{}, "starting", true), false}

  def derive({:dead, 0}, %{"phase" => "ended"}, _pid_alive?, _pane_tail), do: {nil, true}

  def derive({:dead, _status}, meeting_json, _pid_alive?, pane_tail) do
    data = if is_map(meeting_json), do: meeting_json, else: %{}
    {meeting_row(data, "failed", true, first_error(data["error"], pane_tail)), false}
  end

  def derive(:absent, _meeting_json, _pid_alive?, _pane_tail), do: {nil, false}

  @doc "Current local hark availability and meeting state."
  @spec show(keyword()) :: {:ok, map()} | {:error, term()}
  def show(opts \\ []) do
    with {:ok, snapshot, _context} <- inspect_current(opts), do: {:ok, snapshot}
  end

  @doc "Validate and start one meeting in the local tmux server."
  @spec start(map(), keyword()) :: {:ok, map()} | {:error, term()}
  def start(params, opts \\ []) do
    case command_args(params, "hark") do
      {:ok, ["hark" | args]} ->
        with {:ok, snapshot, context} <- inspect_current(opts),
             :ok <- ensure_startable(snapshot),
             executable when is_binary(executable) <- find_hark(opts),
             :ok <- dismiss_failed(context, opts),
             :ok <- create_session([executable | args], opts),
             {:ok, result} <- show(opts) do
          {:ok, result}
        else
          nil -> {:error, :unavailable}
          {:error, _reason} = error -> error
        end

      {:error, _reason} = error ->
        error
    end
  end

  @doc "Stop the local meeting once, or dismiss a dead tmux pane."
  @spec stop(keyword()) :: {:ok, map()} | {:error, term()}
  def stop(opts \\ []) do
    with {:ok, snapshot, context} <- inspect_current(opts),
         {:ok, state} <- stop_current(snapshot, context, opts),
         {:ok, result} <- state do
      {:ok, result}
    end
  end

  @doc "The validated hark executable selected for this daemon."
  @spec hark_executable() :: String.t() | nil
  def hark_executable, do: find_hark([])

  @doc "Build hark's CLI arguments, including resolution of the scribe host."
  @spec command_args(map(), String.t()) :: {:ok, [String.t()]} | {:error, term()}
  def command_args(params, executable) when is_map(params) do
    title = Map.get(params, "title")
    host = Map.get(params, "host")
    project_dir = Map.get(params, "project_dir")
    under = Map.get(params, "under")
    mode = Map.get(params, "mode")

    with :ok <- validate_text(title, "title"),
         :ok <- validate_text(project_dir, "project_dir"),
         :ok <- validate_project_dir(project_dir),
         :ok <- validate_under(under),
         :ok <- validate_mode(mode),
         {:ok, ssh_host} <- resolve_host(host) do
      {:ok,
       [executable, "meeting", "--project", project_dir, "--under", under, "--title", title] ++
         if(ssh_host, do: ["--host", ssh_host], else: []) ++
         if(mode == "room", do: ["--room"], else: [])}
    end
  end

  def command_args(_params, _executable),
    do: {:error, {:validation, "request body must be a JSON object"}}

  defp validate_text(value, name) when is_binary(value) do
    cond do
      String.trim(value) == "" -> {:error, {:validation, "#{name} must not be blank"}}
      String.contains?(value, <<0>>) -> {:error, {:validation, "#{name} contains a NUL byte"}}
      true -> :ok
    end
  end

  defp validate_text(_value, name),
    do: {:error, {:validation, "#{name} is required"}}

  defp validate_project_dir(path) do
    if Path.type(path) == :absolute,
      do: :ok,
      else: {:error, {:validation, "project_dir must be an absolute path"}}
  end

  defp validate_under(path) when is_binary(path) do
    components = String.split(path, "/")

    if String.trim(path) != "" and Path.type(path) == :relative and
         Enum.all?(components, &(&1 not in ["", ".", ".."])) do
      :ok
    else
      {:error, {:validation, "under must be a loom-relative path without empty or dot segments"}}
    end
  end

  defp validate_under(_), do: {:error, {:validation, "under is required"}}

  defp validate_mode(mode) when mode in ["call", "room"], do: :ok
  defp validate_mode(_), do: {:error, {:validation, "mode must be 'call' or 'room'"}}

  defp resolve_host("local"), do: {:ok, nil}

  defp resolve_host(host) when is_binary(host) and host != "" do
    case Enum.find(Remotes.configured(), &(&1.name == host)) do
      %Remote{} = remote ->
        case Remote.ssh_host(remote) do
          ssh when is_binary(ssh) and ssh != "" -> {:ok, ssh}
          _ -> {:error, {:validation, "remote host #{host} has no SSH alias configured"}}
        end

      nil ->
        {:error, {:validation, "unknown remote host: #{host}"}}
    end
  end

  defp resolve_host(_), do: {:error, {:validation, "host is required"}}

  defp ensure_startable(%{meeting: nil}), do: :ok

  defp ensure_startable(%{meeting: %{state: state}} = snapshot)
       when state in ["starting", "loading", "live", "local", "stopping"],
       do: {:error, {:conflict, snapshot.meeting}}

  defp ensure_startable(%{meeting: %{state: "failed"}}), do: :ok

  defp dismiss_failed(%{meeting: %{state: "failed"}}, opts), do: kill_session(opts)
  defp dismiss_failed(_context, _opts), do: :ok

  defp create_session(argv, opts) do
    # tmux executes a shell command in the new pane. Quote every argv element
    # as one POSIX shell word so titles and paths with whitespace or quotes stay
    # data; no request value is interpolated as shell syntax.
    command = "exec " <> Enum.map_join(argv, " ", &shell_quote/1)

    args = [
      "new-session",
      "-d",
      "-s",
      @session,
      "-c",
      home_dir(),
      "--",
      command,
      ";",
      "set-option",
      "-w",
      "-t",
      "=" <> @session,
      "remain-on-exit",
      "on"
    ]

    case run(opts, "tmux", args) do
      {_output, 0} ->
        :ok

      {output, status} ->
        _ = kill_session(opts)
        {:error, {:operation, "tmux could not start hark (#{status}): #{String.trim(output)}"}}
    end
  end

  defp shell_quote(value) do
    "'" <> String.replace(value, "'", "'\\''") <> "'"
  end

  defp inspect_current(opts) do
    with {:ok, tmux_status} <- tmux_status(opts) do
      meeting_json = read_meeting_json(opts)
      pid_alive? = pid_mentions_hark?(meeting_json, opts)
      tail = if failed_dead_pane?(tmux_status, meeting_json), do: pane_tail(opts), else: nil
      {meeting, reap?} = derive(tmux_status, meeting_json, pid_alive?, tail)

      with :ok <- if(reap?, do: kill_session(opts), else: :ok) do
        meeting =
          if is_map(meeting) do
            Map.put(meeting, :last_line, last_transcript_line(meeting.transcript))
          else
            nil
          end

        snapshot = %{available: not is_nil(find_hark(opts)), meeting: meeting}
        context = %{tmux_status: tmux_status, meeting_json: meeting_json, meeting: meeting}
        {:ok, snapshot, context}
      end
    end
  end

  defp stop_current(%{meeting: nil}, _context, _opts), do: {:error, :not_found}

  defp stop_current(%{meeting: %{state: state}}, _context, opts) when state == "stopping",
    do: {:ok, show(opts)}

  defp stop_current(%{meeting: %{state: state}}, context, opts)
       when state in ["loading", "live", "local"] do
    with pid when not is_nil(pid) <- valid_pid(context.meeting_json),
         {output, 0} <- run(opts, "kill", ["-INT", pid]) do
      _ = output
      {:ok, show(opts)}
    else
      nil ->
        {:error, {:operation, "meeting process has no valid pid"}}

      {output, status} ->
        {:error, {:operation, "could not signal hark (#{status}): #{String.trim(output)}"}}
    end
  end

  defp stop_current(%{meeting: %{state: state}}, _context, opts)
       when state in ["starting", "failed"] do
    with :ok <- kill_session(opts), do: {:ok, show(opts)}
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

  defp valid_pid(%{"pid" => pid}) when is_integer(pid) and pid > 0, do: Integer.to_string(pid)

  defp valid_pid(%{"pid" => pid}) when is_binary(pid) do
    case Integer.parse(pid) do
      {value, ""} when value > 0 -> Integer.to_string(value)
      _ -> nil
    end
  end

  defp valid_pid(_), do: nil

  defp tmux_status(opts) do
    case run(opts, "tmux", [
           "display-message",
           "-p",
           "-t",
           "=" <> @session,
           "\#{pane_dead} \#{pane_dead_status}"
         ]) do
      {output, 0} ->
        parse_pane_status(output)

      {output, _status} ->
        if Tmux.absence_message?(output),
          do: {:ok, :absent},
          else: {:error, {:tmux, String.trim(output)}}
    end
  end

  defp parse_pane_status(output) do
    case String.split(String.trim(output)) do
      ["0"] ->
        {:ok, :alive}

      ["0", _status] ->
        {:ok, :alive}

      ["1", status] ->
        case Integer.parse(status) do
          {value, ""} -> {:ok, {:dead, value}}
          _ -> {:error, {:tmux, "invalid pane status: #{String.trim(output)}"}}
        end

      _ ->
        {:error, {:tmux, "invalid pane status: #{String.trim(output)}"}}
    end
  end

  defp failed_dead_pane?({:dead, status}, meeting_json),
    do: not (status == 0 and is_map(meeting_json) and meeting_json["phase"] == "ended")

  defp failed_dead_pane?(_status, _meeting_json), do: false

  defp pane_tail(opts) do
    case run(opts, "tmux", ["capture-pane", "-p", "-t", "=" <> @session, "-S", "-40"]) do
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
    %{
      state: state,
      title: data["title"],
      host: data["host"],
      fiber: data["fiber"],
      started_at: data["started"],
      last_line: nil,
      transcript: data["transcript"],
      tmux_session: if(tmux_exists?, do: @session, else: nil),
      error: error
    }
  end

  defp first_error(error, _fallback) when is_binary(error) and error != "", do: error
  defp first_error(_error, fallback) when is_binary(fallback) and fallback != "", do: fallback
  defp first_error(_error, _fallback), do: nil

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

  defp home_dir do
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
