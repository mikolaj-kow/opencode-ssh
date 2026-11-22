import { execSync } from "child_process"
import path from "path"
import os from "os"
import { existsSync, rmSync, writeFileSync } from "fs"

type SessionState = {
  host: string
  socketPath: string
}

const sessionMap = new Map<string, SessionState>()

function sock(host: string) {
  return path.join(os.homedir(), ".ssh", `cm-${host}`)
}

/** POSIX single-quote a string so it survives exactly one local shell parse. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`
}

/** Login the SSH config resolves for a host (defaults to the local username). */
function configuredUser(host: string): string {
  try {
    const out = execSync(`ssh -G ${shq(host)}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString()
    return /^user (.*)$/m.exec(out)?.[1]?.trim() || os.userInfo().username
  } catch {
    return os.userInfo().username
  }
}

/** Run a command through an existing ControlMaster; null when unusable. */
function muxProbe(socketPath: string, host: string, cmd: string): string | null {
  try {
    return execSync(`ssh -S ${shq(socketPath)} ${shq(host)} ${shq(cmd)}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).toString()
  } catch {
    return null
  }
}

/** True when a live ControlMaster listens on the socket (`ssh -O check`). */
function masterAlive(socketPath: string, host: string): boolean {
  try {
    execSync(`ssh -O check -S ${shq(socketPath)} ${shq(host)}`, { stdio: "pipe", timeout: 10000 })
    return true
  } catch {
    return false
  }
}

function ensureSentinel(): string {
  const p = path.join(os.tmpdir(), "__opencode_remote_mode__")
  try {
    writeFileSync(
      p,
      "This tool is not available in remote SSH mode.\nUse the shell tool with cat/tee/grep/find over SSH instead.\n",
    )
  } catch {}
  return p
}

const REMOTE_SYSTEM = (host: string) =>
  [
    "",
    "## Remote SSH Mode",
    "",
    `You are connected to **${host}** via persistent SSH.`,
    "",
    "1. The **shell** tool is automatically wrapped with SSH. Do NOT add SSH yourself.",
    "2. Use shell with `cat`, `tee`, `grep`, `find` for all remote file ops.",
    "3. Native `read`/`write`/`edit`/`glob`/`grep` tools are disabled in remote mode.",
    '4. Say "local" to disconnect.',
  ].join("\n")

let sentinel: string

