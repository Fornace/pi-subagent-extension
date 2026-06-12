# Install

```bash
# extension
mkdir -p ~/.pi/agent/extensions/subagent
rsync -a --exclude node_modules ./ ~/.pi/agent/extensions/subagent/

# global agent definitions
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/

# deps
cd ~/.pi/agent/extensions/subagent
npm install
```

Restart/reload Pi after install.
