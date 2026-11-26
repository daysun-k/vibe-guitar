# Verification

What to run on a change to this repository, what evidence a pull request carries, and when a check
on a real browser or phone is needed. Commands come from `package.json`; the app routes live in
[README.md](README.md).

## Verification matrix

| Surface | Command or check | Required result | Evidence |
|---|---|---|---|
| CI | `PR checks / typecheck + test` (`.github/workflows/pr-checks.yml`) | Success on the pull request head | Actions run URL and the head SHA it ran on |
| Local, every change | `npm run typecheck && npm test` | Exit 0 | Test summary line in the receipt (files, tests passed, skipped) |
| Local, extension build | `npm run fetch-models` (once) then `npm run build` | Exit 0, manifest reference check passes | Receipt output |
| Optional, audio features | `uv run --with librosa==0.10.2.post1 --with numpy python scripts/verify-features.py`, then `npm test` | The two parity tests in `tests/features.test.ts` run (not skipped) and pass | Receipt output naming both tests |
| Manual, browser | The extension loaded from `dist/` in desktop Chrome on a YouTube or YouTube Music song (README "Load and test") | The changed behaviour is seen as described | Receipt row with what was checked, build commit and date; screenshots under `docs/` only when needed |
| Manual, phone | `npm run phone-check`, `npm run phone-layout`, then a real phone on the same Wi-Fi (README "Phone music stand") | Scripts exit 0; the phone shows the changed view | Receipt output plus what was seen on the phone |

The CI job runs on every pull request with no path filter, so docs-only pull requests get a run too.
It does not build the extension: the build needs the pinned models (`models/`, gitignored, ~22 MB),
which CI does not download. Two tests skip without local files: the mel filterbank test needs
`models/mel-filterbank.bin` (from `npm run fetch-models`), and the CQT parity test needs
`bench-out/cqt-parity.json` (from `scripts/verify-features.py`). A skipped test is not a pass for the
change that it covers.

An `in_progress` or queued check is incomplete. A failed check blocks merge. A skipped or neutral
check never counts as a pass.

## Change-to-check guide

| Change | Required checks | Skip condition and reason |
|---|---|---|
| Any change | CI green on the head; `npm run typecheck && npm test` | None |
| `src/audio/features.ts` (log-mel or CQT) or the model input shapes | Above, plus `npm run fetch-models` and the optional `scripts/verify-features.py` run so both parity tests execute | Skip only when the change cannot alter feature values (comments, names, types); say so in the receipt |
| `src/extension/` (service worker, content scripts, offscreen capture, side panel), `scripts/build.mjs`, `scripts/build-config.mjs`, the manifest or anything bundled into `dist/` | Above, plus `npm run build` and a manual browser check of the changed behaviour | Skip the browser check only for changes with no runtime effect (comments, tests only) |
| Side panel UI (`src/play/`, `src/extension/sidepanel/`) | Above, plus the browser check or `npm run build` then `node scripts/screens.mjs` screenshots of `sidepanel.html?demo=1` | The demo screenshots replace the browser check only when the change shows in the demo song |
| `src/phone/`, `scripts/phone*.mjs`, `Vibe Guitar Phone.command` | Above, plus `npm run phone-check` and `npm run phone-layout`; a real phone when the view or connection changes | Real phone skipped only when the scripts cover the change (relay rules, layout sizes) |
| Recognition, arrangement, chart or lyrics logic (`src/recognize/`, `src/arrange/`, `src/chart/`, `src/lyrics/`, `src/music/`) | CI and local tests; accuracy scripts (`npm run accuracy-report`, `npm run paired-eval` and others in README) when the change claims an accuracy effect | Accuracy scripts skipped when no accuracy claim is made |
| Docs, evidence records, practice charts under `docs/` | CI green | The local run may be skipped when no code or test changed; CI still runs |

No code-owned list in this repository is mirrored by a documentation table, so there is no
document consistency check; `README.md` describes the routes in prose.

## Merge rules

- This is a private repository on GitHub Free, so branch protection and required checks are not
  available. Nothing technically blocks a merge with a red or missing check: these rules are a
  process contract. Merge only after the `PR checks` run on the current pull request head has
  finished green.
- Every pull request has a `## 검증` receipt with one row per check: the exact command or check
  name, the observed result, `executed` or `skipped` with the reason, and the evidence (run URL with
  head SHA, output, or a committed evidence path). Do not leave required evidence only in `/tmp`.
- Re-read the head before merging and pass `--match-head-commit <current-head-sha>` to
  `gh pr merge`. A push after the green run needs a new green run.
- Changes to this file, `.github/workflows/`, or agent instructions are control-plane changes: the
  pull request records the owner's original request, and a fresh independent review by a non-author
  session reads the diff and names the reviewed head before merge.
- Getting enforced required checks would mean making the repository public or moving to a paid plan.
  That is a decision for the owner alone; no agent changes repository visibility, plan, branch
  protection or billing.
