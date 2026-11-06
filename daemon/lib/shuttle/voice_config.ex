defmodule Shuttle.Voice.Config do
  @moduledoc "The live voice switch and the shared transcript monitor's thresholds."

  @defaults %{
    "enabled" => false,
    "voice" => %{"words" => 200, "quiet_seconds" => 15},
    "meeting" => %{"words" => 150, "quiet_seconds" => 10}
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
             do: {:ok, Map.merge(@defaults, config)}

      {:error, reason} ->
        {:error, Shuttle.FS.format_error(reason)}
    end
  end

  def thresholds(kind) do
    case read() do
      {:ok, config} -> config[kind]
      {:error, _} -> @defaults[kind]
    end
  end

  def validate(config) when is_map(config) do
    cond do
      not is_boolean(Map.get(config, "enabled", false)) ->
        {:error, "enabled must be a boolean"}

      true ->
        Enum.reduce_while(~w(voice meeting), :ok, fn kind, :ok ->
          case Map.get(config, kind, @defaults[kind]) do
            %{"words" => words, "quiet_seconds" => quiet}
            when is_integer(words) and words > 0 and is_number(quiet) and quiet > 0 ->
              {:cont, :ok}

            _ ->
              {:halt, {:error, "#{kind} requires positive words (integer) and quiet_seconds"}}
          end
        end)
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
