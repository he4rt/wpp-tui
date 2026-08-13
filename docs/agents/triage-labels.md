# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker. The vocabulary follows the `brd-digital` house scheme, minus the `mod:*` module labels (wpp-tui is a single-package repo with no `app-modules/`).

| Label in skills   | Label in our tracker | Meaning                                  |
| ----------------- | -------------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`    | Requires human implementation            |
| `wontfix`         | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Already on GitHub: `ready-for-agent`, `wontfix`. Still to create: `needs-triage`, `needs-info`, `ready-for-human`.

---

# Type Labels

Issue type follows conventional commit prefixes.

| Label           | Meaning                       |
| --------------- | ----------------------------- |
| `type:feat`     | New feature                   |
| `type:fix`      | Bug fix                       |
| `type:refactor` | Code refactoring              |
| `type:docs`     | Documentation                 |
| `type:chore`    | Maintenance / tooling         |

---

# Difficulty Labels

Every implementable issue should be tagged with a difficulty estimate.

| Label                | Estimate  | Meaning                                          |
| -------------------- | --------- | ------------------------------------------------ |
| `difficulty:trivial` | < 1 day   | Deletion, config changes, scripts                |
| `difficulty:easy`    | 1-2 days  | Single file/function, well-defined scope         |
| `difficulty:medium`  | 3-5 days  | Multiple files, moderate complexity              |
| `difficulty:hard`    | 1-2 weeks | Cross-cutting, complex logic                     |
| `difficulty:epic`    | 2+ weeks  | Entire new subsystem, major refactors            |

---

# Title Convention

Issue titles follow **conventional commits**. This repo is single-context, so there is no module scope:

```
<type>: <short description in English>
```

Examples:
- `feat: pairing-code auth for headless collector`
- `refactor: extract collector core from the React app`
- `fix: poll decryption drops the message secret on restart`
- `docs: ADR for headless pre-provisioned auth`
