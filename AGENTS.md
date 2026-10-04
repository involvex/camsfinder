# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project Overview

`camsfinder` is a single-purpose, headful-browser CLI scraper. It launches the **locally
installed Google Chrome** through Playwright, navigates to a model-listing page on
`camsfinder.com`, dismisses the age gate, and extracts a table of models (name, URL, age,
country) into `out/result.txt`.

The whole program is one file: `src/index.ts`. Keep it that way until there is a concrete
reason to split it — there is no build step for sub-modules and no test harness yet.

### How it works (read this before editing `src/index.ts`)

1. **Profile copy** — `prepareUserDataDir()` copies the _entire_ real Chrome user data dir
   into `%TEMP%\camsfinder-chrome`.
   - The real profile cannot be used directly: it is locked by the running Chrome, which
     manifests as _"Opened in an existing browser session" → "Target page, context or
     browser has been closed"_.
   - Copying only the profile folder is **not** enough. Extensions are enabled through
     `Local State` + the profile's `Preferences`/`Secure Preferences`, so the whole tree is
     copied.
   - `skip_dirs` drops large useless caches to keep the copy fast; `lock_files` (plus
     `LOCK`) are filtered during the copy and removed again afterwards so the copy never
     looks "locked".
2. **Launch** — `chromium.launchPersistentContext()` with `channel: 'chrome'` (system
   Chrome, not the Playwright download) and `ignoreDefaultArgs: ['--disable-extensions']`,
   because Playwright adds that flag by default and the copied extensions would then never
   load. `headless: false` and `viewport: null` are both required.
3. **Navigate** — reuses the first page of the persistent context, closes the rest, retries
   once in a fresh page if it is stuck on `about:blank`.
4. **Wait** — the cards are rendered lazily (`content-visibility`), so waiting for the
   selector alone is not enough; `waitForFunction` additionally asserts that at least one
   `a[href^="/model/"]` exists.
5. **Extract** — all DOM work happens inside a single `page.evaluate()`. It is a pure
   function of the DOM, has **no access to Node APIs**, and receives the selector as its
   only argument.
6. **Output** — `console.table(models)` for the terminal, plus `formatModelsTable()` which
   re-renders the same table as plain box-drawing text and writes it to `out/result.txt`.

## Useful Commands

Run everything through `bun`. Do not use npm, yarn, or pnpm — the lockfile is `bun.lock`.

```bash
bun install                # install deps

bun run dev                # run the scraper from source
bun run dev -- --url https://www.camsfinder.com/woman/chaturbate   # custom page
.\dist\camsfinder.exe      # run the compiled binary (after bun run build)

bun run check              # format + lint:fix + typecheck — the gate, run this before you finish
bun run format             # prettier --write
bun run lint               # eslint
bun run lint:fix           # eslint --fix
bun run typecheck          # tsc --noEmit
bun x prettier . --check   # non-mutating format check

bun run build              # compiles to dist/camsfinder.exe (prebuild runs `check` first)
```

### Configuration

All optional, all read from the environment:

| Variable         | Default                                      | Purpose                                 |
| ---------------- | -------------------------------------------- | --------------------------------------- |
| `TARGET_URL`     | `https://www.camsfinder.com/girl/chaturbate` | Page to scrape (overridden by `--url`)  |
| `CHROME_PROFILE` | `Default`                                    | Chrome profile name, e.g. `"Profile 1"` |
| `LOCALAPPDATA`   | OS-provided                                  | Windows Chrome user data dir            |

`--url <value>` takes precedence over `TARGET_URL`. A missing or flag-like value is warned
about and the previous URL is kept — it does not error.

```powershell
$env:TARGET_URL = 'https://www.camsfinder.com/woman/chaturbate'
$env:CHROME_PROFILE = 'Profile 1'
bun run dev
```

## Technologies

- **Bun 1.4.x** — runtime, package manager, script runner, and `bun build --compile` for
  the standalone binary. This is the only supported toolchain.
