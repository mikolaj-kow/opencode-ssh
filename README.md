# opencode-ssh

Run opencode on a remote server. Say "ssh myHost" and all commands run remotely.

- No need to install opencode remotely or expose API keys on the server.
- Reuses the same open ssh connection for performance, remembers last working folder, remote open docker connections etc.

Use to rapidly investigate incidents on remote servers, troubleshoot, analyze logs, data etc.

Targets **OpenCode V2** only, with no external runtime dependencies — the plugin uses only Node built-ins. (`Plugin.define` from `@opencode/plugin` is an identity helper, so the plain default export is equivalent.)

## How it works

- Opens SSH ControlMaster (`ssh -MNf ...`) for a persistent connection.
- Hooks `tool.execute.before` to wrap `shell` calls with SSH at runtime.
- Disables local file tools (`read`, `write`, `edit`, `patch`, `glob`, `grep`) in remote mode.
- Injects remote-mode instructions into the system prompt via the `context` session hook.

## V2 plugin shape

```ts
export default {
  id: "opencode-ssh",
  async setup(ctx) {
    await ctx.tool.transform((editor) => editor.add({ ... }))
    await ctx.tool.hook("execute.before", (event) => { ... })
    await ctx.session.hook("context", (event) => { ... })
    return cleanup
  },
}
```

## Setup

Copy the source into the plugin directory (a real file, not a symlink — OpenCode caches symlinked entrypoints). No `npm install` is needed.

```sh
mkdir -p ~/.config/opencode/plugins
cp /path/to/opencode-ssh/src/index.ts ~/.config/opencode/plugins/index.ts
```

**3. Create an agent**

`.opencode/agent/remote.md`:
```markdown
---
description: Run commands on a remote server via SSH
color: primary
mode: primary
---

When the user says "ssh <host>", use `ssh_connect` with the host name.
When they say "local", use `ssh_disconnect`.
```

## Usage

1. Switch to the **Remote** agent tab.
2. Say **"ssh myHost"** (replace `myHost` with a host from `~/.ssh/config`).
3. Ask anything — `shell` commands automatically run on the remote server.
4. Say **"local"** to disconnect.

## Example `~/.ssh/config`

```
Host myHost
    Hostname 192.100.100.100
    User username
    ServerAliveInterval 60
```

On the remote server, add your public key in `~/.ssh/authorized_keys`

With this entry, you say "ssh myHost" to connect. The `Host` value is the name you use in conversation.
