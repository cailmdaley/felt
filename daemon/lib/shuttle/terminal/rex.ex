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

  @impl true
  def ensure_ready(runner) do
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

  defp unavailable,
    do:
      {:error,
       {:rex_server_unavailable,
        "Open Rex and grant Rex Server access; the Rex server is unavailable"}}

  @impl true
  def launch(runner, name, cwd, script_path, opts) do
    with :ok <- valid_label(name),
         {:ok, %{"host_id" => server}} <- Rex.whoami(runner),
         {:ok, reply} <- Rex.create(runner, create_spec(name, cwd, script_path, opts)),
         {:ok, binding} <- created_binding(reply) do
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
    case resolve(runner, name) do
      {:ok, _} -> :present
      {:error, reason} when reason in [:not_found, :server_absent] -> :absent
      {:error, _} -> :unknown
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
        for %{"label" => label} <- sessions, Shuttle.Dispatcher.shuttle_session?(label), do: label

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
  def rename(runner, from, to) do
    Shuttle.Terminal.with_lock({__MODULE__, :rename}, fn ->
      with :ok <- valid_label(to),
           {:ok, source} <- resolve(runner, from),
           :ok <- target_free(runner, to, source),
           :ok <- Rex.set_labels(runner, source["session_id"], source["block_id"], to),
           :ok <- store(runner, to, source),
           :ok <- remove_old_binding(from, to, source) do
        :ok
      else
        _ -> {:error, :rename_failed}
      end
    end)
  end

  defp target_free(runner, name, source) do
    with {:ok, doc} <- Bindings.read(),
         {:ok, sessions} <- Rex.sessions(runner) do
      sid = source["session_id"]
      live = Enum.map(sessions, & &1["session_id"])
      b = doc["bindings"][name]

      conflict =
        (b != nil and b["session_id"] != sid and b["session_id"] in live) or
          Enum.any?(sessions, &(&1["label"] == name and &1["session_id"] != sid))

      if conflict, do: {:error, :rename_failed}, else: :ok
    end
  end

  defp remove_old_binding(name, name, _), do: :ok
  defp remove_old_binding(from, _, b), do: Bindings.delete(from, b)

  @impl true
  def owns_pane?(runner, name, "block:" <> _ = pane) do
    with {:ok, b} <- resolve(runner, name),
         {:ok, blocks} <- Rex.blocks(runner, b["session_id"]) do
      Enum.any?(blocks, &(&1["block_id"] == pane))
    else
      _ -> false
    end
  end

  def owns_pane?(_, _, _), do: false

  @impl true
  def identity(runner, name) do
    with {:ok, b} <- resolve(runner, name),
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

  @impl true
  def reveal(name, _host), do: reveal_with(Env.app(:rex_runner, Shuttle.Runner.Default), name)

  # The runner-taking form keeps app activation testable without selecting a
  # session in the operator's app.
  defp reveal_with(runner, name) do
    with {:ok, b} <- resolve(runner, name),
         {:ok, client} <- ensure_app_client(runner),
         {:ok, _} <- Rex.select(runner, client, b["session_id"]),
         {_, 0} <- runner.cmd("open", ["-b", "com.superlogical.rex"], stderr_to_stdout: true) do
      :ok
    else
      error -> {:error, "Cannot open Rex terminal: #{inspect(error)}"}
    end
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

  @env ~w(SHUTTLE_HOST SHUTTLE_DATA_DIR SHUTTLE_LISTEN SHUTTLE_CODEX_SOCKET SHUTTLE_AGENTS_FILE SHUTTLE_HOST_CONFIG_FILE SHUTTLE_REX_BIN SHUTTLE_REX_SERVER PATH SSH_AUTH_SOCK)
  @impl true
  def script(_name) do
    exports =
      Enum.map_join(@env, "", fn key ->
        case Env.get(key) do
          nil -> "unset #{key}\n"
          value -> "export #{key}=#{quote_sh(value)}\n"
        end
      end)

    executable = quote_sh(Rex.bin() || "rex")
    flags = Enum.map_join(Rex.flags(), " ", &quote_sh/1)

    %{
      wait_for_viewer: "",
      submit_key:
        "( sleep 2; #{executable} #{flags} send-key -s \"$REX_SESSION\" -b \"$REX_BLOCK\" enter ) &\n",
      env:
        "unset TMUX TMUX_PANE\n" <>
          exports <>
          "( umask 077; mkdir -p #{quote_sh(Path.dirname(pid_path("block")))}; printf '%s\\n' \"$$\" \"$REX_SESSION\" \"$REX_BLOCK\" > #{quote_sh(Path.dirname(pid_path("block")))}/\"$REX_BLOCK.pid\" )\n"
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

  defp resolve(runner, "session:" <> _ = sid), do: recover_block(runner, nil, sid)

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
              :ok -> {:error, :not_found}
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
    case Enum.filter(sessions, &(&1["label"] == name)) do
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
      matching = Enum.filter(blocks, &(&1["label"] == name and name != nil))

      case if(matching == [], do: blocks, else: matching) do
        [%{"block_id" => bid}] ->
          b = binding(sid, bid)

          if name do
            with :ok <- store(runner, name, b), do: {:ok, b}
          else
            {:ok, b}
          end

        [] ->
          {:error, :not_found}

        _ ->
          {:error, :unknown}
      end
    end
  end

  defp live_block(runner, name, b) do
    with {:ok, blocks} <- Rex.blocks(runner, b["session_id"]) do
      if Enum.any?(blocks, &(&1["block_id"] == b["block_id"])) do
        {:ok, b}
      else
        # Only an empty session is disposable; other human panes survive.
        cleanup =
          if blocks == [] and name != nil,
            do: Rex.destroy(runner, b["session_id"]),
            else: {:ok, %{}}

        with {:ok, _} <- cleanup,
             :ok <- if(name, do: Bindings.delete(name, b), else: :ok) do
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
