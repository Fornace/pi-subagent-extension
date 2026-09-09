# Install

```bash
# extension
mkdir -p ~/.pi/agent/extensions/subagent
rsync -a --exclude node_modules ./ ~/.pi/agent/extensions/subagent/

# global agent definitions
mkdir -p ~/.pi/agent/agents ~/.pi/agent/skills
cp agents/*.md ~/.pi/agent/agents/
cp -R skills/fornace-model-routing ~/.pi/agent/skills/

# deps
cd ~/.pi/agent/extensions/subagent
npm install
```

Restart/reload Pi after install. Load `/skill:fornace-model-routing` when
choosing or escalating a delegated model route.
