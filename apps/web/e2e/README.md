# E-2 Tests

End-to-end tests using [Playwright](https://playwright.dev/).

## Setup

E-2 requires Playwright to be installed. Install dependencies and browsers from the repo root:

```bash
pnpm install
pnpm exec playwright install --with-deps
```

## Running Tests

### Run all tests
```bash
pnpm run test:e2e
```

### Run tests in UI mode (recommended for development)
```bash
pnpm run test:e2e:ui
```

### Debug tests
```bash
pnpm run test:e2e:debug
```

### Run specific test file
```bash
npx playwright test e2e/home.spec.ts
```

### Run a shard locally

CI splits the suite across runners with ``playwright test --shard=i/N``. Reproduce a single shard:

```bash
npx playwright test --shard=1/2
```

## Visual Regression

`e2e/visual.spec.ts` captures the landing page (`/`) and Start flow (`/start`)
across breakpoints (desktop/mobile) and themes (light/dark). It asserts against
committed snapshots in the `e2e/visual.spec.ts-snapshots/` directory.

Visual tests run only on the `chromium` project (the CI project); other local
browsers skip them so baselines stay deterministic.

### Updating baselines

After an intentional visual change, regenerate the baselines:

```bash
pnpm run test:e2e:update-snapshots
```

Then review the diff in git before committing.

### Thresholds

Screenshots tolerate a 2% pixel delta (`maxDiffPixelRatio: 0.02`) to absorb
font-rendering variance between OSes; animations are disabled and the caret
Hidden. Dynamic regions count on the page are rendered at deterministic final
states under reduced motion.

### Run tests in specific browser
```bash
npx playwright test --project=chromium
# or firefox, webkit, Mobile Chrome, Mobile Safari
```

## Configuration

The Playwright configuration is defined in `playwright.config.ts` at the root of the `apps/web` directory. Key settings:

- `baseURL`: `http://localhost:3000` (development server)
- **Browsers**: Chromium, Firefox, Webkit, Mobile Chrome, Mobile Safari
- **Dev Server**: Automatically starts with `npm run dev`
- **Screenshots**: Captured on test failure
- **Traces**: Captured on first retry
- `retries`: `1` in CI (configured via `PLAYWRIGHT_RETRIES`), `0` locally
- `workers`: controlled by `PLAYWRIGHT_WORKERS` in CI, defaults to auto locally
- **Sharding**: CI invokes `playwright test --shard=i/N` across N runners

## Quarantine

Failing or flaky specs can be quarantined so they do not block the merge gate
while they are being fixed. Quarantine is declared in
`e2e/quarantine.json`:

```json
{
  "quarantine": [
    {
      "spec": "e2e/replay.spec.ts",
      "reason": "Fake timer flake on Webkit",
      "issue": 1640,
      "expires": "2025-01-31"
    }
  ]
}
```

Each entry must have a `spec`, a `owner/issue` tracking reference, and an
`expires` date. The config loader in `playwright.config.ts` skips matching specs
and fails the run once an entry has expired, so quarantine is always temporary.

Quarantined specs are still executed in the `disable-quarantine` job (non-blocking)
so the list does not silently rot. The effective quarantine list is uploaded as a
workflow artifact and posted as an issue comment whenever it changes.

## Best Practices

1. **Locators**: Use semantic locators (role, label) instead of CSS selectors when possible
2. **Waits**: Avoid hard waits; use Playwright's built-in waiting mechanisms
3. **Cleanup**: Tests should be independent and not rely on execution order
4. **Naming**: Use descriptive test names that explain what's being tested
5. **Accessibility**: Include tests for keyboard navigation and screen reader support
6. **Determinism**: Pin clocks and seeded fixture data; do not depend on wall-clock time or live external services

## Test Structure

Each test file should:
- Have a descriptive `test.describe()` block
- Use `test.beforeEach()` for common setup (e.g., navigation)
- Include both happy path and error cases
- Add comments for complex test logic

## Debugging

- `Trace Viewer`: `npx playwright show-trace trace.zip`
- `Screenshot`: Check `test-results/` directory for failure screenshots
- `Video`: Captured on failure in CI; enable locally in `playwright.config.ts` for slow motion debugging

## CI/CD Integration

The `.github/workflows/e2e.yml` workflow runs the full suite on every PR as
a merge gate:

- **Build once**: a single job produces the standalone build and seeded fixture data,
  shared by all shards via artifacts.
- `--shard=i/N` across N runners (N=2 to start, derived from measured runtime to keep
  the full suite under 15 minutes wall clock).
- `retries=1` per spec in CI.
- On failure, trace, video, and screenshots are uploaded as artifacts for each shard.
- The quarantine list is published as an artifact and as an issue comment when it changes.
- The `e2e/` job is a required check for merge.

## Resources

- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Test Assertions](https://playwright.dev/docs/test-assertions)
- [Selectors](https://playwright.dev/docs/locators)
- [Sharding](https://playwright.dev/docs/test-sharding)
