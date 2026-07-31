# Pin the agent registry for the whole suite. Dispatch tests exercise
# harness-specific paths (pi, codex) whose agents live in the example
# registry, not the generic builtins; without this pin the suite would
# depend on whatever ~/.config/felt/agents.json the developer has.
System.put_env("FELT_AGENTS_FILE", Path.expand("../share/agents.example.json", __DIR__))

ExUnit.start(exclude: [:integration])