function connect(host: string, sessionID: string): string {
  const socketPath = sock(host)

  const existing = sessionMap.get(sessionID)
  if (existing) {
    try {
      execSync(`ssh -O stop -S ${shq(existing.socketPath)} ${shq(existing.host)}`, { stdio: "pipe" })
    } catch {}
    sessionMap.delete(sessionID)
  }

  // A live ControlMaster on this socket that we did not create (e.g. left by
  // another tool, possibly authenticated as a different user) makes
  // `ssh -MNf` silently disable multiplexing while still exiting 0 — every
  // wrapped command would then run as whoever that master authenticated as.
  // Only reuse the socket when it is alive and speaks as the configured user.
  if (existsSync(socketPath)) {
    if (masterAlive(socketPath, host)) {
      const user = muxProbe(socketPath, host, "whoami")
      if (user !== null && user.trim() === configuredUser(host)) {
        sessionMap.set(sessionID, { host, socketPath })
        return [
          `SSH connection to **${host}** established as \`${user.trim()}\` (reusing the existing ControlMaster).`,
          "Use shell with `cat`, `tee`, `grep`, `find` for file operations.",
          'Say "local" to disconnect.',
        ].join("\n")
      }
      // Foreign master: stop it so we can create our own.
      try {
        execSync(`ssh -O stop -S ${shq(socketPath)} ${shq(host)}`, { stdio: "pipe" })
      } catch {}
    }
    // Dead master or unusable socket file: drop it.
    try {
      rmSync(socketPath, { force: true })
    } catch {}
  }

  try {
    execSync(`ssh -MNf -S ${shq(socketPath)} ${shq(host)}`, { stdio: "pipe", timeout: 15000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Failed to connect to ${host}: ${msg}`
  }

  if (!masterAlive(socketPath, host)) {
    return `Failed to connect to ${host}: the ControlMaster did not come up.`
  }
  const user = muxProbe(socketPath, host, "whoami")
  if (user === null) {
    return `Failed to connect to ${host}: the ControlMaster did not come up.`
  }

  sessionMap.set(sessionID, { host, socketPath })

  return [
    `SSH connection to **${host}** established as \`${user.trim()}\`. All shell commands will now run remotely.`,
    "Use shell with `cat`, `tee`, `grep`, `find` for file operations.",
    'Say "local" to disconnect.',
  ].join("\n")
}

function disconnect(sessionID: string): string {
  const state = sessionMap.get(sessionID)
  if (!state) return "Not currently connected."

  try {
    execSync(`ssh -O stop -S ${shq(state.socketPath)} ${shq(state.host)}`, { stdio: "pipe" })
  } catch {}
  sessionMap.delete(sessionID)

  return "Disconnected. Commands now run locally."
}

function cleanup() {
  for (const state of sessionMap.values()) {
    try {
      execSync(`ssh -O stop -S ${shq(state.socketPath)} ${shq(state.host)}`, { stdio: "pipe" })
    } catch {}
  }
  sessionMap.clear()
}

const CONNECT_DESCRIPTION =
  "Open a persistent SSH connection to a remote server. Call this when the user says 'ssh <host>' or asks to connect to a server. The host must be defined in ~/.ssh/config."

const DISCONNECT_DESCRIPTION =
  "Close the persistent SSH connection and return to local mode. Call this when the user says 'local' or asks to disconnect."

/** Rewrites args of local-only tools so they fail harmlessly while in remote mode. */
function neutralizeLocalTool(name: string, args: Record<string, unknown>): boolean {
  switch (name) {
    case "read":
      args.path = args.filePath = sentinel
      args.offset = undefined
      args.limit = undefined
      return true
    case "write":
      args.path = args.filePath = path.join(os.tmpdir(), "__opencode_remote_write__")
      args.content = "This tool is not available in remote mode."
      return true
    case "edit":
      args.path = args.filePath = sentinel
      args.oldString = "SENTINEL_MARKER_THAT_WILL_NEVER_EXIST"
      args.newString = ""
      args.replaceAll = false
      return true
    case "patch":
      args.patchText = "*** Begin Patch\n*** End Patch\n"
      return true
    case "glob":
      args.pattern = "__OPENCODE_REMOTE_GLOB_UNAVAILABLE__"
      args.path = "/tmp"
      return true
    case "grep":
      args.pattern = "^__OPENCODE_REMOTE_GREP_UNAVAILABLE__$"
      args.path = "/tmp"
      args.include = undefined
      return true
    default:
      return false
  }
}

/** Wraps a shell command with SSH when the session is in remote mode. */
function wrapShell(name: string, args: Record<string, unknown>, state: SessionState): void {
  if (name !== "shell" && name !== "bash") return
  const cmd = typeof args.command === "string" ? args.command : ""
  if (cmd.startsWith(`ssh -S "${state.socketPath}"`)) return
  // Pass the command as a single quoted argument: ssh hands it verbatim to the
  // remote login shell, so quoting, parentheses and expansions written for the
  // remote shell keep their meaning (an unquoted `${cmd}` would be re-parsed by
  // the local shell first and arrive mangled — and could inject into it).
  args.command = `ssh -S ${shq(state.socketPath)} ${shq(state.host)} ${shq(cmd)}`
  if (typeof args.description === "string") {
    args.description = `[remote ${state.host}] ${args.description}`
  }
}

export default {
  id: "opencode-ssh",
  async setup(ctx) {
    sentinel ??= ensureSentinel()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "ssh_connect",
        description: CONNECT_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            host: { type: "string", description: "SSH host name from ~/.ssh/config, e.g. 'myHost'" },
          },
          required: ["host"],
          additionalProperties: false,
        },
        async execute(input, context) {
          return { content: connect((input as { host: string }).host, context.sessionID) }
        },
      })

      editor.add({
        name: "ssh_disconnect",
        description: DISCONNECT_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          return { content: disconnect(context.sessionID) }
        },
      })
    })

    await ctx.tool.hook("execute.before", (event) => {
      const state = sessionMap.get(event.sessionID)
      if (!state) return

      const input = event.input as Record<string, unknown> | undefined
      if (!input || typeof input !== "object") return

      wrapShell(event.tool, input, state)
      neutralizeLocalTool(event.tool, input)
    })

    await ctx.session.hook("context", (event) => {
      const state = sessionMap.get(event.sessionID)
      if (!state) return
      event.system.push({ type: "text", text: REMOTE_SYSTEM(state.host) })
    })

    return cleanup
  },
}
