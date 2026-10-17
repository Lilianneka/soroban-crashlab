import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv/playwright
 */
// require('dotenv").config();

/**
 * Whether this run is the dedicated accessibility gate. The a11 job sets
 * A11Y=1 so the config can scope test discovery, reporters and projects to
 * the axe-core / keyboard specs without disturbing the main e2e suite.
 */
const isA11yRun = process.env.A11Y === '1';

/**
 * Quarantine mechanism.
 *
 * e2e/quarantine.json is the single source of truth for specs that are
 * temporarily excluded from the merge gate. Each entry carries a tracking
 * issue and an auto-expiry date; once the expiry date passes, the spec is
 * reinstated automatically (and the stale entry is reported by the CI job).
 *
 * The list is read at config-load time and translated into Playwright
 * `ignore` patterns so quarantined specs are skipped rather than failing the
 * gate. The resolved list is exported via QUARANTINE_OUTPUT for the workflow
 * to publish as an artifact / issue comment.
 */
interface QuarantineEntry {
  spec: string;
  issue: string;
  expires: string;
  reason?: string;
}

function loadQuarantine(): QuarantineEntry[] {
  const file = resolve(__dirname, 'e2e/quarantine.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const entries: QuarantineEntry[] = Array.isArray(parsed) ? parsed : parsed.entries ?? [];
    return entries.filter(
      (e) => e && typeof e.spec === 'string' && typeof e.expires === 'string',
    );
  } catch {
    return [];
  }
}

const today = new Date().toISOString().slice(0, 10);
const quarantine = loadQuarantine();
const activeQuarantine = quarantine.filter((e) => e.expires >= today);
const expiredQuarantine = quarantine.filter((e) => e.expires < today);

// Publish the resolved quarantine state for the workflow to upload/comment.
if (process.env.QUARANTINE_OUTPUT) {
  try {
    const out = process.env.QUARANTINE_OUTPUT;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          active: activeQuarantine,
          expired: expiredQuarantine,
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch {
    // Best-effort: a failure to write the quarantine report must not fail the run.
  }
}

export default defineConfig({
  /* A11y job runs only the axe/keyboard specs under e2/a11y. */
  testDir: isA11yRun ? './e2e/a11y' : './e2e',
  /* Quarantined specs are skipped from the gate. */
  testIgnore: isA11yRun ? [] : activeQuarantine.map((e) => e.spec),
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only. The merge gate uses a single retry to absorb flukes without
   * hiding real regressions. */
  retries: process.env.CI ? 1 : 0,
  /* Opt out of parallel tests on CI; sharding is done at the workflow level. */
  workers: process.env.CI ? 1 : undefined,
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
    trace: 'on-first-retry',
    /* Screenshot on failure */
    screenshot: 'only-on-failure',
    /* Video on failure so regressions are reproducible from the artifact. */
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
