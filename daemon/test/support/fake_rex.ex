defmodule Shuttle.Test.FakeRex do
  @moduledoc "Fixture-backed Rex runner with observable calls and injected transport replies."
  use Agent

  def fixture(name),
    do: File.read!(Path.expand("../fixtures/rex/#{name}.json", __DIR__)) |> Jason.decode!()

  def start_link(_opts),
    do:
      Agent.start_link(fn ->
        %{sessions: %{}, order: [], creates: 0, calls: [], replies: %{}, clients: []}
      end)

  defp pid, do: Shuttle.Env.app(:fake_rex)
  def calls, do: Agent.get(pid(), &Enum.reverse(&1.calls))
  def reply(method, result), do: Agent.update(pid(), &put_in(&1, [:replies, method], result))

  def clear_reply(method),
    do: Agent.update(pid(), &update_in(&1.replies, fn map -> Map.delete(map, method) end))

  def sessions(sessions) do
    Agent.update(pid(), fn state ->
      retained = Enum.filter(state.order, &Map.has_key?(sessions, &1))
      added = Map.keys(sessions) -- retained
      %{state | sessions: sessions, order: retained ++ Enum.sort(added)}
    end)
  end

  def state, do: Agent.get(pid(), & &1)
  def clients(clients), do: Agent.update(pid(), &%{&1 | clients: clients})

  def cmd(bin, argv, opts) do
    {key, args, sid} = request(bin, argv, opts)
    if hook = Shuttle.Env.app(:fake_rex_hook), do: hook.(key)

    Agent.get_and_update(pid(), fn state ->
      state = %{state | calls: [{bin, argv, opts} | state.calls]}

      case Map.fetch(state.replies, key) do
        {:ok, response} ->
          {response, state}

        :error ->
          {result, state} = run(key, args, sid, state)
          response = if is_tuple(result), do: result, else: {Jason.encode!(result), 0}
          {response, state}
      end
    end)
  end

  defp request("tmux", args, _), do: {"tmux", args, nil}
  defp request("ps", args, _), do: {"ps", args, nil}
  defp request("open", args, _), do: {"open", args, nil}

  defp request(_, args, opts) do
    args = Enum.drop_while(args, &(&1 not in ["api", "whoami", "client", "send-key"]))

    case args do
      ["api", "call", "-s", sid, method, "-"] -> {method, Jason.decode!(opts[:input]), sid}
      ["api", "call", method, "-"] -> {method, Jason.decode!(opts[:input]), nil}
      ["whoami", "--json"] -> {"whoami", %{}, nil}
      ["client", "ls", "--json"] -> {"client.list", %{}, nil}
      ["send-key", "-s", sid, "-b", bid, key] -> {"send-key", %{bid: bid, key: key}, sid}
    end
  end

  defp run("tmux", [verb | _], _, state) when verb in ["has-session", "ls", "kill-session"],
    do: {{"no server running", 1}, state}

  defp run("ps", _, _, state), do: {{"", 0}, state}
  defp run("whoami", _, _, state), do: {fixture("whoami"), state}
  defp run("open", _, _, state), do: {{"", 0}, state}
  defp run("client.list", _, _, state), do: {%{"clients" => state.clients}, state}
  defp run("client.perform", _, _, state), do: {%{"performed_by" => "client:app"}, state}

  defp run("session.list", _, _, state) do
    {%{
       "sessions" =>
         Enum.map(state.order, fn sid ->
           %{"session_id" => sid, "label" => state.sessions[sid].label}
         end)
     }, state}
  end

  defp run("session.create", spec, _, state) do
    reply = fixture("session_create")
    suffix = if state.creates == 0, do: "", else: "-#{state.creates}"
    sid = reply["session_id"] <> suffix
    [window] = reply["initial_windows"]
    [bid] = window["block_ids"]
    bid = bid <> suffix

    reply =
      reply
      |> Map.put("session_id", sid)
      |> put_in(["initial_windows", Access.at(0), "block_ids"], [bid])
      |> put_in(["initial_windows", Access.at(0), "window_id"], window["window_id"] <> suffix)

    block = hd(spec["initial_windows"])["layout"]["block"]

    wid = window["window_id"] <> suffix

    session = %{
      label: spec["label"],
      windows: [%{"window_id" => wid, "label" => hd(spec["initial_windows"])["window_label"]}],
      window_label: hd(spec["initial_windows"])["window_label"],
      blocks: [
        %{"block_id" => bid, "label" => block["label"], "window_id" => wid}
      ]
    }

    state = %{
      state
      | sessions: Map.put(state.sessions, sid, session),
        order: state.order ++ [sid],
        creates: state.creates + 1
    }

    {reply, state}
  end

  defp run("session.new_window", spec, sid, state) do
    n = state.creates
    wid = "window:#{n}"
    bid = "block:#{n}"
    block = %{"block_id" => bid, "window_id" => wid, "label" => spec["layout"]["block"]["label"]}
    session = state.sessions[sid]
    windows = windows(session) ++ [%{"window_id" => wid, "label" => spec["window_label"]}]
    session = session |> Map.put(:windows, windows) |> Map.put(:blocks, session.blocks ++ [block])

    {%{"window_id" => wid, "block_ids" => [bid], "revision" => n},
     %{state | creates: n + 1, sessions: Map.put(state.sessions, sid, session)}}
  end

  defp run("session.view", _, sid, state) do
    case state.sessions[sid] do
      nil -> {{"session not found", 3}, state}
      session -> {%{"session_id" => sid, "windows" => windows(session)}, state}
    end
  end

  defp run("session.close_window", %{"window_id" => wid}, sid, state) do
    case state.sessions[sid] do
      nil ->
        {{"session not found", 3}, state}

      session ->
        session =
          session
          |> Map.put(:windows, Enum.reject(windows(session), &(&1["window_id"] == wid)))
          |> Map.put(:blocks, Enum.reject(session.blocks, &(&1["window_id"] == wid)))

        {%{}, put_in(state, [:sessions, sid], session)}
    end
  end

  defp run("session.move_window", %{"window_id" => wid}, sid, state) do
    session = state.sessions[sid]
    windows = windows(session)
    window = Enum.find(windows, &(&1["window_id"] == wid))
    windows = Enum.reject(windows, &(&1["window_id"] == wid)) ++ [window]
    {%{}, put_in(state, [:sessions, sid], Map.put(session, :windows, windows))}
  end

  defp run("session.list_blocks", _, sid, state) do
    case state.sessions[sid] do
      nil -> {{"session not found", 3}, state}
      session -> {%{"blocks" => session.blocks}, state}
    end
  end

  defp run("session.destroy", _, sid, state),
    do:
      {%{},
       %{state | sessions: Map.delete(state.sessions, sid), order: List.delete(state.order, sid)}}

  defp run("session.move", %{"session_id" => sid}, sid, state),
    do: {%{}, %{state | order: List.delete(state.order, sid) ++ [sid]}}

  defp run("session.set_window_label", args, sid, state) do
    session = state.sessions[sid]

    windows =
      Enum.map(windows(session), fn w ->
        if w["window_id"] == args["window_id"], do: Map.put(w, "label", args["label"]), else: w
      end)

    session = session |> Map.put(:windows, windows) |> Map.put(:window_label, args["label"])
    {%{"revision" => 4}, put_in(state, [:sessions, sid], session)}
  end

  defp run("session.set_label", args, sid, state),
    do: {%{"revision" => 2}, put_in(state, [:sessions, sid, :label], args["label"])}

  defp run("session.set_block_label", args, sid, state) do
    blocks =
      Enum.map(state.sessions[sid].blocks, fn b ->
        if b["block_id"] == args["block_id"], do: Map.put(b, "label", args["label"]), else: b
      end)

    {%{"revision" => 3}, put_in(state, [:sessions, sid, :blocks], blocks)}
  end

  defp run("target.resolve", args, _, state) do
    [bid] = args["queries"]

    target =
      Enum.find_value(state.sessions, fn {sid, session} ->
        if Enum.any?(session.blocks, &(&1["block_id"] == bid)),
          do: %{"session_id" => sid, "block_id" => bid}
      end)

    result =
      if target,
        do: %{"status" => "resolved", "target" => target},
        else: %{"status" => "not_found"}

    {%{"results" => [result]}, state}
  end

  defp run("com.superlogical.terminal.process", _, _, state),
    do: {fixture("process_running"), state}

  defp run("block.event", _, _, state), do: {fixture("block_event_paste"), state}
  defp run("send-key", _, _, state), do: {{"", 0}, state}

  defp run("server.apple.privacy_status", _, _, state),
    do: {%{"full_disk_access" => "granted"}, state}

  defp windows(session) do
    live = MapSet.new(session.blocks, & &1["window_id"])

    case Map.get(session, :windows) do
      nil ->
        session.blocks
        |> Enum.filter(&is_binary(&1["window_id"]))
        |> Enum.uniq_by(& &1["window_id"])
        |> Enum.map(
          &%{"window_id" => &1["window_id"], "label" => Map.get(session, :window_label, "")}
        )

      windows ->
        Enum.filter(windows, &MapSet.member?(live, &1["window_id"]))
    end
  end
end
