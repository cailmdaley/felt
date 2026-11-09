defmodule Shuttle.LifecycleStore do
  @moduledoc """
  Conditional standing-run conclusion and migration writes through Shuttle's
  locked document writer. The document owns lifecycle and run disposition.
  """

  alias Shuttle.FiberDoc

  @doc """
  Conclude the observed standing run whose worker exited without handing off:
  `shuttle conclude-run` stamps `handed_off_at` under the document lock and
  leaves the constitution armed for its next tick. A newer run, a handoff, or a
  human pause or retirement is left as it stands.
  """
  def conclude(fiber_id, opts \\ []) do
    with {:ok, path, _, fm, _} <- FiberDoc.read(fiber_id) do
      observed = Keyword.get(opts, :observed, fm)
      runtime = get_in(observed, ["shuttle", "runtime"]) || %{}

      request = %{
        "path" => path,
        "uid" => Map.get(observed, "uid") || Map.get(observed, "id"),
        "host" => Keyword.get(opts, :own_host_id, Shuttle.Env.get("SHUTTLE_HOST")),
        "dispatched_at" => Map.get(runtime, "dispatched_at", ""),
        "run_id" => Map.get(runtime, "run_id", ""),
        "recovery" => Keyword.get(opts, :recovery, false)
      }

      case Shuttle.CLI.run(["conclude-run", "--request-json", Jason.encode!(request)],
             runner: Keyword.get(opts, :runner, Shuttle.Runner.Default)
           ) do
        {:ok, output} ->
          case Jason.decode(output) do
            {:ok, %{"changed" => true}} -> {:ok, "concluded #{fiber_id}'s run\n"}
            {:ok, %{"changed" => false}} -> {:ok, "left #{fiber_id} as it stands\n"}
            _ -> {:error, "invalid conclude-run reply: #{output}"}
          end

        {:command_error, _, output} ->
          {:error, output}

        error ->
          {:error, inspect(error)}
      end
    end
  end

  @doc "Prepare reversible migration writes without touching either document."
  def prepare_migration(from_path, to_path, uuid, opts) do
    with {:ok, _, _, from_fm, _} <- FiberDoc.read_path(from_path),
         {:ok, _, _, to_fm, _} <- FiberDoc.read_path(to_path),
         {:ok, _} <- shuttle_block(from_fm),
         {:ok, _} <- shuttle_block(to_fm) do
      now = DateTime.to_iso8601(DateTime.utc_now())
      status = if opts[:rest] == true or opts[:disabled] == true, do: "open", else: "active"
      source_runtime = without_identity(get_in(from_fm, ["shuttle", "runtime"]) || %{})
      dest_runtime = without_identity(get_in(to_fm, ["shuttle", "runtime"]) || %{}) || %{}

      source = %{
        "status" => status,
        "closed-at" => nil,
        "tempered" => nil,
        "horizon" => if(opts[:rest], do: "stashed"),
        "shuttle.runtime" => source_runtime
      }

      dest = %{
        "status" => "active",
        "closed-at" => nil,
        "tempered" => nil,
        "horizon" => nil,
        "ask" => nil,
        "shuttle.runtime" =>
          Map.merge(dest_runtime, %{"session_uuid" => uuid, "dispatched_at" => now})
      }

      {:ok, [document_patch(from_path, from_fm, source), document_patch(to_path, to_fm, dest)]}
    end
  end

  defp without_identity(runtime) do
    case Map.drop(runtime, ~w(session_uuid dispatched_at handed_off_at run_id)) do
      empty when map_size(empty) == 0 -> nil
      rest -> rest
    end
  end

  defp document_patch(path, fm, after_fields) do
    before =
      Map.new(after_fields, fn
        {"shuttle.runtime", _} -> {"shuttle.runtime", get_in(fm, ["shuttle", "runtime"])}
        {"ask", _} -> {"ask", get_in(fm, ["shuttle", "ask"])}
        {key, _} -> {key, fm[key]}
      end)

    %{
      "path" => path,
      "uid" => fm["id"],
      "host" => get_in(fm, ["shuttle", "host"]),
      "before" => before,
      "after" => after_fields
    }
  end

  @doc "Patch assignment/lifecycle fields under both felt locks, preserving current bodies."
  def apply_migration(documents, mode, runner) when mode in ["check", "forward", "reverse"] do
    request = Jason.encode!(%{"mode" => mode, "documents" => documents})

    case Shuttle.CLI.run(["migrate-documents", "--request-json", request], runner: runner) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, %{"ok" => true}} -> :ok
          _ -> {:error, :migration_documents_invalid_reply}
        end

      {:command_error, _, output} ->
        case output
             |> String.split("\n")
             |> Enum.find("", &String.starts_with?(&1, "{"))
             |> Jason.decode() do
          {:ok, %{"reason" => reason}} -> {:error, {:migration_documents, reason}}
          _ -> {:error, {:migration_documents, output}}
        end

      error ->
        {:error, {:migration_documents, error}}
    end
  end

  defp shuttle_block(%{"shuttle" => shuttle}) when is_map(shuttle), do: {:ok, shuttle}
  defp shuttle_block(_), do: {:error, "fiber has no shuttle: block"}
end
