import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs'; import { resolve } from 'node:path';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv").config();

/**
 * Whether this run is the dedicated accessibility gate. The a11j job sets
 * A11Y=1 so the config can scope test discovery, reporters and projects to the
 * axe-core / keyboard specs without disturbing the main e2e suite.
 */
const isA11yRun = process.env.A11Y === '1';

/**
 * Quarantine list. Each entry names a spec (glob relative to this config) that
 * is temporarily excluded from the merge gate. Entries must carry a tracking
 * issue and an auto-expiry date; once the date passes, the spec is reinstated
 * automatically (and the stale entry is reported). The list is published as an
 * artifact by the e2e workflow.
 */
interface QuarantineEntry {
  /** Spec glob, relative to apps/web. */
  spec: string;
  /** Tracking issue URL or number. */
  tracking: string;
  /** ISO date after which the quarantine expires. */
  expires: string;
  /** Human-readable reason. */
  reason?: string;
}

const quarantineFile = resolve(__dirname, 'e2e/quarantine.json');

function loadQuarantine(): string[] {
  if (!existsSync(quarantineFile)) return [];
  const raw = readFileSync(quarantineFile, 'utf-8');
  const parsed = JSON.parse(raw) as { entries?: QuarantineEntry[] };
  const now = Date.now();
  const active: string[] = [];
  for (const entry of parsed.entries ?? []) {
    const expires = Date.parse(entry.expires);
    if (Number.isNaN(expires)) {
      // Malformed entry: fail closed by keeping the spec running.
      continue;
    }
    if (expires > now) {
      active.push(entry.spec);
    }
  }
  return active;
}

const quarantinedGlobs = loadQuarantine();

export default defineConfig({
  /* A11y job runs only the axe/keyboard specs under e2e/a11y. */
  testDir: isA11yRun ? './e2e/a11y' : './e2e',
  /* Quarantined specs are skipped until their tracking entry expires. */
  testIgnore: isA11yRun ? [] : quarantinedGlobs,
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only. One retry keeps the gate fast while absorbing flukes. */
  retries: process.env.CI ? 1 : 0,
  /* Parallelism is handled by sharding across runners; keep each runner single-worker. */
  workers: process.env.CI ? 1 : undefined,
  /* Test timeout */
  timeout: 30000,
  /* Snapshots must be platform-agnostic: baselines generated on any OS must
   * match on the Linux II runner. Font differences are tolerated by
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
        ['junit', { outputFile: 'test-results-a11y/jwnit.xml' }],
        ...(process.env.CI ? [['github']] : []),
      ]
    : [
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['json', { outputFile: 'test-results/results.json' }],
        ['junit', { outputFile: 'test-results/jwnit.xml' }],
        ...(process.env.CI ? [['github']] : []),
      ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://localhost:3077',
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'oon-first-retry',
    /* Screenshot on failure */
    screenshot: 'only-on-failure',
    /* Video on failure so replay failures are diagnosable from the artifact. */
    video: 'retain-on-failure',
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
