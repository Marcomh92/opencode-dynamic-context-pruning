# MY_CHANGELOG.md - Personal Change History

## Format
Each entry must include:
- Date
- Branch
- Summary of changes
- Reason for changes
- Files modified

---

## 2026-08-05 - Relocated Fork to Standard Plugin Directory
- **Branch:** `fork/dcp-3.1.15-m1`
- **Changes:**
  - Moved fork from `C:\Users\marco\.config\opencode_plugins\opencode-dynamic-context-pruning-fork` to `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork`
  - Same-volume rename; `.git/`, `node_modules/`, `dist/` carried over intact (no reinstall or rebuild needed)
  - Verified post-move: `node_modules/` present, `dist/` present, `MY_README.md` + `MY_CHANGELOG.md` present, `.git/` present (remotes intact)
- **Reason:** The user's existing local-plugin convention places file:// plugins under `C:/Beheer/OpenCode/opencode_plugins/` (see `opencode.json` lines 570-572). The initial location under `~/.config/opencode_plugins/` broke that convention and was incorrect.
- **Files:** none (filesystem-level relocation only)

## 2026-08-05 - Initial Fork
- **Branch:** `fork/dcp-3.1.15-m1` (cut from `upstream/master` @ v3.1.14)
- **Changes:**
  - Cloned `https://github.com/Marcomh92/opencode-dynamic-context-pruning.git` (initially to `C:\Users\marco\.config\opencode_plugins\opencode-dynamic-context-pruning-fork`; relocated same day to `C:\Beheer\OpenCode\opencode_plugins\opencode-dynamic-context-pruning-fork` -- see entry above)
  - Added `upstream` remote pointing at `https://github.com/Opencode-DCP/opencode-dynamic-context-pruning.git`
  - Created feature branch `fork/dcp-3.1.15-m1` off `upstream/master`
  - Verified baseline: `bun install` OK (163 packages, 3.30 s), `bun run build` OK (`dist/index.js` 272.22 KB, sourcemap 585.25 KB), `bun run test` OK (87/87 pass, 1.91 s)
  - Authored `MY_README.md` and `MY_CHANGELOG.md` (this file)
- **Reason:** Establish a local-only fork of the OpenCode DCP plugin to:
  1. Fix 9 known upstream bugs (#592, #579, #573, #590, #588, #585, #575, #581, #595)
  2. Add a v2 reliable autonomous compress protocol
  3. Adapt for the user's Win 11 / OpenCode 1.18.9 / Bun / kimi-for-coding environment
  4. Preserve distribution via `file://` directory entry (no npm publish; AGPL network clause not triggered)
- **Files:** `MY_README.md` (new), `MY_CHANGELOG.md` (new)