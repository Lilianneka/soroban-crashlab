import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface QuarantineEntry {
  spec: string;
  reason: string;
  expires: string;
}

/**
 * Load the quarantine list. A spec listed here is skipped (with a tracking
 * entry) until its auto-expiry date, after which it fails loudly so the
 * quarantine cannot silently rot.
 */
function loadQuarantine(): QuarantineEntry[] {
  try {
    const raw = readFileSync(join(__dirname, 'quarantine.json'), 'utf8');
    const parsed = JSON.parse(raw) as { quarantined?: QuarantineEntry[] };
    return parsed.quarantined ?? [];
  } catch {
    return [];
  }
}

const quarantine = loadQuarantine();

function quarantineFor(title: string): QuarantineEntry | undefined {
  return quarantine.find((entry) => title.includes(entry.spec));
}

const ONBOARDING_WIZARD_COMPLETE_KEY = 'crashlab:onboarding-wizard-complete:v1';
const TOUR_DISMISSED_KEY = 'crashlab:product-tour-dismissed:v1';

/**
 * Dismiss the first-visit onboarding wizard and the guided product tour so they
 * do not intercept clicks in existing e-2e specs. Specs that intentionally
 * exercise the wizard/tour override these keys via their own init scripts.
 */
export const test = base.extend({
  page: async ({ page }, runWithPage) => {
    await page.addInitScript(([wizardKey, tourKey]) => {
      localStorage.setItem(wizardKey, 'true');
      localStorage.setItem(tourKey, 'true');
    }, [ONBOARDING_WIZARD_COMPLETE_KEY, TOUR_DISMISSED_KEY] as const);
    await runWithPage(page);
  },
});

/**
 * Wrap `test` so quarantined specs skip with a visible tracking entry and
 * auto-expire. Expired entries throw so the quarantine list stays honest.
 */
const quarantinedTest = test.extend({});

export const testWithQuarantine = Object.assign(
  (title: string, body: Parameters<typeof test>[1]) => {
    const entry = quarantineFor(title);
    if (!entry) {
      return test(title, body);
    }
    const expired = Date.parse(entry.expires) < Date.now();
    if (expired) {
      return test(title, async () => {
        throw new Error(
          `Quarantined spec "${title}" expired on ${entry.expires} (${entry.reason}). Remove it from quarantine.json.`,
        );
      });
    }
    return test.skip(title, () => {
      // Tracking entry surfaced in the report/artifact.
      // eslint-disable-next-line no-console
      console.warn(
        `[quarantine] skipping "${title}" until ${entry.expires}: ${entry.reason}`,
      );
    });
  },
  quarantinedTest,
);

export { expect };
