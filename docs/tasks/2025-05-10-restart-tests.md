# Task: Rewrite Test Suite for Robustness & Maintainability

## Commit 1: chore: Remove legacy tests and scaffold clean structure

**Description:**

* **Delete** the entire `test/` directory (including `tmp/` artifacts committed by mistake) and all `.d.ts` test stubs.
  *Command:* `rimraf test && git add -A`
* **Add** an empty directory tree for the new suite:

  * `test/unit/` – deterministic, dependency‑free tests.
  * `test/integration/` – small, focused process‑level tests.
  * `test/helpers/` – shared utilities (no Node API side‑effects).
* **Bootstrap** a minimal Vitest config (`vitest.config.ts`) that:

  * sets `testTimeout` = 10 000 ms,
  * runs unit tests in parallel, integration serial (`testMatch: ["**/integration/**"]`).
* **Update** `package.json` scripts:

  * `"test:unit": "vitest run --dir test/unit"`,
  * `"test:integration": "vitest run --dir test/integration"`,
  * keep `"test"` → `"vitest run"` (executes both).

**Verification:**

1. `pnpm run test` exits 0 with **no tests found**.
2. `pnpm run test:unit` & `pnpm run test:integration` both exit 0.
3. CI (`.github/workflows/ci.yml`) passes the **build** job.

---

## Commit 2: feat: Create deterministic IPC & child‑process stubs

**Description:**

* **Extract** the `Chopup` class from `src/index.ts` into `src/chopup.ts` and export it (no CLI glue). (Adjust `src/index.ts` imports.)
* **Implement** `src/test-doubles/ipc-mock.ts`:

  * exposes `createServer()` & `createConnection()` signatures identical to `node:net`,
  * uses `EventEmitter` under the hood—not a real Unix socket—eliminating FS timing issues.
* **Implement** `src/test-doubles/fake-child.ts` that mimics a wrapped process (`stdin`, `stdout`, `stderr` as streams; emits `exit`).
* Add **unit tests** in `test/unit/ipc-mock.test.ts` to assert:

  * a `request-logs` message reaches the server and returns `LOGS_CHOPPED`,
  * a `send-input` message returns `CHOPUP_INPUT_SENT`.

**Verification:**

1. `pnpm run test:unit` shows ≥2 passing tests.
2. No filesystem `.sock` files are created (check via `fs.readdirSync(os.tmpdir())`).

---

## Commit 3: test: Cover Chopup core logic with unit tests

**Description:**

* Write `test/unit/chopup-core.test.ts`:

  * Instantiate `new Chopup("echo", ["ok"], "/tmp/logs", "mock.sock")` **with** mocked IPC + fake child.
  * Assert `chopLog()` creates a file in `logDir` and resets internal buffer.
  * Assert `send-input` handler writes to fake child `stdin` and pushes `CHOPUP_INPUT_SENT` back.
* Mock `fs.promises.writeFile` with Vitest’s `vi.spy` to keep tests in‑memory.

**Verification:**

1. `pnpm run test:unit` passes; coverage for `src/chopup.ts` > 80 % lines.
2. Running with `LOG_LEVEL=debug` prints no unhandled errors.

---

## Commit 4: test: Add minimal, reliable integration smoke tests

**Description:**

* **Smoke – Run/Chop flow** (`test/integration/smoke-run-chop.test.ts`):

  * Spawn `pnpm exec tsx src/index.ts run -- echo "hello"` with `--log-dir $(mktemp -d)`.
  * Wait for `CHOPUP_SOCKET_PATH=` line (max 2 s).
  * Execute `pnpm exec tsx src/index.ts request-logs --socket <path>` and assert new log file exists & contains `hello`.
* **Smoke – send-input** (`test/integration/smoke-send-input.test.ts`):

  * Wrap `node test/fixtures/yes-no-prompt.js`.
  * Send `y\n`; assert wrapper outputs `Confirmed: yes` and returns 0.
* Use **helpers** in `test/helpers/process.ts`:

  * `waitForLine(proc, regex, timeoutMs)`
  * `withTempDir(cb)` that auto‑cleans.
* Each test owns its own `tmpDir`; cleanup with `afterEach`.

**Verification:**

1. `pnpm run test:integration` passes on Linux & macOS locally.
2. Inspect `ls -A $(os.tmpdir()) | grep chopup_` → **no leftover sockets**.

---

## Commit 5: docs: Document new testing strategy & CI updates

**Description:**

* **Add** `docs/TESTING.md`:

  * explains unit vs integration philosophy,
  * how to run subsets (`pnpm test:unit`, `pnpm test:integration`),
  * guidance on writing deterministic tests (use mocks first, real processes sparingly).
* **Update** README → “Development” section to reference new commands.
* **Amend** `.github/workflows/ci.yml`:

  * cache Vitest, run `pnpm test:unit` then `pnpm test:integration` sequentially.

**Verification:**

1. `pnpm run lint` passes (no unused‑var from new files).
2. CI green across Ubuntu/Windows/macOS matrix.
3. Contributors can follow `docs/TESTING.md` steps and reproduce passes on fresh clone.
