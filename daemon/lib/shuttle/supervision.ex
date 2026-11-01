defmodule Shuttle.Local do
  @moduledoc "Local observations and execution have their own restart budget."
  use Supervisor
  def start_link(children), do: Supervisor.start_link(__MODULE__, children, name: __MODULE__)
  @impl true
  def init(children), do: Supervisor.init(children, strategy: :one_for_one)
end

defmodule Shuttle.Fleet do
  @moduledoc "Fleet discovery and follower failures don't spend local children's restart budget."
  use Supervisor
  def start_link(children), do: Supervisor.start_link(__MODULE__, children, name: __MODULE__)
  @impl true
  def init(children), do: Supervisor.init(children, strategy: :one_for_one)
end
