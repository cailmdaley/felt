defmodule Shuttle.Test.FakeRex do
  @moduledoc "Fixture-backed Rex runner with observable calls and injected transport replies."
  use Agent

  def fixture(name),
    do: File.read!(Path.expand("../fixtures/rex/#{name}.json", __DIR__)) |> Jason.decode!()

  def start_link(_opts),
    do: Agent.start_link(fn -> %{sessions: %{}, calls: [], replies: %{}, clients: []} end)

  defp pid, do: Shuttle.Env.app(:fake_rex)
  def calls, do: Agent.get(pid(), &Enum.reverse(&1.calls))
  def reply(method, result), do: Agent.update(pid(), &put_in(&1, [:replies, method], result))

  def clear_reply(method),
    do: Agent.update(pid(), &update_in(&1.replies, fn map -> Map.delete(map, method) end))

  def sessions(sessions), do: Agent.update(pid(), &%{&1 | sessions: sessions})
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
         Enum.map(state.sessions, fn {sid, s} -> %{"session_id" => sid, "label" => s.label} end)
     }, state}
  end

  defp run("session.create", spec, _, state) do
    reply = fixture("session_create")
    sid = reply["session_id"]
    [window] = reply["initial_windows"]
    [bid] = window["block_ids"]
    block = hd(spec["initial_windows"])["layout"]["block"]
    session = %{label: spec["label"], blocks: [%{"block_id" => bid, "label" => block["label"]}]}
    {reply, put_in(state, [:sessions, sid], session)}
  end

  defp run("session.list_blocks", _, sid, state) do
    case state.sessions[sid] do
      nil -> {{"session not found", 3}, state}
      session -> {%{"blocks" => session.blocks}, state}
    end
  end

  defp run("session.destroy", _, sid, state),
    do: {%{}, %{state | sessions: Map.delete(state.sessions, sid)}}

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
end
