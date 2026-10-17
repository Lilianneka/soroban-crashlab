import { defineConfig, devices } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs'; import { resolve } from 'node:path';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv").config();

/**
 * Whether this run is the dedicated accessibility gate. The a11 job sets
 * A11Y=1 so the config can scope test discovery, reporters and projects to
 * the axe-core / keyboard specs without disturbing the main e2e suite.
 */
const isA11yRun = process.env.A11Y === '1';

/**
 * Quarantine mechanism: specs listed in the quarantine manifest are skipped
 * with a tracking entry and an auto-expiry date. The manifest is published
 * as an artifact and as an issue comment when it changes (see .github/workflows/e2e.yml).
 */
interface QuarantineEntry {
  /** Glob pattern or spec path relative to the e2e directory. */
  spec: string;
  /** Issue or PR tracking the quarantine. */
  tracker: string;
  /** ISO-8601 date after which the quarantine expires and the spec runs again. */
  expires: string;
  /** Human-readable reason. */
  reason: string;
}

const quarantineManifestPath = resolve(__dirname, 'e2e/quarantine.json');

function loadActiveQuarantine(): QuarantineEntry[] {
  if (!existsSync(quarantineManifestPath)) {
    return [];
  }

  const raw = JSON.parse(readFileSync(quarantineManifestPath, 'utf-8')) as {
    entries?: QuarantineEntry[];
  };
  const entries = raw.entries ?? [];
  const now = Date.now();

  return entries.filter((entry) => {
    const expiresAt = Date.parse(entry.expires);
    if (Number.isNaN(expiresAt)) {
      throw new Error(
        `Quarantine entry for "${entry.spec}" has an invalid expiry date: ${entry.expires}`,
      );
    }
    // Expired entries are ignored so the spec returns to the gate automatically.
    return expiresAt > now;
  });
}

const activeQuarantine = isA11yRun ? [] : loadActiveQuarantine();

/**
 * Sharding: CI passes `--shard=i/N`. We derive the shard count from the
 * environment so the workflow matrix and the config stay in sync. Workers
 * are set per shard to keep total wall time under the 15-minute budget.
 */
const shardCount = Number.parseInt(process.env.PLAYWRIGHT_SHARD_COUNT ?? '2', 10);
const workersPerShard = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? '2', 10);

export default defineConfig({
  /* A11y job runs only the axe/keyboard specs under e2e/a11y. */
  testDir: isA11yRun ? './e2e/a11y' : './e2e',
  /* Skip quarantined specs while their tracking entries are still active. */
  testIgnore: activeQuarantine.map((entry) => entry.spec),
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only. Per-spec retries=1 is the merge-gate budget. */
  retries: process.env.CI ? 1 : 0,
  /* Parallelize within a shard on CI; total workers are bounded by the runner. */
  workers: process.env.CI ? workersPerShard : undefined,
  /* Test timeout */
  timeout: 30000,
  /* Snapshots must be platform-agnostic: baselines generated on any OS must
   * match on the Linux CI runner. Font differences are tolerated by
   * maxDiffPixelRatio below, so omit the default {platform} segment. */
  snapshotDir: 'e2e/visual.spec.ts-snapshots',
  snapshotPathTemplate: '{snapshotDir}/{arg}-{projectName}{ext}',
  /* Expect timeout */
  expect: {
    timeout: 5000,
    /* Visual comparison thresholds. Font rendering varies across OSes; the
     * e2e job runs chromium on Linux while baselines may be produced anywhere,
     * so tolerate small pixel deltas. See e2e/visual.spec.ts. */
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    },
  },
  /* Reporter to use. See https://playwright.dev/docs/test-reporters.
   * A11y runs emit a dedicated report folder so the HTML report is uploaded
   * as an artifact without colliding with the main e2e job. */
  reporter: isA11yRun
    ? [
        ['html', { open: 'never', outputFolder: 'playwright-report-a11y' }],
        ['json', { outputFile: 'test-results-a11y/results.json' }],
        ['junit', { outputFile: 'test-results-a11y/junit.xml' }],
        ...(process.env.CI ? [['ithub']] : []),
      ]
    : [
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['json', { outputFile: 'test-results/results.json' }],
        ['junit', { outputFile: 'test-results/junit.xml' }],
        ...(process.env.CI ? [['github']] : []),
      ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://localhost:3077',
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    /* Screenshot on failure */
    screenshot: 'only-on-failure',
    /* Video on failure so debugging a red merge gate doesn't require a rerun. */
    video: 'on-first-retry',
  },

  /* Configure projects for major browsers. The a11y gate runs a cross-browser
   * matrix on purpose: contrast and keyboard regressions can be engine-specific. */
  projects: isA11yRun
    ? [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
        },
        {
          name: 'firefox',
          use: { ...devices['Desktop Firefox'] },
        },
        {
          name: 'webkit',
          use: { ...devices['Desktop Safari'] },
        },
      ]
    : process.env.CI
    ? [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
        },

        {
          name: 'firefox',
          use: { ...devices['Desktop Firefox'] },
        },

        {
          name: 'webkit',
          use: { ...devices['Desktop Safari'] },
        },

        /* Test against mobile viewports. */
        {
          name: 'Mobile Chrome',
          use: { ...devices['Pixel 5'] },
        },
        {
          name: 'Mobile Safari',
          use: { ...devices['iPhone 12'] },
        },

        /* Test against branded browsers. */
        // {
        //   name: 'Microsoft Edge',
        //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
        // },
        // {
        //   name: 'Google Chrome',
        //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
        // },
      ],

  /* Run your local dev server before starting the tests.
   * CI already builds the app; use `next start` there so tests hit the
   * production bundle instead of a cold `next dev` compile (which hangs). */
  webServer: {
    // CI already runs `pnpm run build`; start the production server there.
    // Locally prefer `next dev` for faster iteration.
    command: process.env.CI
      ? 'pnpm exec next start -p 3077'
      : 'pnpm exec next dev -p 3077',
    url: 'http://localhost:3077',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_APP_URL: 'http://localhost:3077',
    },
  },
});
