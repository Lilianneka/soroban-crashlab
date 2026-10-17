/**
 * Failure classification taxonomy (#1121).
 *
 * Groups failed runs by the crash category the backend reports, and attaches a
 * definition to each category so the dashboard can explain what a category
 * means and where to start triaging it. Categories roll up into families, which
 * gives the taxonomy two levels: family → category → run.
 *
 * Signature schema versioning (W5-F08): taxonomy leaves and masked fields are
 * part of the signature preimage, so any change here silently re-buckets every
 * historical signature. The schema version is explicit, embedded in the signature
 * hash input, and changes are governed: additive leafs bump the minor version,
 * preimage changes bump the major version and require a migration report.
 *
 * DOM-free so it can be unit-tested with plain Node.
 */

import type { FuzzingRun, RunArea, RunSeverity } from '../../types';

/** Broad grouping a failure category belongs to. */
export type FailureFamily = 'correctness' | 'resource' | 'authorization' | 'encoding' | 'other';

export const FAILURE_FAMILY_LABELS: Record<FailureFamily, string> = {
    correctness: 'Correctness',
    resource: 'Resource limits',
    authorization: 'Authorization',
    encoding: 'Encoding',
    other: 'Unclassified',
};

/**
 * Schema version of the signature preimage. This value is part of the
 * signature hash input, and is stored alongside every signature in fixtures and
 * baselines. It must never be changed without a migration report (W5-F08 diff)
 * and maintainer sign-off; see `docs/taxonomy.md`.
 *
 * - Minor bump: additive leafs only (new categories), no preimage change.
 * - Major bump: preimage change (masked fields, leaf renames/removals), requires
 *   re-bucketing of historical signatures and a recurring → new mapping table.
 */
export interface SignatureSchemaVersion {
    /** Major version: bumps on preimage changes. */
    major: number;
    /** Minor version: bumps on additive taxonomy leaves. */
    minor: number;
}

/** Current signature schema version enforced by the regression suite. */
export const SIGNATURE_SCHEMA_VERSION: SignatureSchemaVersion = {
    major: 1,
    minor: 0,
};

/** Canonical string representation embedded in the signature hash input. */
export const SIGNATURE_SCHEMA_VERSION_STRING = `v${SIGNATURE_SCHEMA_VERSION.major}.${SIGNATURE_SCHEMA_VERSION.minor}`;

/** The version string that was current before the first migration. */
export const SIGNATURE_SCHEMA_VERSION_PREVIOUS = '0.0';

/** Error thrown when a signature was computed under a different schema version. */
export class SignatureSchemaMismatchError extends Error {
    readonly foundVersion: string;
    readonly expectedVersion: string;

    constructor(foundVersion: string, expectedVersion: string = SIGNATURE_SCHEMA_VERSION_STRING) {
        super(`Signature schema version mismatch: found ${foundVersion}, expected ${expectedVersion}. ` +
            'Run the signature migration tool (W5-F08) to recompute baselines and ' +
            'attach the recurring→new diff report before comparing signatures.');
        this.name = 'SignatureSchemaMismatchError';
        this.foundVersion = foundVersion;
        this.expectedVersion = expectedVersion;
    }
}

/** Throws a {@link SignatureSchemaMismatchError} when the version is stale. */
export function assertSignatureSchemaVersion(version: string): void {
    if (version !== SIGNATURE_SCHEMA_VERSION_STRING) {
        throw new SignatureSchemaMismatchError(version);
    }
}

/** What a category means and how to approach it. */
export interface FailureCategoryDefinition {
    /** Raw category string as emitted by the backend crash index. */
    category: string;
    /** Human-readable name shown in the UI. */
    label: string;
    family: FailureFamily;
    description: string;
    /** First thing a triager should check. */
    triageHint: string;
    /** Schema version this leaf was introduced under. */
    introducedIn: string;
}

/**
 * Known categories. Anything the backend reports that is not listed here still
 * appears in the UI, via {@link classifyFailureCategory}, under the `other`
 * family — an unrecognised category must never be silently dropped.
 *
 * Adding a leaf is additive: bump the minor schema version and set `introducedIn`
 * to the new version string. Renaming or removing a leaf is a major bump.
 */
