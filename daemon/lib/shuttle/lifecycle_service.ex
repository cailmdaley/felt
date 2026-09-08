defmodule Shuttle.LifecycleService do
  @moduledoc """
  Daemon-side orchestration for the standing-role lifecycle verbs that re-arm an
  awaiting role by writing the felt document (`accept` / `resume`).

  Both the `/api/v1/lifecycle` endpoint (operator / `felt shuttle`) and the
  `/api/v1/transition` kanban path go through here, so an accept behaves
  identically regardless of which gesture triggered it. The work is to run the
  transition *through the Poller* (`Poller.lifecycle_transition/3`) so the
  felt-document write is atomic against poll cycles.

  Awaiting is `status: closed` + untempered in the document itself (there is no
  review axis); re-arm writes `status: active` and `next_due` is recomputed from
  the cron schedule on the next poll (there is no runtime store). The durable
  signal the standing-role dead-orphan detector reads is `shuttle.handed_off_at`,
  which `LifecycleStore` folds into each re-arm write — a human re-arm concludes
  the run, the same handoff a clean worker exit leaves — not a felt-history event.
  """

  alias Shuttle.{FeltStores, LifecycleStore, Poller}

  @spec accept(String.t(), keyword()) ::
          {:ok, String.t()} | {:error, String.t()} | {:error, :timeout, String.t()}
  def accept(fiber_id, opts \\ []) when is_binary(fiber_id) do
    with {:ok, address} <- fiber_address(fiber_id) do
      case transition(:accept, address, opts) do
        {:ok, output} -> {:ok, output}
        {:error, reason} -> {:error, to_message(reason)}
      end
    end
  end

  @spec resume(String.t()) ::
          {:ok, String.t()} | {:error, String.t()} | {:error, :timeout, String.t()}
  def resume(fiber_id) when is_binary(fiber_id) do
    with {:ok, address} <- fiber_address(fiber_id) do
      case transition(:resume, address, []) do
        {:ok, output} -> {:ok, output}
        {:error, reason} -> {:error, to_message(reason)}
      end
    end
  end

  # When the Poller is running (the live daemon) route through it so the felt
  # document write happens atomically against poll cycles — otherwise a
  # concurrent poll could read a half-written document. When it isn't (offline
  # lifecycle ops, unit tests) write the document directly.
  defp transition(verb, fiber_id, opts) do
    if is_pid(Process.whereis(Poller)) do
      Poller.lifecycle_transition(verb, fiber_id, opts)
    else
      apply(LifecycleStore, verb, [fiber_id, opts])
    end
  end

  defp fiber_address(identifier) do
    with {:ok, %{fiber_id: fiber_id}} <- FeltStores.resolve_fiber_or_error(identifier),
         do: {:ok, fiber_id}
  end

  defp to_message(reason) when is_binary(reason), do: reason
  defp to_message(reason), do: inspect(reason)
end
