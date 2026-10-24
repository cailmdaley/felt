defmodule ShuttleWeb.MigrateController do
  use Phoenix.Controller, formats: [:json]
  import Plug.Conn

  def create(conn, %{"from" => from, "to" => to} = params)
      when is_binary(from) and from != "" and is_binary(to) and to != "" do
    opts = [
      session_id: params["session_id"] || params["session_uuid"],
      tmux_pane: params["tmux_pane"],
      rest: params["rest"] == true,
      disabled: params["disabled"] == true
    ]

    if Enum.all?([opts[:session_id], opts[:tmux_pane]], &(is_nil(&1) or is_binary(&1))) do
      case Shuttle.Poller.migrate(from, to, opts) do
        {:ok, reply} ->
          json(conn, reply)

        {:error, reason} ->
          code =
            case reason do
              atom when is_atom(atom) -> Atom.to_string(atom)
              {atom, _} when is_atom(atom) -> Atom.to_string(atom)
              _ -> "migration_failed"
            end

          status =
            if code in ["rollback_failed", "reconciliation_required", "recovery_failed"],
              do: 503,
              else: 422

          conn
          |> put_status(status)
          |> json(%{ok: false, reason: code, error: corrective_message(code, from, to, reason)})
      end
    else
      conn |> put_status(400) |> json(%{ok: false, reason: "invalid_request"})
    end
  end

  def create(conn, _),
    do:
      conn
      |> put_status(400)
      |> json(%{ok: false, reason: "invalid_request", error: "from and to are required"})

  defp corrective_message("not_installed", from, to, _),
    do:
      "Both #{from} and #{to} must be installed; run shuttle install <fiber> --disabled for the missing block, then retry."

  defp corrective_message("already_running", _, to, _),
    do:
      "#{to} already has a live worker; choose an idle destination or migrate that worker elsewhere first."

  defp corrective_message("other_host", _, _, _),
    do:
      "Both fibers must belong to this daemon's host; run migrate on their owning host or choose a destination on that host."

  defp corrective_message("same_fiber", _, _, _),
    do: "Source and destination are the same fiber; choose a different destination."

  defp corrective_message("not_running", from, _, _),
    do:
      "#{from} has no registered live worker; pass --from with the fiber the session currently serves, or wait for its worker to be registered."

  defp corrective_message("identity_mismatch", _, _, _),
    do:
      "The native session or tmux pane does not match the source worker; run migrate from that worker or supply its current --from fiber."

  defp corrective_message("surface_unsupported", _, _, _),
    do:
      "The worker cannot be moved with its current identity; wait for its native session ID to be captured, or use a supported tmux or owned Codex conversation. No worker was moved."

  defp corrective_message("invalid_options", _, _, _),
    do: "Choose only one of --rest and --disabled."

  defp corrective_message("not_found", _, _, _),
    do:
      "A fiber could not be resolved; use its exact ID or UID from a store configured on this daemon."

  defp corrective_message("uid_missing", _, _, _),
    do: "The destination needs an intrinsic UID; run felt backfill-ids in its store, then retry."

  defp corrective_message("rename_failed", _, _, _),
    do:
      "The tmux session could not be renamed; restore access to its tmux server and check the destination session name before retrying."

  defp corrective_message(code, _, _, reason)
       when code in ["rollback_failed", "reconciliation_required", "recovery_failed"],
       do:
         "Migration needs reconciliation; keep the journal and surviving worker, restore the recorded backend or resolve conflicting fiber fields, then restart the daemon to retry recovery. Detail: #{inspect(reason)}"

  defp corrective_message(code, _, _, reason) when code in ["write_failed", "document_conflict"],
    do:
      "The fiber documents could not be updated; inspect concurrent edits and file permissions, then retry after reconciling them. Detail: #{inspect(reason)}"

  defp corrective_message(_, _, _, reason),
    do:
      "Migration was refused; inspect the current worker assignment and daemon diagnostics before retrying. Detail: #{inspect(reason)}"
end
