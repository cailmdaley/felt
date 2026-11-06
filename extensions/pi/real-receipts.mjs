#!/usr/bin/env node
// Opt-in: make cli && TMPDIR=/tmp node extensions/pi/real-receipts.mjs
// Uses a private daemon, tmux server, HOME and synthetic local model provider.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "felt-real-pi-receipts-"));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
let holdNext = false;
let releaseTurn;
let turnStarted;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    const request = JSON.parse(raw);
    assert.ok(request.stream);
    fs.appendFileSync(
      path.join(root, "requests.jsonl"),
      JSON.stringify(request) + "\n",
    );
    if (holdNext) {
      holdNext = false;
      turnStarted?.();
      await new Promise((resolve) => (releaseTurn = resolve));
    }
    const text = "Receipt test response";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish_reason, usage) =>
      res.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "handoff-test", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`,
      );
    chunk({ role: "assistant", content: text }, null);
    chunk({}, "stop", {
      prompt_tokens: 1000,
      completion_tokens: 10,
      total_tokens: 1010,
    });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      "handoff-local": {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "synthetic-test-key",
        api: "openai-completions",
        models: [
          {
            id: "handoff-test",
            name: "Handoff test",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 1000,
          },
        ],
      },
    },
  }),
);
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  JSON.stringify({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  }),
);
// Deliberately controlled environment: this subprocess cannot inherit auth.
const env = {
  PATH: repo + path.delimiter + process.env.PATH,
  HOME: root,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  FELT_BIN: path.join(repo, "felt"),
  SHUTTLE_BIN: path.join(repo, "shuttle"),
  SHUTTLE_DATA_DIR: path.join(root, "data"),
  TMPDIR: "/tmp",
  SHUTTLE_HOST: "test-host",
  SHUTTLE_HANDOFF_TOKENS: "750000",
  SHUTTLE_HANDOFF_HARD_TOKENS: "750000",
};
const binary = process.env.FELT_TEST_PI_BIN || "pi";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await wait(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const tmux = path.join(root, "tmux.sock");
const sid = "receipt-smoke";
// This extension exercises Pi's real input-handled path, not a fake socket.
const dropExtension = path.join(root, "drop.ts");
fs.writeFileSync(
  dropExtension,
  `export default pi => { pi.on("input", event => event.text.includes("DROP_RECEIPT") ? {action:"handled"} : undefined); };`,
);
const args = [
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-tools",
  "--extension",
  repo,
  "--extension",
  dropExtension,
  "--model",
  "handoff-local/handoff-test",
  "--thinking",
  "off",
  "--session-id",
  sid,
  "--session-dir",
  path.join(root, "sessions"),
];
const command = [
  "env",
  "-i",
  ...Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`),
  quote(binary),
  ...args.map(quote),
].join(" ");
const daemonPortServer = http.createServer();
await new Promise((resolve) =>
  daemonPortServer.listen(0, "127.0.0.1", resolve),
);
const daemonPort = daemonPortServer.address().port;
await new Promise((resolve) => daemonPortServer.close(resolve));
const daemonScript = path.join(root, "daemon.exs");
fs.writeFileSync(
  daemonScript,
  `
System.put_env("SHUTTLE_PORT", "${daemonPort}")
System.put_env("SHUTTLE_HOST_CONFIG_FILE", "${root}/host.json")
Application.put_env(:shuttle, ShuttleWeb.Endpoint, http: [ip: {127,0,0,1}, port: ${daemonPort}], server: true, secret_key_base: String.duplicate("x",64))
{:ok, _} = Application.ensure_all_started(:shuttle)
{:ok, poller} = Shuttle.Poller.start_link(felt_stores: [], poll_interval_ms: 600_000, change_interval_ms: :infinity, boot_quarantine: true)
:sys.get_state(poller)
Process.sleep(2000)
# Bind the private test fiber to the real terminal conversation. No dispatcher
# launch, live store, watcher, or operator runtime state is involved.
:sys.replace_state(poller, fn state ->
  worker = %{session: "receipt", session_uuid: "${sid}", context_harness: "pi"}
  :ets.insert(state.published_table, {:worker_views, %{"receipt-test" => %{worker: worker, fiber: %{}}}})
  state
end)
File.write!("${root}/daemon-ready", "ready")
Process.sleep(:infinity)
`,
);
const daemonLog = fs.openSync(path.join(root, "daemon.log"), "w");
let daemon;
const base = `http://127.0.0.1:${daemonPort}`;
async function deliver(id, text) {
  const response = await fetch(`${base}/api/v1/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fiber_id: "receipt-test", text, message_id: id }),
  });
  const body = await response.json();
  fs.appendFileSync(
    path.join(root, "receipts.jsonl"),
    JSON.stringify({ id, http: response.status, body }) + "\n",
  );
  return body;
}
const entries = () => {
  try {
    return fs
      .readdirSync(path.join(root, "sessions"))
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) =>
        fs
          .readFileSync(path.join(root, "sessions", n), "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse),
      );
  } catch {
    return [];
  }
};
const text = (e) =>
  typeof e.message?.content === "string"
    ? e.message.content
    : (e.message?.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
try {
  execFileSync("tmux", [
    "-S",
    tmux,
    "new-session",
    "-d",
    "-s",
    "receipt",
    "-c",
    root,
    command,
  ]);
  const daemonEnv = {
    ...env,
    MIX_HOME: process.env.MIX_HOME || path.join(os.homedir(), ".mix"),
    HEX_HOME: process.env.HEX_HOME || path.join(os.homedir(), ".hex"),
    MIX_ENV: "test",
    SHUTTLE_STORES: "",
    SHUTTLE_PROJECTS: "",
    SHUTTLE_PORT: String(daemonPort),
  };
  daemon = spawn("mix", ["run", "--no-start", daemonScript], {
    cwd: path.join(repo, "daemon"),
    env: daemonEnv,
    stdio: ["ignore", daemonLog, daemonLog],
  });
  await until(
    () => fs.existsSync(path.join(root, "daemon-ready")),
    "private daemon startup",
  );
  await wait(2000);
  execFileSync("tmux", [
    "-S",
    tmux,
    "send-keys",
    "-t",
    "receipt",
    "Bootstrap private receipt test",
    "Enter",
  ]);
  // Registration is emitted by the real Pi extension through this checkout's CLI.
  await until(
    () => fs.existsSync(path.join(root, "data", "mailboxes", "pi")),
    "Pi registration",
  );
  await wait(1000);
  assert.equal((await deliver("idle", "Idle receipt probe")).delivered, true);
  const concurrent = await Promise.all([
    deliver("concurrent-a", "Same concurrent body"),
    deliver("concurrent-b", "Same concurrent body"),
  ]);
  assert.ok(
    concurrent.every(
      (body) =>
        body.delivered === true &&
        ["accepted", "queued"].includes(body.receipt.status),
    ),
  );
  for (const id of ["concurrent-a", "concurrent-b"]) {
    assert.equal(
      (await deliver(id, "Same concurrent body")).receipt.status,
      "accepted",
    );
  }
  const started = new Promise((resolve) => (turnStarted = resolve));
  holdNext = true;
  const active = deliver("active", "Start a held model turn");
  await started;
  const steering = await deliver("mid-turn", "Message during the held turn");
  assert.equal(steering.receipt.status, "queued");
  assert.equal(steering.delivered, true);
  assert.equal(
    entries().some(
      (e) =>
        e.message?.role === "user" &&
        text(e).includes("Message during the held turn"),
    ),
    false,
  );
  releaseTurn();
  assert.equal((await active).delivered, true);
  const admitted = await deliver("mid-turn", "Message during the held turn");
  assert.equal(admitted.receipt.status, "accepted");
  assert.equal(admitted.delivered, true);
  const dropped = await deliver(
    "dropped",
    "DROP_RECEIPT: Pi input handler consumes this without a user turn",
  );
  assert.equal(dropped.delivered, null);
  assert.equal(dropped.receipt.status, "unknown");
  for (const id of [
    "idle",
    "concurrent-a",
    "concurrent-b",
    "active",
    "mid-turn",
  ]) {
    assert.equal(
      entries().filter(
        (e) =>
          e.message?.role === "user" &&
          text(e).startsWith(`[Shuttle message ${id} `),
      ).length,
      1,
      `one admitted row for ${id}`,
    );
  }
  assert.equal(
    entries().some(
      (e) => e.message?.role === "user" && text(e).includes("DROP_RECEIPT"),
    ),
    false,
  );
  const cli = execFileSync(
    path.join(repo, "shuttle"),
    [
      "message",
      `shuttle://test-host/pi/${sid}`,
      "CLI receipt probe",
      "--local",
      "--json",
    ],
    { cwd: root, env },
  ).toString();
  fs.writeFileSync(path.join(root, "cli-receipt.json"), cli);
  assert.equal(JSON.parse(cli).status, "accepted");
  console.log(
    "PASS: real Pi TUI, private tmux + daemon; idle, concurrent, mid-turn, swallowed input and CLI receipts",
  );
  console.log(`Evidence: ${root}`);
} finally {
  releaseTurn?.();
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => daemon.once("exit", resolve)),
      wait(5000),
    ]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
  try {
    execFileSync("tmux", ["-S", tmux, "kill-server"]);
  } catch {}
  await new Promise((resolve) => server.close(resolve));
  fs.closeSync(daemonLog);
  if (process.env.FELT_TEST_KEEP !== "1")
    fs.rmSync(root, { recursive: true, force: true });
}
