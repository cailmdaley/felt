defmodule Shuttle.RetainedTerminal do
  @moduledoc "Rex auxiliary launches with durable ownership, exit receipts and output."
  alias Shuttle.{FS, Rex}

  def rex?(opts \\ []),
    do: Keyword.get(opts, :terminal, Shuttle.Terminal.primary()) == Shuttle.Terminal.Rex

  def start(name, cwd, argv, metadata, runner, opts \\ []) do
    locked(name, opts, fn ->
      with :ok <- Shuttle.Terminal.Rex.ensure_ready(runner),
           {:ok, %{"instance_id" => instance}} <- Rex.whoami(runner),
           :gone <- read(name, opts) do
        token = Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)
        dir = Path.join(root(opts), name <> "-" <> token)
        script = Path.join(dir, "run.sh")

        record = %{
          "instance" => instance,
          "label" => name <> "@" <> token,
          "dir" => dir,
          "created" => System.system_time(:second),
          "metadata" => metadata
        }

        with :ok <- FS.mkdir_p(dir),
             :ok <- FS.chmod(dir, 0o700),
             :ok <- FS.write(script, wrapper(dir, cwd, argv, opts)),
             :ok <- FS.chmod(script, 0o700),
             :ok <- write(name, record, opts),
             spec <- spec(record["label"], cwd, script),
             {:ok, reply} <- Rex.create(runner, spec),
             {:ok, record} <- bind(record, reply),
             :ok <- write(name, record, opts) do
          :ok
        end
      else
        {:ok, _} -> {:error, :already_started}
        error -> error
      end
    end)
  end

  def observe(name, runner, opts \\ []) do
    locked(name, opts, fn ->
      with {:ok, %{"instance" => previous} = record} <- read(name, opts) do
        case Rex.whoami(runner) do
          {:ok, %{"instance_id" => instance}} when instance != previous ->
            {:ok, observation(record, true)}

          {:ok, _} ->
            inspect_launch(name, record, runner, opts)

          {:error, :server_absent} ->
            {:ok, observation(record, true)}

          error ->
            error
        end
      end
    end)
  end

  def stop(name, runner, opts \\ []) do
    locked(name, opts, fn ->
      case read(name, opts) do
        :gone ->
          :ok

        {:ok, record} ->
          with :ok <- stop_owned(record, runner),
               :ok <- remove(name, opts) do
            FS.rm_rf(record["dir"])
            :ok
          end

        error ->
          error
      end
    end)
  end

  defp stop_owned(%{"instance" => previous} = record, runner) do
    case Rex.whoami(runner) do
      {:ok, %{"instance_id" => instance}} when instance != previous ->
        :ok

      {:ok, _} ->
        case resolve(record, runner) do
          {:ok, bound} -> destroy(bound, runner)
          {:error, reason} when reason in [:not_found, :server_absent] -> :ok
          error -> error
        end

      {:error, :server_absent} ->
        :ok

      error ->
        error
    end
  end

  defp inspect_launch(name, record, runner, opts) do
    with {:ok, record} <- resolve(record, runner),
         :ok <- write(name, record, opts),
         {:ok, blocks} <- Rex.blocks(runner, record["session_id"]) do
      exists = Enum.any?(blocks, &(&1["block_id"] == record["block_id"]))

      if exists do
        case Rex.process(runner, record["session_id"], record["block_id"]) do
          {:ok, %{"child" => child}} -> {:ok, observation(record, is_nil(child))}
          {:ok, %{"last_exit" => exit}} when is_map(exit) -> {:ok, observation(record, true)}
          {:ok, _} -> {:error, :invalid_process_reply}
          error -> error
        end
      else
        {:ok, observation(record, true)}
      end
    else
      {:error, reason} when reason in [:not_found, :server_absent] ->
        {:ok, observation(record, true)}

      error ->
        error
    end
  end

  defp resolve(%{"session_id" => _} = record, _runner), do: {:ok, record}

  defp resolve(record, runner) do
    with {:ok, sessions} <- Rex.sessions(runner) do
      case Enum.find(sessions, &(&1["label"] == record["label"])) do
        nil ->
          {:error, :not_found}

        %{"session_id" => sid} ->
          with {:ok, [%{"block_id" => bid}]} <- Rex.blocks(runner, sid),
               do: {:ok, Map.merge(record, %{"session_id" => sid, "block_id" => bid})}
      end
    end
  end

  defp bind(record, %{"session_id" => sid, "initial_windows" => [%{"block_ids" => [bid]}]}),
    do: {:ok, Map.merge(record, %{"session_id" => sid, "block_id" => bid})}

  defp bind(_, _), do: {:error, :invalid_create_reply}

  defp destroy(record, runner) do
    case Rex.destroy(runner, record["session_id"]) do
      {:ok, _} -> :ok
      {:error, reason} when reason in [:not_found, :server_absent] -> :ok
      error -> error
    end
  end

  defp observation(record, lost?) do
    receipt =
      case FS.read(Path.join(record["dir"], "receipt")) do
        {:ok, text} -> String.split(String.trim(text), "|")
        _ -> []
      end

    {pid, created, ended, status} =
      case receipt do
        ["running", pid, at] ->
          {integer(pid), integer(at), nil, nil}

        ["ended", pid, at, ended, status] ->
          {integer(pid), integer(at), integer(ended), integer(status)}

        _ ->
          {nil, record["created"], nil, nil}
      end

    %{
      dead: lost? or ended != nil,
      pid: if(lost?, do: nil, else: pid),
      created: created,
      ended: ended,
      exit_status: status,
      metadata: record["metadata"],
      screen: tail(Path.join(record["dir"], "output"))
    }
  end

  defp tail(path) do
    case FS.open(path, [:read, :binary]) do
      {:ok, fd} ->
        try do
          with {:ok, size} <- FS.position(fd, :eof),
               {:ok, bytes} <- FS.pread(fd, max(0, size - 16_384), 16_384) do
            bytes |> String.split("\n") |> Enum.reject(&(String.trim(&1) == "")) |> Enum.take(-20)
          else
            _ -> []
          end
        after
          FS.close(fd)
        end

      _ ->
        []
    end
  end

  defp wrapper(dir, cwd, argv, opts) do
    env =
      Enum.map_join(Keyword.get(opts, :env, %{}), "\n", fn {key, value} ->
        "export #{key}=#{quote_sh(value)}"
      end)

    """
    #!/bin/bash
    umask 077
    #{Shuttle.Dispatcher.erts_scrub_block()}
    #{Shuttle.Rex.environment_script()}
    #{env}
    cd #{quote_sh(cwd)} || exit $?
    receipt=#{quote_sh(Path.join(dir, "receipt"))}
    exec > >(tee -a #{quote_sh(Path.join(dir, "output"))}) 2>&1
    started=$(date +%s)
    if bash -c 'receipt=$1; started=$2; shift 2
      printf "running|%s|%s\\n" "$$" "$started" > "$receipt.tmp"
      mv "$receipt.tmp" "$receipt"
      exec "$@"' retained "$receipt" "$started" #{Enum.map_join(argv, " ", &quote_sh/1)}; then
      status=0
    else
      status=$?
    fi
    IFS='|' read -r phase child started < "$receipt"
    printf 'ended|%s|%s|%s|%s\n' "$child" "$started" "$(date +%s)" "$status" > "$receipt.tmp"
    mv "$receipt.tmp" "$receipt"
    exit "$status"
    """
  end

  defp spec(label, cwd, script) do
    spec = Shuttle.Terminal.Rex.create_spec(label, cwd, script)

    put_in(spec, ["initial_windows", Access.at(0), "layout", "block", "options", "exit"], %{
      "on_completion" => false,
      "quick_exit_threshold_ms" => 0
    })
  end

  defp root(opts), do: Keyword.get(opts, :state_dir, Path.join(Shuttle.data_dir(), "retained"))
  defp path(name, opts), do: Path.join(root(opts), name <> ".json")

  defp read(name, opts) do
    case FS.read(path(name, opts)) do
      {:ok, json} -> Jason.decode(json)
      {:error, :enoent} -> :gone
      error -> error
    end
  end

  defp write(name, record, opts), do: FS.write_atomic(path(name, opts), Jason.encode!(record))

  defp remove(name, opts) do
    case FS.rm(path(name, opts)) do
      :ok -> :ok
      {:error, :enoent} -> :ok
      error -> error
    end
  end

  defp locked(name, opts, fun),
    do: Shuttle.Terminal.with_lock({__MODULE__, path(name, opts)}, fun)

  defp integer(value), do: String.to_integer(value)
  defp quote_sh(value), do: "'" <> String.replace(value, "'", "'\\''") <> "'"
end
