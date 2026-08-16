defmodule Shuttle.Test.EnvHelpers do
  @moduledoc """
  Save/restore for the two environments a test can perturb: the `:shuttle`
  application env and the OS env.

  The shape is always the same — read the prior value in `setup`, hand it back
  in `on_exit`, and let `nil` mean "there was nothing there, delete it" rather
  than writing a literal nil back:

      previous = Application.get_env(:shuttle, :felt_runner)
      on_exit(fn -> restore_app_env(:felt_runner, previous) end)
  """

  @doc "Restore a `:shuttle` application env key; `nil` deletes it."
  def restore_app_env(key, nil), do: Application.delete_env(:shuttle, key)
  def restore_app_env(key, value), do: Application.put_env(:shuttle, key, value)

  @doc "Restore an OS env var; `nil` deletes it."
  def restore_env(key, nil), do: System.delete_env(key)
  def restore_env(key, value), do: System.put_env(key, value)
end
