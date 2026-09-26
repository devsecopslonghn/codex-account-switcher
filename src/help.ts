export const commandNames = [
  "setup",
  "list",
  "current",
  "sync",
  "sync-all",
  "use",
  "rollback",
  "doctor",
] as const;

export type CommandName = (typeof commandNames)[number];

export function isCommandName(value: string): value is CommandName {
  return commandNames.some((name) => name === value);
}

export function isHelpFlag(value: string): boolean {
  return value === "-h" || value === "--help" || value === "-help";
}

interface CommandHelp {
  usage: string;
  summary: string;
  description: string;
  options?: string[];
  examples: string[];
  notes?: string[];
}

const commands: Record<CommandName, CommandHelp> = {
  setup: {
    usage: "codex-account setup",
    summary: "Configure OmniRoute access in an encrypted local vault",
    description:
      "Ask for the OmniRoute URL, an admin Access Token, and a vault passphrase. Validate admin access before replacing the saved configuration.",
    examples: ["codex-account setup"],
    notes: [
      "The token and passphrase are never accepted as command-line arguments.",
      "An interactive terminal is required. Setup does not switch Codex accounts.",
      "After a reboot, enter the vault passphrase once to unlock it; do not re-enter the admin token.",
    ],
  },
  list: {
    usage: "codex-account list",
    summary: "List available Codex OAuth connections",
    description:
      "Show connection IDs, names, emails, status, and whether each connection matches the active local Codex login.",
    examples: ["codex-account list"],
    notes: [
      "active: true means the connection matches ~/.codex/auth.json; false does not mean disabled.",
      "Use an exact, unique email or the full connection ID when switching.",
    ],
  },
  current: {
    usage: "codex-account current",
    summary: "Inspect the active local Codex login",
    description:
      "Read ~/.codex/auth.json and report its identity, expiry, matching OmniRoute connection, and last known sync status.",
    examples: ["codex-account current"],
    notes: [
      "UNSYNCED_OR_UNKNOWN means there is no matching local sync baseline; it does not by itself mean the login is invalid.",
      "The local identity is still reported when OmniRoute is unavailable.",
    ],
  },
  sync: {
    usage: "codex-account sync",
    summary: "Push the active local login to OmniRoute",
    description:
      "Save the current auth to its local cache and import it into the matching OmniRoute connection. It does not replace active auth.",
    examples: ["codex-account sync"],
    notes: [
      "The local active auth is authoritative; independent changes may produce a conflict warning.",
    ],
  },
  "sync-all": {
    usage: "codex-account sync-all",
    summary: "Sync active auth and refresh inactive local caches",
    description:
      "Push the active local login first, then export other Codex OAuth connections into their local caches.",
    examples: ["codex-account sync-all"],
    notes: [
      "It never exports or replaces the active login. Inactive exports may refresh remote tokens.",
      "Partial failures are reported in JSON and cause exit status 1.",
    ],
  },
  use: {
    usage: "codex-account use <selector> [-f|--force]",
    summary: "Switch the active local Codex login",
    description:
      "Select a connection by full ID, unique ID prefix, exact name, or exact email (case-insensitive). A non-unique selector is rejected.",
    options: ["-f, --force  Bypass only the running-Codex process check."],
    examples: [
      "codex-account list",
      "codex-account use 'person@example.com'",
      "codex-account use 'person@example.com' -f",
    ],
    notes: [
      "Email is a selector, not the internal userId used to verify account identity.",
      "Normally close Codex CLI and IDE sessions before switching.",
      "With -f/--force, a running session may keep the old account or later overwrite auth.json. Restart every Codex session after switching and check 'codex-account current' again.",
      "File, identity, lock, and backup checks remain enabled with force.",
    ],
  },
  rollback: {
    usage: "codex-account rollback",
    summary: "Restore the latest valid distinct local backup",
    description:
      "Restore ~/.codex/auth.json from a local backup without contacting OmniRoute or loading its management credential.",
    examples: ["codex-account rollback"],
    notes: [
      "Close Codex CLI and IDE sessions first; rollback has no force option.",
      "Restoring a file cannot undo a remote OAuth token rotation or revocation.",
    ],
  },
  doctor: {
    usage: "codex-account doctor",
    summary: "Check local setup and OmniRoute connectivity",
    description:
      "Report configuration, active auth, private-file permissions, lock state, management access, remote identity mapping, and running Codex processes.",
    examples: ["codex-account doctor"],
    notes: [
      "A running Codex process makes the report unhealthy because it can interfere with switching.",
      "Doctor does not import, export, or replace OAuth credentials.",
    ],
  },
};

function wrap(text: string, indent = "  ", width = 80): string[] {
  const lines: string[] = [];
  let line = indent;
  for (const word of text.split(/\s+/)) {
    if (line.length > indent.length && line.length + word.length + 1 > width) {
      lines.push(line);
      line = indent + word;
    } else {
      line += (line.length === indent.length ? "" : " ") + word;
    }
  }
  lines.push(line);
  return lines;
}

export function commandHelp(name: CommandName): string {
  const command = commands[name];
  return [
    `Usage: ${command.usage}`,
    "",
    command.summary,
    "",
    ...wrap(command.description, ""),
    "",
    ...(name === "use"
      ? [
          "Selector:",
          "  <selector>   Full ID, unique ID prefix, exact name, or exact email.",
          "",
        ]
      : []),
    "Options:",
    "  -h, --help, -help  Show this command's help.",
    ...(command.options?.map((option) => `  ${option}`) ?? []),
    "",
    "Examples:",
    ...command.examples.map((example) => `  ${example}`),
    ...(command.notes
      ? ["", "Notes:", ...command.notes.flatMap((note) => wrap(note))]
      : []),
    "",
  ].join("\n");
}

export function globalHelp(): string {
  return [
    "codex-account — official Codex OAuth account manager",
    "",
    "Usage: codex-account <command> [options]",
    "       codex-account help [command]",
    "",
    "Commands:",
    ...commandNames.map((name) => {
      const label = name === "use" ? "use <selector> [-f]" : name;
      return `  ${label.padEnd(21)} ${commands[name].summary}`;
    }),
    "",
    "Global options:",
    "  -h, --help, -help  Show general help; after a command, show its help.",
    "  -V, --version   Show the installed version.",
    "",
    "Run 'codex-account <command> --help' for syntax, options, examples, and safety notes.",
    "Run 'codex-account setup' once; a bare 'codex-account' starts setup if not configured.",
    "Commands return JSON; help and usage errors do not open the vault or contact OmniRoute.",
    "Exit status: 0 success/help, 1 operation failed, 2 invalid command or arguments.",
    "",
  ].join("\n");
}
