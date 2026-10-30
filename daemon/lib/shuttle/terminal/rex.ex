defmodule Shuttle.Terminal.Rex do
  @moduledoc "Rex worker terminals addressed by daemon-owned immutable session/block bindings."
  @behaviour Shuttle.Terminal.Backend

  require Logger
  alias Shuttle.{Env, Rex, WorkerProcess}
  alias Shuttle.Terminal.RexBindings, as: Bindings

  @impl true
  def id, do: "rex"
  @impl true
  def available?, do: Rex.bin() != nil

  @doc "Check configuration separately from uncertain worker liveness."
  def require_config do
    cond do
      Rex.bin() == nil ->
        unavailable("Rex executable not found; check SHUTTLE_REX_BIN")

      true ->
        case Bindings.read() do
          {:ok, _} -> :ok
          {:error, reason} -> unavailable("Cannot read #{Bindings.path()}: #{inspect(reason)}")
        end
    end
  end

  @doc "Local configuration health; this check never starts or queries the Rex server."
  def health do
    case require_config() do
      :ok ->
        %{state: "configured", available: true, reason: nil}

      {:error, {:rex_server_unavailable, message}} ->
        %{state: "unavailable", available: false, reason: message}
    end
  end

  @impl true
  def ensure_ready(runner) do
    with :ok <- require_config(), do: ensure_server(runner)
  end

  defp ensure_server(runner) do
    case Rex.whoami(runner) do
      {:ok, _} ->
        :ok

      {:error, :server_absent} ->
        case runner.cmd("open", ["-g", "-b", "com.superlogical.rex"], stderr_to_stdout: true) do
          {_, 0} ->
            case await(fn -> Rex.whoami(runner) end, 10_000) do
              {:ok, _} -> :ok
              _ -> unavailable()
            end

          _ ->
            unavailable()
        end

      {:error, _} ->
        :ok
    end
  end

  defp unavailable(
         message \\ "Open Rex and grant Rex Server access; the Rex server is unavailable"
       ),
       do: {:error, {:rex_server_unavailable, message}}

  @impl true
  def launch(runner, name, cwd, script_path, opts) do
    with :ok <- valid_label(name),
         {:ok, %{"host_id" => server}} <- Rex.whoami(runner),
         {:ok, reply} <- Rex.create(runner, create_spec(name, cwd, script_path, opts)),
         {:ok, binding} <- created_binding(reply) do
      binding = if opts[:fiber], do: Map.put(binding, "fiber", opts[:fiber]), else: binding

      case Bindings.put(name, binding, server) do
        :ok ->
          :ok

        {:error, reason} ->
          Rex.destroy(runner, binding["session_id"])
          {:error, "Rex binding write failed: #{inspect(reason)}"}
      end
    else
      {:error, message} when is_binary(message) -> {:error, message}
      error -> {:error, "Rex launch failed: #{inspect(error)}"}
    end
  end

  def create_spec(name, cwd, script_path, opts \\ []) do
    %{
      "label" => name,
      "initial_windows" => [
        %{
          "window_label" => name,
          "layout" => %{
            "block" => %{
              "flavor" => "com.superlogical.terminal.shell",
              "label" => name,
              "options" => %{
                "shell" => "none",
                "command" => ["bash", "-l", script_path],
                "cwd" => cwd,
                "size" => Keyword.get(opts, :size, %{"columns" => 160, "rows" => 48}),
                "exit" => %{"on_completion" => true, "quick_exit_threshold_ms" => 0}
              }
            }
          }
        }
      ]
    }
  end

  defp created_binding(%{
         "session_id" => "session:" <> _ = sid,
         "initial_windows" => [%{"block_ids" => ["block:" <> _ = bid]}]
       }) do
    {:ok, binding(sid, bid)}
  end

  defp created_binding(_), do: {:error, :invalid_create_reply}

  @impl true
  def probe(runner, name) do
    owned? = match?({:ok, %{"bindings" => %{^name => _}}}, Bindings.read())

    case resolve(runner, name) do
      {:ok, _} ->
        :present

      {:error, reason} when reason in [:not_found, :server_absent] ->
        if owned?, do: Shuttle.Terminal.RexTree.refresh(runner)
        :absent

      {:error, _} ->
        :unknown
    end
  end

  @impl true
  def list(runner) do
    with {:ok, doc} <- Bindings.read(),
         {:ok, sessions} <- Rex.sessions(runner),
         :ok <- Bindings.prune(doc, Enum.map(sessions, & &1["session_id"])) do
      ids = MapSet.new(sessions, & &1["session_id"])
      bound = for {name, b} <- doc["bindings"], MapSet.member?(ids, b["session_id"]), do: name

      labels =
        Enum.flat_map(sessions, fn s ->
          case Rex.blocks(runner, s["session_id"]) do
            {:ok, blocks} ->
              for %{"label" => label} <- blocks,
                  Shuttle.Dispatcher.shuttle_session?(label),
                  do: label

            _ ->
              []
          end
        end)

      {:ok, Enum.uniq(bound ++ labels)}
    else
      {:error, :server_absent} -> {:ok, []}
      _ -> {:error, :unknown}
    end
  end

  @impl true
  def close(runner, name) do
    with {:ok, b} <- resolve(runner, name) do
      case Rex.destroy(runner, b["session_id"]) do
        {:ok, _} ->
          close_binding(name, b, :ok)

        {:error, reason} when reason in [:server_absent, :not_found] ->
          close_binding(name, b, :absent)

        error ->
          {:error, "Rex close failed: #{inspect(error)}"}
      end
    else
      {:error, reason} when reason in [:server_absent, :not_found] -> :absent
      error -> {:error, "Rex close failed: #{inspect(error)}"}
    end
  end

  defp close_binding(name, b, result) do
    case Bindings.delete(name, b) do
      :ok -> result
      error -> {:error, "Rex binding removal failed: #{inspect(error)}"}
    end
  end

  @impl true
  def paste(runner, name, text) do
    with {:ok, b} <- resolve(runner, name),
         {:ok, _} <- Rex.paste(runner, b["session_id"], b["block_id"], text),
         :ok <- Process.sleep(Env.app(:paste_submit_delay_ms, 400)),
         {:ok, _} <- Rex.send_key(runner, b["session_id"], b["block_id"], "enter") do
      :ok
    else
      error -> {:error, "Rex paste failed: #{inspect(error)}"}
    end
  end

  @impl true
  def rename(_runner, name, name), do: :ok
  def rename(runner, from, to), do: rename(runner, from, to, [])

  @doc "Rename a captured native session with an explicit worker block during journal recovery."
  def rename(runner, from, to, opts) do
    Shuttle.Terminal.with_lock(to, fn -> rename_locked(runner, from, to, opts) end)
  end

  defp rename_locked(runner, from, to, opts) do
    Shuttle.Terminal.with_lock({__MODULE__, :rename}, fn ->
      with :ok <- valid_label(to),
           {:ok, source} <- rename_source(runner, from, opts),
           {:ok, bound?} <- target_free(runner, to, source) do
        if bound? and opts == [] do
          :ok
        else
          write_rename(runner, from, to, source)
        end
      else
        _ -> {:error, :rename_failed}
      end
    end)
  end

  defp write_rename(runner, from, to, source) do
    with :ok <- Rex.set_labels(runner, source["session_id"], source["block_id"], to),
         :ok <- store(runner, to, source),
         :ok <- remove_old_binding(from, to, source) do
      :ok
    else
      _ -> {:error, :rename_failed}
    end
  end

  defp rename_source(runner, "session:" <> _ = sid, block_id: "block:" <> _ = bid),
    do: live_block(runner, nil, binding(sid, bid))

  defp rename_source(runner, from, []), do: resolve(runner, from)

  defp target_free(runner, name, source) do
    with {:ok, doc} <- Bindings.read(),
         {:ok, sessions} <- Rex.sessions(runner),
         {:ok, blocks} <- Rex.blocks(runner, source["session_id"]) do
      sid = source["session_id"]
      live = Enum.map(sessions, & &1["session_id"])
      b = doc["bindings"][name]

      # A session is one ownership unit: closing it hangs up every block.
      # Another live worker block must not lose its binding to this claim.
      owned_block? =
        Enum.any?(doc["bindings"], fn {_, owned} ->
          owned["session_id"] == sid and owned["block_id"] != source["block_id"] and
            Enum.any?(blocks, &(&1["block_id"] == owned["block_id"]))
        end)

      conflict =
        owned_block? or
          (b != nil and b["session_id"] in live and
             (b["session_id"] != sid or b["block_id"] != source["block_id"])) or
          Enum.any?(sessions, &(&1["label"] == name and &1["session_id"] != sid))

      if conflict,
        do: {:error, :rename_failed},
        else:
          {:ok,
           b != nil and
             Map.take(b, ~w(session_id block_id)) == Map.take(source, ~w(session_id block_id))}
    end
  end

  defp remove_old_binding(name, name, _), do: :ok
  defp remove_old_binding(from, _, b), do: Bindings.delete(from, b)

  @impl true
  def owns_pane?(runner, "session:" <> _ = sid, "block:" <> _ = pane) do
    case Rex.blocks(runner, sid) do
      {:ok, blocks} -> Enum.any?(blocks, &(&1["block_id"] == pane))
      _ -> false
    end
  end

  def owns_pane?(runner, name, "block:" <> _ = pane) do
    with {:ok, b} <- resolve(runner, name),
         {:ok, blocks} <- Rex.blocks(runner, b["session_id"]) do
      Enum.any?(blocks, &(&1["block_id"] == pane))
    else
      _ -> false
    end
  end

  def owns_pane?(_, _, _), do: false

  @doc "Resolve a live immutable address without requiring a worker PID receipt."
  def address(runner, name) do
    with {:ok, b} <- resolve(runner, name), do: {:ok, Map.take(b, ~w(session_id block_id))}
  end

  @impl true
  def identity(runner, name) do
    with {:ok, b} <- address(runner, name),
         {:ok, procs} <- WorkerProcess.scan(runner),
         {:ok, pid} <- worker_pid(name, b, procs) do
      {:ok, Map.take(b, ["session_id", "block_id"]) |> Map.put("child_pid", pid)}
    else
      _ -> {:error, :backend_unobservable}
    end
  end

  defp worker_pid(_name, b, procs) do
    with {:ok, receipt} <- File.read(pid_path(b["block_id"])),
         [pid, sid, bid] <- String.split(String.trim(receipt), "\n"),
         true <- sid == b["session_id"] and bid == b["block_id"],
         {pid, ""} <- Integer.parse(pid),
         true <- pid > 0 and Enum.any?(procs, &(&1.pid == pid)) do
      {:ok, pid}
    else
      _ -> {:error, :backend_unobservable}
    end
  end

  defp pid_path(block),
    do: Path.join([Shuttle.data_dir(), "terminals", "rex-pids", block <> ".pid"])

  def reveal(name, _host), do: reveal_with(Env.app(:rex_runner, Shuttle.Runner.Default), name)

  # The runner-taking form keeps app activation testable without selecting a
  # session in the operator's app.
  defp reveal_with(runner, name) do
    with {:ok, b} <- resolve(runner, name) do
      reveal_session(runner, b["session_id"])
    else
      error -> {:error, "Cannot open Rex terminal: #{inspect(error)}"}
    end
  end

  defp reveal_session(runner, sid) do
    with {:ok, client} <- ensure_app_client(runner),
         {:ok, _} <- Rex.select(runner, client, sid),
         {_, 0} <- runner.cmd("open", ["-b", "com.superlogical.rex"], stderr_to_stdout: true) do
      :ok
    else
      error -> {:error, "Cannot open Rex terminal: #{inspect(error)}"}
    end
  end

  @doc "Open or focus a display-only Rex viewer for a local or remote tmux worker."
  def reveal_tmux(name, host, destination, opts \\ []) do
    runner = Env.app(:rex_runner, Shuttle.Runner.Default)
    label = name <> "@" <> (host || "tmux")

    with :ok <- ensure_ready(runner),
         {:ok, argv} <- viewer_command(name, destination),
         {:ok, sid} <- viewer(runner, label, argv, opts) do
      reveal_session(runner, sid)
    else
      {:error, message} when is_binary(message) -> {:error, message}
      error -> {:error, "Cannot open Rex viewer: #{inspect(error)}"}
    end
  end

  defp viewer_command(name, nil) do
    case Env.find_executable("tmux") do
      nil -> {:error, "tmux executable not found for the local Rex viewer"}
      executable -> {:ok, [executable, "attach", "-t", "=" <> name]}
    end
  end

  defp viewer_command(name, destination) do
    # ssh joins its command arguments before the remote shell parses them.
    # Quote that shell's target as well as the viewer's local argv.
    remote = Enum.map_join(["tmux", "attach", "-t", "=" <> name], " ", &quote_sh/1)
    {:ok, ["ssh", "-tt", "--", destination, remote]}
  end

  @doc false
  def viewer(runner, label, argv, opts \\ []) do
    if Regex.match?(~r/[\p{Cc}]/u, label) do
      {:error, "Rex viewer label must contain no control characters"}
    else
      result = viewer_locked(runner, label, viewer_label(label), argv, opts)
      if match?({:ok, _}, result), do: Shuttle.Terminal.RexTree.refresh(runner)
      result
    end
  end

  # The tmux target is not a Rex label: adding a host suffix can exceed Rex's
  # label budget. Keep the destination visible and hash the full identity so
  # workers whose long names share a prefix still have distinct viewers.
  defp viewer_label(label) do
    if String.length(label) < 128 do
      label
    else
      {name, suffix} =
        case Regex.run(~r/^(.*)(@[^@]*)$/u, label) do
          [_, name, suffix] -> {name, suffix}
          nil -> {label, "@viewer"}
        end

      suffix =
        if String.length(suffix) > 64,
          do: String.slice(suffix, 0, 31) <> "~" <> label_hash(suffix),
          else: suffix

      String.slice(name, 0, 127 - String.length(suffix) - 33) <>
        "~" <> label_hash(label) <> suffix
    end
  end

  defp label_hash(label),
    do: :crypto.hash(:sha256, label) |> Base.encode16(case: :lower) |> String.slice(0, 32)

  defp viewer_locked(runner, key, label, argv, opts) do
    Shuttle.Terminal.with_lock({__MODULE__, :viewer, key}, fn ->
      with :ok <- valid_label(label),
           {:ok, doc} <- Bindings.read(),
           {:ok, sessions} <- Rex.sessions(runner),
           {:ok, %{"host_id" => server}} <- Rex.whoami(runner),
           :ok <- Bindings.prune(doc, Enum.map(sessions, & &1["session_id"])) do
        b = get_in(doc, ["viewers", key])

        # A display label is not proof of viewer ownership. Only a recorded
        # immutable binding can authorize reuse, destruction or tree moves.
        result =
          if b && Enum.any?(sessions, &(&1["session_id"] == b["session_id"])) do
            reuse_viewer(runner, label, argv, b)
          else
            create_viewer(runner, label, argv)
          end

        with {:ok, address} <- result do
          sid = address["session_id"]

          suffix =
            case Regex.run(~r/@([^@]*)$/u, key),
              do: (
                [_, host] -> " @" <> host
                nil -> ""
              )

          fiber = opts[:fiber] || (b && b["fiber"])
          binding = Map.merge(address, %{"fiber" => fiber, "suffix" => suffix})

          case Bindings.put_viewer(key, binding, server) do
            :ok ->
              {:ok, sid}

            error ->
              if b == nil or b["session_id"] != sid, do: Rex.destroy(runner, sid)
              error
          end
        else
          [] -> {:error, "Rex viewer exited before registration"}
          error -> error
        end
      end
    end)
  end

  defp reuse_viewer(runner, label, argv, b) do
    case Rex.blocks(runner, b["session_id"]) do
      {:ok, []} ->
        with {:ok, _} <- Rex.destroy(runner, b["session_id"]),
             do: create_viewer(runner, label, argv)

      {:ok, blocks} ->
        if Enum.any?(blocks, &(&1["block_id"] == b["block_id"])),
          do: {:ok, b},
          else: {:error, "Rex viewer block is gone; refusing to reuse surviving human panes"}

      error ->
        error
    end
  end

  defp create_viewer(runner, label, argv) do
    # Rex retains empty sessions. The viewer removes its own session after
    # attach/ssh returns; reopening also sweeps an empty session after a crash.
    cleanup =
      Enum.map_join([Rex.bin() || "rex"] ++ Rex.flags(), " ", &quote_sh/1) <>
        " api call -s \"$REX_SESSION\" session.destroy - <<< '{}' >/dev/null 2>&1"

    script =
      "unset TMUX TMUX_PANE\n" <>
        Rex.environment_script() <>
        "trap #{quote_sh(cleanup)} EXIT\n" <> Enum.map_join(argv, " ", &quote_sh/1) <> "\n"

    spec =
      create_spec(label, Env.home(), "", [])
      |> put_in(["initial_windows", Access.at(0), "layout", "block", "options", "command"], [
        "bash",
        "-c",
        script
      ])

    with {:ok, reply} <- Rex.create(runner, spec), do: created_binding(reply)
  end

  defp ensure_app_client(runner) do
    case Rex.app_client(runner) do
      {:error, :not_found} ->
        case runner.cmd("open", ["-b", "com.superlogical.rex"], stderr_to_stdout: true) do
          {_, 0} -> await(fn -> Rex.app_client(runner) end, 5_000)
          error -> {:error, {:unknown, inspect(error)}}
        end

      result ->
        result
    end
  end

  @impl true
  def script(_name) do
    executable = quote_sh(Rex.bin() || "rex")
    flags = Enum.map_join(Rex.flags(), " ", &quote_sh/1)

    %{
      wait_for_viewer: "",
      passthrough: "",
      submit_key:
        "( sleep 2; #{executable} #{flags} send-key -s \"$REX_SESSION\" -b \"$REX_BLOCK\" enter ) &\n",
      env:
        "unset TMUX TMUX_PANE\n" <>
          Rex.environment_script() <>
          "( umask 077 && mkdir -p #{quote_sh(Path.dirname(pid_path("block")))} && printf '%s\\n' \"$$\" \"$REX_SESSION\" \"$REX_BLOCK\" > #{quote_sh(Path.dirname(pid_path("block")))}/\"$REX_BLOCK.pid\" ) || true\n"
    }
  end

  @impl true
  def unreachable_hint(_, _), do: "the Rex server cannot see it; check `rex server status`"

  defp resolve(runner, "block:" <> _ = bid) do
    with {:ok,
          %{
            "results" => [
              %{"status" => "resolved", "target" => %{"session_id" => sid, "block_id" => ^bid}}
            ]
          }} <- Rex.call(runner, "target.resolve", %{"kinds" => ["block"], "queries" => [bid]}) do
      live_block(runner, nil, binding(sid, bid))
    else
      {:ok, %{"results" => [%{"status" => "not_found"}]}} -> {:error, :not_found}
      {:ok, _} -> {:error, :unknown}
      error -> error
    end
  end

  defp resolve(runner, "session:" <> _ = sid) do
    with {:ok, doc} <- Bindings.read() do
      case Enum.find(doc["bindings"], fn {_, b} -> b["session_id"] == sid end) do
        {name, b} -> live_block(runner, name, b)
        nil -> recover_block(runner, nil, sid)
      end
    end
  end

  defp resolve(runner, name) do
    with {:ok, doc} <- Bindings.read(),
         {:ok, sessions} <- Rex.sessions(runner) do
      case doc["bindings"][name] do
        nil ->
          recover_label(runner, name, sessions)

        b ->
          if Enum.any?(sessions, &(&1["session_id"] == b["session_id"])) do
            live_block(runner, name, b)
          else
            case Bindings.delete(name, b) do
              :ok -> recover_label(runner, name, sessions)
              error -> error
            end
          end
      end
    else
      {:error, :not_found} -> {:error, :unknown}
      error -> error
    end
  end

  defp recover_label(runner, name, sessions) do
    candidates = Enum.filter(sessions, &(&1["label"] == name))

    candidates =
      if candidates == [] do
        # A tree label isn't a recovery index. Recover through worker block
        # labels so losing the address file doesn't duplicate live workers.
        Enum.reduce_while(sessions, [], fn s, acc ->
          case Rex.blocks(runner, s["session_id"]) do
            {:ok, blocks} ->
              if Enum.any?(blocks, &(&1["label"] == name)),
                do: {:cont, [s | acc]},
                else: {:cont, acc}

            _ ->
              {:halt, :unknown}
          end
        end)
      else
        candidates
      end

    case candidates do
      :unknown ->
        {:error, :unknown}

      [] ->
        {:error, :not_found}

      [%{"session_id" => sid}] ->
        recover_block(runner, name, sid)

      duplicates ->
        Logger.warning(
          "Ambiguous Rex worker #{name}: #{Enum.map_join(duplicates, ", ", & &1["session_id"])}"
        )

        {:error, :unknown}
    end
  end

  defp recover_block(runner, name, sid) do
    with {:ok, blocks} <- Rex.blocks(runner, sid) do
      # Native claims may select a sole human pane. Name recovery requires
      # the worker block's label, never an unrelated remaining pane.
      matching = if name, do: Enum.filter(blocks, &(&1["label"] == name)), else: blocks

      case matching do
        [%{"block_id" => bid}] ->
          b = binding(sid, bid)

          if name do
            with :ok <- store(runner, name, b), do: {:ok, b}
          else
            {:ok, b}
          end

        [] when blocks == [] and name != nil ->
          destroy_empty(runner, sid)

        [] when blocks == [] ->
          {:error, :not_found}

        _ ->
          {:error, :unknown}
      end
    end
  end

  defp destroy_empty(runner, sid) do
    case Rex.destroy(runner, sid) do
      {:ok, _} -> {:error, :not_found}
      {:error, reason} when reason in [:not_found, :server_absent] -> {:error, :not_found}
      error -> error
    end
  end

  defp live_block(runner, name, b) do
    with {:ok, blocks} <- Rex.blocks(runner, b["session_id"]) do
      if Enum.any?(blocks, &(&1["block_id"] == b["block_id"])) do
        {:ok, b}
      else
        if blocks == [] and name != nil do
          with {:error, :not_found} <- destroy_empty(runner, b["session_id"]),
               :ok <- Bindings.delete(name, b) do
            {:error, :not_found}
          end
        else
          # Retain the missing block's address while human panes survive.
          # Later probes must not recover them as the departed worker.
          {:error, :not_found}
        end
      end
    end
  end

  defp store(runner, name, b) do
    with {:ok, %{"host_id" => server}} <- Rex.whoami(runner), do: Bindings.put(name, b, server)
  end

  defp binding(sid, bid),
    do: %{
      "session_id" => sid,
      "block_id" => bid,
      "created_at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

  defp quote_sh(text), do: "'" <> String.replace(text, "'", "'\\''") <> "'"

  defp valid_label(name) do
    if String.length(name) >= 128 or Regex.match?(~r/[\p{Cc}]/u, name),
      do:
        {:error,
         "Rex worker label must be shorter than 128 characters and contain no control characters"},
      else: :ok
  end

  defp await(fun, timeout), do: await_until(fun, System.monotonic_time(:millisecond) + timeout)

  defp await_until(fun, deadline) do
    case fun.() do
      {:ok, _} = result ->
        result

      error ->
        if System.monotonic_time(:millisecond) < deadline do
          Process.sleep(100)
          await_until(fun, deadline)
        else
          error
        end
    end
  end
end