export const FAILURE_TAXONOMY: readonly FailureCategoryDefinition[] = [
    {
        category: 'Panic',
        label: 'Panic',
        family: 'correctness',
        description: 'The contract aborted — an unwrap, an explicit panic, or an arithmetic overflow.',
        triageHint: 'Replay the seed and read the last frame before the abort.',
        introducedIn: '1.0',
    },
    {
        category: 'InvariantViolation',
        label: 'Invariant violation',
        family: 'correctness',
        description: 'An invariant that the contract is supposed to uphold no longer holds after execution.',
        triageHint: 'Compare the ledger state diff before and after the failing call.',
        introducedIn: '1.0',
    },
    {
        category: 'BudgetExceeded',
        label: 'Budget exceeded',
        family: 'resource',
        description: 'The run ran past its CPU instruction or memory budget.',
        triageHint: 'Check the resource fee panel for which limit was hit first.',
        introducedIn: '1.0',
    },
    {
        category: 'Timeout',
        label: 'Timeout',
        family: 'resource',
        description: 'The run did not reach a terminal state inside its time limit.',
        triageHint: 'Look for unbounded loops over attacker-controlled input.',
        introducedIn: '1.0',
    },
    {
        category: 'AuthFailure',
        label: 'Authorization failure',
        family: 'authorization',
        description: 'A call was rejected, or wrongly accepted, by the authorization checks.',
        triageHint: 'Confirm which signer the harness used and what the contract required.',
        introducedIn: '1.0',
    },
    {
        category: 'XdrDecodeError',
        label: 'XDR decode error',
        family: 'encoding',
        description: 'A payload could not be decoded into the expected XDR structure.',
        triageHint: 'Inspect the raw payload in the crash trace for truncation.',
        introducedIn: '1.0',
    },
];

const TAXONOMY_BY_CATEGORY = new Map(
    FAILURE_TAXONOMY.map((definition) => [definition.category, definition]),
);

/**
 * Looks up a category definition, synthesising one for categories this build
 * does not know about so new backend categories still render.
 */
export function classifyFailureCategory(category: string): FailureCategoryDefinition {
    const known = TAXONOMY_BY_CATEGORY.get(category);
    if (known) return known;

    return {
        category,
        label: category,
        family: 'other',
        description: 'No taxonomy entry for this category yet.',
        triageHint: 'Triage manually, then add it to FAILURE_TAXONOMY under a minor schema bump.',
        introducedIn: SIGNATURE_SCHEMA_VERSION_STRING,
    };
}

/** Most severe first — the order severities are listed and compared in. */
export const SEVERITY_ORDER: readonly RunSeverity[] = ['critical', 'high', 'medium', 'low'];

function severityRank(level: RunSeverity): number {
    return SEVERITY_ORDER.indexOf(level);
}

/** Returns the runs the taxonomy covers: failed runs that carry crash detail. */
export function getClassifiedRuns(runs: readonly FuzzingRun[]): FuzzingRun[] {
    return runs.filter((run) => run.status === 'failed' && run.crashDetail !== null);
}

/** Everything the UI needs to render one category row. */
export interface CategoryBreakdown {
    definition: FailureCategoryDefinition;
    /** Number of failed runs in this category. */
    count: number;
    runIds: string[];
    /** Distinct crash signatures seen, in first-seen order. */
    signatures: string[];
    /** Distinct areas affected, alphabetical. */
    areas: RunArea[];
    /** Distinct severities seen, most severe first. */
    severities: RunSeverity[];
    /** Highest severity observed in this category. */
    topSeverity: RunSeverity;
    /** Fraction of all classified failures, 0–1. */
    share: number;
    /** Signature schema version the signatures were computed under. */
    schemaVersion: string;
}

/**
 * Builds one breakdown per observed category, ordered by count (descending)
 * then label, so the biggest problem is always first.
 */
export function buildCategoryBreakdown(runs: readonly FuzzingRun[]): CategoryBreakdown[] {
    const classified = getClassifiedRuns(runs);
    const buckets = new Map<string, { runs: FuzzingRun[]; signatures: string[] }>();

    for (const run of classified) {
        const category = run.crashDetail!['failureCategory'];
        let bucket = buckets.get(category);
        if (!bucket) {
            bucket = { runs: [], signatures: [] };
            buckets.set(category, bucket);
        }
        bucket.runs.push(run);
        const signature = run.crashDetail!.signature;
        if (signature && !bucket.signatures.includes(signature)) {
            bucket.signatures.push(signature);
        }
    }

    const total = classified.length;
    const breakdowns: CategoryBreakdown[] = [];

    for (const [category, bucket] of buckets) {
        const definition = classifyFailureCategory(category);
        const areas = Array.from(new Set(bucket.runs.map((run) => run.area))).sort();
        const severities = Array.from(new Set(bucket.runs.map((run) => run.severity))).sort(
            (a, b) => severityRank(a) - severityRank(b),
        );

        breakdowns.push({
            definition,
            count: bucket.runs.length,
            runIds: bucket.runs.map((run) => run.id),
            signatures: bucket.signatures,
            areas,
            severities,
            topSeverity: severities[0],
            share: total > 0 ? bucket.runs.length / total : 0,
            schemaVersion: SIGNATURE_SCHEMA_VERSION_STRING,
        });
    }

    breakdowns.sort(
        (a, b) => b.count - a.count || a.definition.label.localeCompare(b.definition.label),
    );

    return breakdowns;
}
