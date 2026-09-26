# Verification map

The suite includes subprocess CLI checks. Run `npm run check` on Linux with supported Node and util-linux `flock`. No test uses the real home or real credentials. `test/helpers.ts` implements a localhost fake server with the exact provider-list, raw export, and import request/response shapes.

| Requirement                                  | Coverage                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A → B and B → A                              | Round-trip switch and byte preservation tests                                             |
| Active A1 → A2 rotation                      | Import ordering and switch-back fingerprint test                                          |
| Current/target malformed, identity mismatch  | Exact original active-byte preservation                                                   |
| Unavailable, import failure, reauth-required | HTTP failure injection and no target export after failed push                             |
| Two simultaneous switches                    | Contending live kernel lock                                                               |
| Stale lock                                   | Stale PID metadata with retained inode                                                    |
| Running Codex                                | Default switch stops matching sessions before replacement; failure preserves active bytes |
| Atomic-write failure                         | Fault immediately before rename; staging cleanup                                          |
| Rollback                                     | Offline restore, corrupt backup skip, malformed active recovery                           |
| Background A active                          | Active import, no A export/write, remote B cache refresh                                  |
| Ambiguous selectors / shared workspaces      | Duplicate names/emails/identities and distinct same-team users                            |
| No secrets in logs/state/errors              | Fake OAuth/management sentinel checks                                                     |
| Conflicts                                    | Active divergence warning and inactive edit preservation                                  |
| Interrupted operation                        | Real child process killed by SIGKILL during staging; active validity and lock recovery    |
| Filesystem protections                       | Modes, symlinks, hardlinks, root symlink, backup retention                                |
| HTTP and configuration safety                | Scope vs auth errors, redirects, TLS, helper stderr suppression                           |
| Postcommit failure                           | COMMITTED report while target auth remains valid                                          |

Filesystem/power loss guarantees depend on the host filesystem. SIGKILL tests verify process interruption, not physical disk failure. Network tests verify the pinned contract, not live server/OpenAI credential validity. Provider listing exposes revisions rather than token fingerprints, and no upstream compare-and-swap transaction exists.