- **TypeScript 6.x** — `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `moduleResolution: "bundler"`, `noEmit` (typecheck only; Bun does the running).
- **Playwright 1.63** (+ `chromium-bidi`) — browser driving. Only Chromium/Chrome is used.
- **ESLint 10** flat config (`eslint.config.ts`) with `js/recommended` and
  `typescript-eslint` recommended. Globals: browser + node.
- **Prettier 3** via the shared `@involvex/prettier-config`.

## Best Practices and Guidelines

### Formatting

Do not hand-format. The style is enforced by Prettier and is **unusual** — match it exactly:

- **Tabs**, never spaces
- **No semicolons**
- **Single quotes**
- `bracketSpacing: false` → `{sleep}`, not `{ sleep }`
- `arrowParens: 'avoid'` → `err => { ... }`, not `(err) => { ... }`
- Trailing commas everywhere

Run `bun run format` before you finish. Do not "fix" formatting in a diff by hand; that
guarantees a conflict with the formatter.

### Naming

- Module-level constants and locals: **`snake_case`** (`chrome_user_data_dir`,
  `profile_name`, `lock_files`, `skip_dirs`, `grid_selector`). This is unusual for TypeScript
  but it is the established convention in this file — follow it.
- Functions: `camelCase` (`prepareUserDataDir`, `extractModelUrls`, `formatModelsTable`).
- Type aliases use **`type`, not `interface`**.

### TypeScript

- `noUncheckedIndexedAccess` is on. Index access yields `T | undefined`. Prefer
  `arr.at(-1)` / `?? fallback` / optional chaining over a non-null assertion `!`. Never
  silence it with `as`.
- `verbatimModuleSyntax` is on. Type-only imports must use `import type` (or the inline
  `, type X` form, as in `import {chromium, type Page} from 'playwright'`).
- Give every function an explicit return type.
- Prefer `node:` prefixed builtins (`node:fs`, `node:os`, `node:path`) and Bun builtins
  (`sleep` from `bun`).

### Browser automation

- **The code is intentionally defensive.** Optional interactions are chained with
  `.catch(() => {})` or a `.catch(() => console.log(...))` handler, plus generous timeouts,
  because the target page and the user's Chrome profile are both uncontrolled. Keep that
  posture; do not convert these to hard failures.
- Default timeouts are set explicitly: 60 s actions, 120 s navigation. Keep them.
- Always `await context.close()` in a `finally` block so a crash never leaves an orphaned
  Chrome process holding the profile copy.
- Anything added to `page.evaluate()` must stay self-contained — no Node imports, no
  closures over outer variables. Pass extra values in as arguments.
- **The top-level call is not awaited** (`extractModelUrls(targetUrl)`). This is deliberate;
  `extractModelUrls` catches its own errors internally. Do not add an `await` or a
  `process.exit()` without understanding the shutdown path.

### Errors and logging

- Use `console.log` for progress, `console.warn` for recoverable/unexpected-but-continuable
  situations, `console.error` for the final failure. Nothing throws out of the entry point.
- Log **what** is being attempted before a slow step (the profile copy can take a while and
  would otherwise look like a hang).

### Comments

Comments explain **why**, not what. This file is a good model: the profile-copy block
documents the Chrome-locking failure mode and the `Local State` dependency. Preserve that.
Non-obvious browser quirks and workarounds _must_ be commented — the next reader has no way
to rediscover them.

### Security — handle with care

- `prepareUserDataDir()` copies the user's **real Chrome profile** — cookies, session tokens,
  and anything else the browser stored — into `%TEMP%\camsfinder-chrome`.
  - Never commit that directory. Never add it to a debug dump, an uploaded log, an issue
    report, or model output.
  - Never log or print profile contents, cookie values, or the contents of `Local State`.
  - Do not add telemetry, network calls, or analytics that would transmit any of it.
  - The temp copy is wiped (`rmSync`, `recursive: true, force: true`) on every run before
    being recreated. Keep that behavior; never skip the clean-up.
- `.env` is gitignored and currently holds `TARGET_URL`. Do not commit it or echo its values
  into source, fixtures, or output files.
- `out/` and `result.txt` are gitignored scratch output. They contain scraped live data —
  never commit them.
- There is no auth layer and no test suite; treat any new dependency or network destination
  as a decision that needs a deliberate reason.

### Known gotchas

- **`out/` must exist before running.** `writeFileSync('out/result.txt', ...)` does **not**
  create parent directories, and `out/` is gitignored, so on a fresh clone the write throws
  `ENOENT`. Run `mkdir out` (or `New-Item -ItemType Directory out`) first. If you move the
  output path, add the `mkdirSync(..., {recursive: true})` that is currently missing.
- `dist/` is gitignored, so the `camsfinder` bin entry only resolves after `bun run build`.
  The `camsfinder-cli` bin points at `src/index.ts` and needs a Bun runtime.
- `headless: false` means the scraper needs an interactive desktop session. It will not work
  in a headless CI runner or over plain SSH without a display.
- The compiled binary is ~95 MB because it bundles Playwright and the Chrome channel.
- `.prettierignore` skips `bun.lockb` but **not** `bun.lock`; if the formatter touches the
  lockfile, revert that change.
- `component_crx_cache` appears twice in `skip_dirs` (once raw, once uppercased) — it is
  already covered by the `base` comparison; do not "fix" it by adding more variants.

### Before you finish

```bash
bun run check
```

It is the same gate `prebuild` runs, and it must exit clean. Also confirm you have not
introduced any absolute machine-specific paths — the code resolves the Chrome directory from
`LOCALAPPDATA` with a `HOME`-based fallback for non-Windows, and new code should follow the
same pattern.
