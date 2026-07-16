defmodule ShuttleWeb.LifecycleController do
  @moduledoc """
  Agent-API endpoint for shuttle lifecycle mutations — the kanban's promote /
  requeue / pause / resume writes, posted directly to Shuttle.

  Owner-routed via `Shuttle.OriginRouter`: a local-owned card's mutation runs
  here; a remote-owned card's request is forwarded to the owning daemon's
  identical `/lifecycle` (origin stripped) and relayed verbatim. The local
  branch delegates to felt's `shuttle` CLI verbs, so the validated offline
  frontmatter writer remains the single implementation of
  install/pause/resume/repeat/pin/accept/set-model/set-outcome/uninstall.

  `pin` reshapes a fiber to the schedule-less `kind: pinned` umbrella role
  (the board's drag-onto-the-Pinned-strip gesture). Like a kind reshape, the
  caller composes `uninstall` then `pin` client-side — `felt shuttle pin`
  refuses to clobber an existing block — echoing the fiber's model / host /
  project_dir so the block survives the round trip.
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_text: 2, send_cli_result: 3]

  alias Shuttle.{FeltStores, LifecycleService, OriginRouter, RemoteFiberRegistry}

  @allowed ~w(install pause resume repeat pin accept set-model set-agent set-outcome uninstall)

  def create(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        result = OriginRouter.forward(remote, "/api/v1/lifecycle", conn.body_params)
        # The forwarded verb (pin/uninstall/…) mutated the remote's loom mirror;
        # invalidate the RemoteFiberRegistry feed cache so the board reflects it
        # before the next remote poll — otherwise pinning a remote-owned role
        # snaps back until a manual refresh.
        RemoteFiberRegistry.refresh_after_forward(remote.name, result)
        relay_text(conn, result)

      :local ->
        create_local(conn, params)
    end
  end

  defp create_local(conn, params) do
    with {:ok, action} <- action(params),
         {:ok, output} <- execute(action, params) do
      # Every lifecycle verb here mutates the fiber doc (status/outcome/model/
      # shuttle block). Re-read it into the document cache so the kanban's
      # post-action refetch reflects the change now, not after the next poll.
      refresh_card(params)

      conn
      |> put_resp_content_type("text/plain")
      |> send_resp(200, output)
    else
      other -> send_cli_result(conn, "shuttle", other)
    end
  end

  defp action(%{"action" => action}) when action in @allowed, do: {:ok, action}
  defp action(%{"action" => action}), do: {:error, "unknown lifecycle action #{inspect(action)}"}
  defp action(_), do: {:error, "missing lifecycle action"}

  defp execute("accept", %{"fiber" => fiber} = params) do
    with {:ok, fiber_id} <- fiber_address(fiber) do
      LifecycleService.accept(fiber_id, keep_outcome: truthy?(params["keep_outcome"]))
    end
  end

  defp execute("resume", %{"fiber" => fiber}) do
    with {:ok, fiber_id} <- fiber_address(fiber) do
      case LifecycleService.resume(fiber_id) do
        {:ok, output} -> {:ok, output}
        {:error, _reason} -> args_for("resume", %{"fiber" => fiber_id}) |> then(&run_elem/1)
      end
    end
  end

  defp execute(action, %{"fiber" => fiber} = params)
       when action in ~w(pause set-model set-agent set-outcome uninstall) do
    # `resolve_fiber`'s `:host` key is the felt-STORE path (`--felt-store`),
    # not an identity override — see `Shuttle.Felt.Shuttle`'s C4 note. Renamed
    # only at this local boundary; `FeltStores.resolve_fiber/1`'s wire shape
    # is out of scope for this pass.
    with {:ok, %{host: felt_store, fiber_id: fiber_id}} <- resolve_fiber(fiber) do
      action
      |> args_for(%{params | "fiber" => fiber_id})
      |> run_elem(felt_store)
    end
  end

  defp execute(action, params) do
    action
    |> args_for(params)
    |> run_elem()
  end

  defp refresh_card(%{"fiber" => fiber}) do
    case resolve_fiber(fiber) do
      {:ok, %{fiber_id: fiber_id}} -> Shuttle.Poller.refresh_document(fiber_id)
      _ -> :ok
    end
  end

  defp refresh_card(_), do: :ok

  defp fiber_address(identifier) do
    with {:ok, %{fiber_id: fiber_id}} <- resolve_fiber(identifier), do: {:ok, fiber_id}
  end

  defp resolve_fiber(identifier) do
    case FeltStores.resolve_fiber(identifier) do
      {:ok, resolved} -> {:ok, resolved}
      {:error, :not_found} -> {:error, "fiber not found: #{identifier}"}
      {:error, :timeout} -> {:error, :timeout, "felt timed out resolving #{identifier}"}
    end
  end

  defp run_elem(args, felt_store \\ nil)
  defp run_elem({:ok, args}, felt_store), do: run(args, felt_store)
  defp run_elem(error, _felt_store), do: error

  defp args_for("install", %{"fiber" => fiber} = params) do
    args = ["install", fiber]
    args = add_string_flag(args, "--model", params["model"])
    args = add_string_flag(args, "--project-dir", params["project_dir"])
    args = add_bool_flag(args, "--disabled", params["disabled"])
    {:ok, args}
  end

  defp args_for("pause", %{"fiber" => fiber} = params) do
    {:ok, ["pause", fiber] |> add_bool_flag("--no-kill", params["no_kill"])}
  end

  defp args_for("resume", %{"fiber" => fiber}), do: {:ok, ["resume", fiber]}

  defp args_for("pin", %{"fiber" => fiber} = params) do
    {:ok,
     ["pin", fiber]
     |> add_string_flag("--model", params["model"])
     |> add_string_flag("--project-dir", params["project_dir"])
     |> add_string_flag("--host", params["host"])}
  end

  defp args_for("repeat", %{"fiber" => fiber, "schedule" => schedule} = params) do
    {:ok,
     ["repeat", fiber, "--schedule", schedule, "--tz", Map.get(params, "tz", "UTC")]
     |> add_string_flag("--model", params["model"])
     |> add_string_flag("--project-dir", params["project_dir"])}
  end

  defp args_for("accept", %{"fiber" => fiber} = params) do
    {:ok, ["accept", fiber] |> add_bool_flag("--keep-outcome", params["keep_outcome"])}
  end

  defp args_for("set-model", %{"fiber" => fiber, "agent" => agent}),
    do: {:ok, ["set-model", fiber, agent]}

  # set-agent composes base agent × effort × chrome in one validated write.
  # The agent positional is optional (omit to mutate only axes); effort and
  # chrome are forwarded only when present so an unspecified axis is left
  # untouched. Chrome renders `--chrome` / `--chrome=false` (cobra reads
  # Changed), and effort passes through verbatim — including `--effort ""` to
  # clear back to the harness default.
  defp args_for("set-agent", %{"fiber" => fiber} = params) do
    args = ["set-agent", fiber]
    args = if(is_binary(params["agent"]) and params["agent"] != "", do: args ++ [params["agent"]], else: args)

    args =
      case params do
        %{"effort" => effort} when is_binary(effort) -> args ++ ["--effort", effort]
        _ -> args
      end

    args =
      case params do
        %{"chrome" => chrome} when is_boolean(chrome) -> args ++ ["--chrome=#{chrome}"]
        _ -> args
      end

    {:ok, args}
  end

  # The outcome string round-trips as a single argv element, so multi-line
  # values (block scalars) survive without stdin piping. set-outcome refuses a
  # block-less fiber and runs `ensure_owned_here`, so a misrouted edit surfaces
  # a loud owner-mismatch rather than writing the wrong host's document.
  defp args_for("set-outcome", %{"fiber" => fiber, "outcome" => outcome})
       when is_binary(outcome),
       do: {:ok, ["set-outcome", fiber, "--outcome", outcome]}

  defp args_for("uninstall", %{"fiber" => fiber}), do: {:ok, ["uninstall", fiber]}
  defp args_for(action, _), do: {:error, "missing required fields for #{action}"}

  defp add_string_flag(args, _flag, nil), do: args
  defp add_string_flag(args, _flag, ""), do: args
  defp add_string_flag(args, flag, value), do: args ++ [flag, value]

  defp add_bool_flag(args, flag, true), do: args ++ [flag]
  defp add_bool_flag(args, _flag, _), do: args

  defp truthy?(true), do: true
  defp truthy?(_), do: false

  # Routed through the one audited write helper (`Shuttle.Felt.Shuttle`),
  # which itself sits on `Shuttle.Felt.run` (Runner-bounded — F3/C3) rather
  # than a private `System.cmd/3` copy. Every `args_for/2` clause returns
  # `[verb, fiber_id | rest]`, so destructuring here is enough to feed the
  # helper's `(verb, fiber_id, args, opts)` shape without touching a single
  # `args_for` clause.
  defp run([verb, fiber_id | rest], felt_store) do
    env = [{"SHUTTLE_LIFECYCLE_OFFLINE", "1"}]

    case Shuttle.Felt.Shuttle.run(verb, fiber_id, rest, felt_store: felt_store, env: env) do
      {:ok, output} -> {:ok, output}
      {:command_error, status, output} -> {:command_error, status, clean_command_output(output)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp clean_command_output(output) when is_binary(output) do
    output
    |> String.split("\n", trim: true)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.map(fn
      "Error: " <> message -> message
      line -> line
    end)
    |> Enum.dedup()
    |> Enum.join("\n")
  end
end
