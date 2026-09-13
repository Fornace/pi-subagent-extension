#!/usr/bin/env python3
"""Archive a fresh owner-produced agent_list result without prompting any child."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile


def archive(session_id, directory):
    root = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi/agent"))
    candidates = list((root / "sessions").glob(f"*/*_{session_id}.jsonl"))
    if len(candidates) != 1:
        raise ValueError(f"Expected exactly one session file, found {len(candidates)}")
    path = candidates[0]
    latest = None
    header = None
    with path.open() as source:
        for line_number, line in enumerate(source, 1):
            entry = json.loads(line)
            if entry.get("type") == "session":
                header = entry
            message = entry.get("message", {})
            if message.get("role") == "toolResult" and message.get("toolName") == "agent_list":
                latest = (entry, line_number)
    if not header or header.get("id") != session_id:
        raise ValueError("Session header identity mismatch")
    if not latest:
        raise ValueError("Call agent_list once in the owning session, then run this command")
    entry, line_number = latest
    timestamp = datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00"))
    age = (datetime.now(timezone.utc) - timestamp).total_seconds()
    if age < 0 or age > 120:
        raise ValueError(f"Agent inventory is {age:.0f}s old; call agent_list again in the owner")
    message = entry["message"]
    if message.get("isError"):
        raise ValueError("The owner agent_list failed")
    agents = message.get("details", {}).get("agents")
    if not isinstance(agents, list):
        raise ValueError("Expected structured agent_list details.agents")
    handles = [a["handle"] for a in agents]
    if len(set(handles)) != len(handles):
        raise ValueError("Duplicate worker handles in owner inventory")
    for agent in agents:
        if not isinstance(agent.get("usage"), dict) or not isinstance(agent.get("status"), str):
            raise ValueError("Incomplete worker status")
    record = {
        "version": 1,
        "owner_session": session_id,
        "source_file": str(path),
        "source_entry": entry["id"],
        "source_line": line_number,
        "observed_at": entry["timestamp"],
        "archived_at": datetime.now(timezone.utc).isoformat(),
        "agents": agents,
        "limits": "Owner snapshots only. Legacy --no-session child transcripts are not recovered.",
    }
    body = (json.dumps(record, indent=2, ensure_ascii=False) + "\n").encode()
    digest = hashlib.sha256(body).hexdigest()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / f"{session_id}-{entry['id']}.json"
    if target.exists():
        raise ValueError(f"Archive already exists: {target}")
    fd, temporary = tempfile.mkstemp(prefix=".worker-archive-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target)
    finally:
        os.unlink(temporary)
    if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise ValueError("Archive digest verification failed")
    print(json.dumps({"path": str(target), "sha256": digest, "workers": len(agents),
                      "states": {s: sum(a["status"] == s for a in agents)
                                 for s in sorted({a["status"] for a in agents})},
                      "processes_stopped": 0}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    archive(args.session, args.output)
