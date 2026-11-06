defmodule Shuttle.Voice.Config do
  @moduledoc "The live voice switch and the shared transcript monitor's thresholds."

  @defaults %{
    "enabled" => false,
    "cold_minutes" => 5,
    "words" => 200,
    "quiet_seconds" => 15
  }

  def path do
    case Shuttle.Env.get("SHUTTLE_VOICE_FILE") do
      value when is_binary(value) and value != "" -> Shuttle.Env.expand(value)
      _ -> Shuttle.Env.expand("~/.config/shuttle/voice.json")
    end
  end

  def read do
    case Shuttle.FS.read(path()) do
      {:error, :enoent} ->
        {:ok, @defaults}

      {:ok, bytes} ->
        with {:ok, config} <- Jason.decode(bytes),
             :ok <- validate(config),
             do: {:ok, normalize(config)}

      {:error, reason} ->
        {:error, Shuttle.FS.format_error(reason)}
    end
  end

  def thresholds(_kind) do
    case read() do
      {:ok, config} -> Map.take(config, ~w(words quiet_seconds))
      {:error, _} -> Map.take(@defaults, ~w(words quiet_seconds))
    end
  end

  defp normalize(config) do
    legacy = Map.merge(Map.get(config, "meeting", %{}), Map.get(config, "voice", %{}))
    @defaults |> Map.merge(Map.take(legacy, ~w(words quiet_seconds))) |> Map.merge(config)
  end

  def validate(config) when is_map(config) do
    cond do
      not is_boolean(Map.get(config, "enabled", false)) ->
        {:error, "enabled must be a boolean"}

      not (is_number(Map.get(config, "cold_minutes", 5)) and
               Map.get(config, "cold_minutes", 5) > 0) ->
        {:error, "cold_minutes must be positive"}

      not Enum.all?(~w(voice meeting), &is_map(Map.get(config, &1, %{}))) ->
        {:error, "voice and meeting settings must be objects"}

      true ->
        case normalize(config) do
          %{"words" => words, "quiet_seconds" => quiet}
          when is_integer(words) and words > 0 and is_number(quiet) and quiet > 0 ->
            :ok

          _ ->
            {:error, "words must be a positive integer and quiet_seconds must be positive"}
        end
    end
  end

  def validate(_), do: {:error, "voice settings must be a JSON object"}

  def enable(enabled) do
    # Off is a safety control even when the operator file cannot be decoded.
    config =
      case read() do
        {:ok, config} -> {:ok, config}
        {:error, _} when enabled == false -> {:ok, @defaults}
        error -> error
      end

    with {:ok, config} <- config,
         {:ok, _} <-
           Shuttle.ConfigFiles.write(:voice, Jason.encode!(Map.put(config, "enabled", enabled))) do
      :ok
    end
  end
end
