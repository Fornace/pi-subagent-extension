#!/usr/bin/env python3
"""Install this checkout's routing policy into the current user's Pi directory."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

MODELS = {
    "quick": "mantice/fornace-flash", "scout": "mantice/fornace-fast",
    "planner": "mantice/fornace-reasoning", "researcher": "mantice/fornace-reasoning",
    "builder": "mantice/fornace-max", "critic": "mantice/fornace-max",
    "operator": "mantice/fornace-max", "astra-debugger": "mantice/fornace-astra",
}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi-dir", type=Path, default=Path.home() / ".pi/agent")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if subprocess.run(["git", "diff", "--quiet", "HEAD", "--", "."], cwd=root).returncode:
        raise ValueError("Install from a committed extension revision")
    pi_dir = args.pi_dir.resolve()
    destination = pi_dir / "extensions/subagent"
    destination.mkdir(parents=True, exist_ok=True)
    copied = {}
    package = json.loads((root / "package.json").read_text())
    listed = set(package["files"])
    files = [path for path in root.iterdir() if path.is_file() and path.name in listed]
    for folder in ("agents", "prompts", "skills"):
        if folder in listed:
            files += [path for path in (root / folder).rglob("*") if path.is_file()]
    expected_relative = {path.relative_to(root) for path in files}
    for path in sorted(destination.rglob("*"), reverse=True):
        if path.is_file() and "node_modules" not in path.parts and path.relative_to(destination) not in expected_relative:
            path.unlink()
    for source in files:
        target = destination / source.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied[str(target)] = digest(target)
    for source in (root / "agents").glob("*.md"):
        target = pi_dir / "agents" / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied[str(target)] = digest(target)
    source_skill = root / "skills/fornace-model-routing"
    skill_target = pi_dir / "skills/fornace-model-routing"
    if skill_target.exists():
        shutil.rmtree(skill_target)
    shutil.copytree(source_skill, skill_target)
    for target in skill_target.rglob("*"):
        if target.is_file():
            copied[str(target)] = digest(target)
    settings_path = pi_dir / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.is_file() else {}
    backup = settings_path.with_name("settings.json.pre-fornace-routing.bak")
    if settings_path.is_file():
        shutil.copy2(settings_path, backup)
    settings["agents"] = {name: {"model": model} for name, model in MODELS.items()}
    enabled = settings.setdefault("enabledModels", [])
    for model in MODELS.values():
        if model not in enabled:
            enabled.append(model)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    receipt = {"schema": "pi.fornace-routing-install.v1",
               "installed_at": datetime.now(timezone.utc).isoformat(),
               "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
               "source_path": str(root), "model_routes": MODELS,
               "settings_sha256": digest(settings_path), "settings_backup": str(backup),
               "files": copied}
    (pi_dir / "fornace-routing-install.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"installed": len(copied), "settings": str(settings_path), "receipt": str(pi_dir / "fornace-routing-install.json")}))


if __name__ == "__main__":
    main()
