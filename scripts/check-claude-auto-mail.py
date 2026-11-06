#!/usr/bin/env -S uv run
"""Exercise real Claude hooks/native messaging against a loopback inference stub.

Run with --shuttle pointing at the checkout's built CLI. No daemon, operator
mailbox, model account or public inference endpoint is used. Probe artifacts
(including API requests, hook inputs/outputs and receipts) remain in --output.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import shlex
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def wait_for(check, description, child=None, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        if child is not None and child.poll() is not None:
            raise AssertionError(f"Claude exited {child.returncode} waiting for {description}")
        time.sleep(0.025)
    raise AssertionError(f"timed out waiting for {description}")


def json_lines(path):
    if not path.exists():
        return []
    lines = []
    for line in path.read_text().splitlines():
        try:
            lines.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return lines


def hook():
    root = Path(os.environ["AUTO_MAIL_PROBE"])
    raw = sys.stdin.read()
    payload = json.loads(raw)
    event = payload["hook_event_name"]
    with (root / "hooks.jsonl").open("a") as out:
        out.write(json.dumps({"input": payload, "socket": os.environ.get("CLAUDE_CODE_MESSAGING_SOCKET")}) + "\n")
    # Keep the last-tool interval open without changing the hook's semantics.
    if event == "Stop" and (root / "hold-stop").exists():
        (root / "at-stop").touch()
        wait_for(lambda: (root / "release").exists(), "Stop release")
    sys.stdout.write(raw)


def text_of(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(text_of(v) for v in value)
    if isinstance(value, dict):
        return text_of(value.get("text", value.get("content", "")))
    return ""


class Inference(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if not self.path.startswith("/v1/messages"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")
            return
        root = self.server.root
        with (root / "requests.jsonl").open("a") as out:
            out.write(json.dumps(request) + "\n")
        mode = self.server.mode
        messages = request["messages"]
        user_text = "\n".join(text_of(m["content"]) for m in messages if m["role"] == "user")
        all_text = json.dumps(messages)
        tool_results = any(c.get("type") == "tool_result" for m in messages for c in (m["content"] if isinstance(m["content"], list) else []))
        child = "CHILD_RUN" in user_text and "MODE_SUBAGENT" not in user_text
        if mode == "api-failure" and not (root / "allow-api").exists():
            (root / "api-failed").touch()
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "staged API failure"}}).encode())
            return
        blocks = []
        if mode in ("mid-tool", "subagent") and not tool_results and "AUTO_TOKEN_" not in all_text:
            if mode == "subagent" and not child:
                blocks = [{"type": "tool_use", "id": "tool_parent", "name": next(t["name"] for t in request["tools"] if t["name"] in ("Task", "Agent")), "input": {"description": "Private mailbox probe", "subagent_type": "general-purpose", "prompt": "CHILD_RUN: run the Bash command supplied by the inference fixture, then finish."}}]
            else:
                command = f"touch '{root}/in-tool'; while ! test -e '{root}/release'; do sleep 0.05; done; printf TOOL_DONE"
                blocks = [{"type": "tool_use", "id": "tool_child" if child else "tool_main", "name": "Bash", "input": {"command": command, "description": "Wait at private probe barrier", "timeout": 120000}}]
        elif mode == "last-tool" and not tool_results and "AUTO_TOKEN_" not in all_text:
            blocks = [{"type": "tool_use", "id": "tool_final", "name": "Bash", "input": {"command": "printf LAST_TOOL_DONE", "description": "Finish the last tool"}}]
        else:
            token = self.server.token if self.server.token in all_text else "NO_MAIL"
            blocks = [{"type": "text", "text": f"{'CHILD' if child else 'PARENT'}_REPLY {token}"}]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        def event(kind, data):
            self.wfile.write((f"event: {kind}\ndata: " + json.dumps(data) + "\n\n").encode())
            self.wfile.flush()
        event("message_start", {"type": "message_start", "message": {"id": "msg_probe", "type": "message", "role": "assistant", "model": request["model"], "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 1}}})
        for index, block in enumerate(blocks):
            start = dict(block)
            if block["type"] == "tool_use":
                start["input"] = {}
                delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
            else:
                start["text"] = ""
                delta = {"type": "text_delta", "text": block["text"]}
            event("content_block_start", {"type": "content_block_start", "index": index, "content_block": start})
            event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": delta})
            event("content_block_stop", {"type": "content_block_stop", "index": index})
        event("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use" if blocks[0]["type"] == "tool_use" else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}})
        event("message_stop", {"type": "message_stop"})


def probe(args, mode):
    root = args.output / mode
    root.mkdir(parents=True)
    (root / "data").mkdir(mode=0o700)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Inference)
    server.root, server.mode, server.token = root, mode, "AUTO_TOKEN_" + mode.replace("-", "_")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure", "SubagentStop", "SessionEnd"]
    command = f"{shlex.quote(sys.executable)} {shlex.quote(str(Path(__file__).resolve()))} --hook | {shlex.quote(str(args.shuttle))} hook event | tee -a {shlex.quote(str(root / 'hook-output.jsonl'))}"
    settings = {"crossSessionInbound": "accept", "hooks": {e: [{"hooks": [{"type": "command", "command": command, "timeout": 120}]}] for e in events}}
    (root / "settings.json").write_text(json.dumps(settings))
    env = dict(os.environ, AUTO_MAIL_PROBE=str(root), AUTO_MAIL_SHUTTLE=str(args.shuttle), SHUTTLE_DATA_DIR=str(root / "data"), SHUTTLE_HOST="probe", SHUTTLE_DAEMON_URL="http://127.0.0.1:1", SHUTTLE_BOARD="off", SHUTTLE_EVENTS_FILE=str(root / "events.jsonl"), SHUTTLE_PROGRAM_STATUS="off", ANTHROPIC_BASE_URL=f"http://127.0.0.1:{server.server_port}", ANTHROPIC_AUTH_TOKEN="private-loopback-probe", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", CLAUDE_CODE_MAX_RETRIES="0", TMPDIR="/tmp")
    for key in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "SHUTTLE_SESSION_ID", "SHUTTLE_FIBER", "SHUTTLE_WORKER", "ANTHROPIC_API_KEY"):
        env.pop(key, None)
    if mode == "last-tool":
        (root / "hold-stop").touch()
    output = (root / "output.jsonl").open("w")
    stderr = (root / "stderr.log").open("w")
    child = subprocess.Popen([args.claude, "-p", "--debug-file", str(root / "claude-debug.log"), "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--settings", str(root / "settings.json"), "--strict-mcp-config", "--tools", "Bash,Agent", "--permission-mode", "bypassPermissions", "--model", "sonnet", "--effort", "low", "--system-prompt", "You are a private transport test worker."], cwd=root, env=env, stdin=subprocess.PIPE, stdout=output, stderr=stderr, text=True)
    def send(text, id, *flags):
        hooks = json_lines(root / "hooks.jsonl")
        session = hooks[0]["input"]["session_id"]
        result = subprocess.run([str(args.shuttle), "message", "--local", f"shuttle://probe/claude/{session}", text, "--message-id", id, "--json", *flags], env=env, capture_output=True, text=True, timeout=120)
        (root / f"receipt-{id}.json").write_text(result.stdout)
        if result.returncode:
            raise AssertionError(f"message failed: {result.stdout} {result.stderr}")
        return json.loads(result.stdout)
    try:
        prompt = "MODE_SUBAGENT" if mode == "subagent" else "MODE_" + mode.upper()
        child.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": prompt}}) + "\n")
        child.stdin.flush()
        wait_for(lambda: len(json_lines(root / "hooks.jsonl")) >= 2, "main-thread registration", child, timeout=90)
        if mode in ("mid-tool", "subagent"):
            wait_for(lambda: (root / "in-tool").exists(), "tool barrier", child)
        elif mode == "last-tool":
            wait_for(lambda: (root / "at-stop").exists(), "last-tool Stop barrier", child)
        else:
            wait_for(lambda: any(r.get("type") == "result" for r in json_lines(root / "output.jsonl")), "stopped or failed turn", child)
        if mode == "api-failure":
            assert (root / "api-failed").exists()
            (root / "allow-api").touch()
        started = time.monotonic()
        receipt = send(server.token, "automatic")
        if mode in ("mid-tool", "subagent", "last-tool", "api-failure"):
            assert receipt["transport"] == "claude-hook", receipt
        if mode in ("mid-tool", "subagent"):
            (root / "release").touch()
        if mode in ("mid-tool", "subagent"):
            wait_for(lambda: any(server.token in json.dumps(h) for h in json_lines(root / "hook-output.jsonl")), "main-thread hook offer", child)
        if receipt["transport"] == "claude-hook":
            # The CLI is the same recovery path the daemon ticks. Restarting
            # this process does not lose the queue time or transport claim.
            recovery_deadline = time.monotonic() + 90
            while time.monotonic() < recovery_deadline:
                run = subprocess.run([str(args.shuttle), "claude-mail-recover"], env=env, capture_output=True, text=True, timeout=120)
                if run.returncode:
                    raise AssertionError(run.stderr)
                hooks = json_lines(root / "hook-output.jsonl")
                offered = any(server.token in json.dumps(h) for h in hooks)
                native = list((root / "data" / "mailboxes" / "claude").glob("*/fallback/*.json"))
                offered_native = [p for p in (root / "data" / "mailboxes" / "claude").glob("*/offered/*.json") if json.loads(p.read_text()).get("native_fallback")]
                if offered or native or offered_native:
                    break
                time.sleep(0.05)
        (root / "release").touch()
        wait_for(lambda: any(r.get("type") == "assistant" and server.token in text_of(r.get("message", {}).get("content")) and not r.get("parent_tool_use_id") for r in json_lines(root / "output.jsonl")), "main-thread reply to automatic mail", child)
        hooks = json_lines(root / "hook-output.jsonl")
        offers = [h for h in hooks if server.token in json.dumps(h)]
        if mode in ("mid-tool", "subagent"):
            assert len(offers) == 1, offers
            assert offers[0]["hookSpecificOutput"]["hookEventName"] in ("PreToolUse", "PostToolUse"), offers
        else:
            assert not offers, offers
        if mode == "subagent":
            child_requests = [r for r in json_lines(root / "requests.jsonl") if "CHILD_RUN" in "\n".join(text_of(m["content"]) for m in r["messages"] if m["role"] == "user") and "MODE_SUBAGENT" not in json.dumps(r["messages"])]
            assert child_requests and all(server.token not in json.dumps(r) for r in child_requests), "child received parent mail"
        final = send(server.token, "automatic")
        if mode in ("mid-tool", "subagent"):
            assert final["status"] == "context_added", final
        else:
            assert final["transport"] == "claude-native", final
        replies = [r for r in json_lines(root / "output.jsonl") if r.get("type") == "assistant" and server.token in text_of(r.get("message", {}).get("content")) and not r.get("parent_tool_use_id")]
        assert len(replies) == 1, replies
        print(json.dumps({"mode": mode, "initial": receipt, "final": final, "hook_offers": len(offers), "main_replies": len(replies), "elapsed_s": round(time.monotonic() - started, 3)}), flush=True)
    finally:
        (root / "release").touch()
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        output.close()
        stderr.close()
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hook", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--shuttle", type=Path)
    parser.add_argument("--claude", default="claude")
    parser.add_argument("--output", type=Path, default=Path(tempfile.mkdtemp(prefix="claude-auto-mail-", dir="/tmp")))
    parser.add_argument("--mode", choices=["mid-tool", "last-tool", "subagent", "stopped", "api-failure"], action="append")
    args = parser.parse_args()
    if args.hook:
        hook()
        return
    if not args.shuttle:
        parser.error("--shuttle is required")
    args.shuttle = args.shuttle.resolve()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    print(f"artifacts: {args.output}", flush=True)
    for mode in args.mode or ["mid-tool", "last-tool", "subagent", "stopped", "api-failure"]:
        probe(args, mode)


if __name__ == "__main__":
    main()
