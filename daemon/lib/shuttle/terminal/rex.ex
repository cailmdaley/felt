defmodule Shuttle.Terminal.Rex do
  @moduledoc "Unavailable Rex backend; worker operations fail closed."
  @behaviour Shuttle.Terminal.Backend

  def id, do: "rex"
  def available?, do: false
  def ensure_ready(_), do: {:error, {:rex_server_unavailable, "Rex backend is unavailable"}}
  def launch(_, _, _, _, _), do: {:error, "Rex backend is unavailable"}
  def probe(_, _), do: :unknown
  def list(_), do: {:error, :unknown}
  def close(_, _), do: {:error, "Rex backend is unavailable"}
  def paste(_, _, _), do: {:error, "Rex backend is unavailable"}
  def rename(_, _, _), do: {:error, :rename_failed}
  def owns_pane?(_, _, _), do: false
  def identity(_, _), do: {:error, :backend_unobservable}
  def reveal(_, _), do: {:error, "Rex backend is unavailable"}
  def script(_), do: %{wait_for_viewer: "", submit_key: "", env: ""}
  def unreachable_hint(_, _), do: "Rex backend is unavailable"
end
