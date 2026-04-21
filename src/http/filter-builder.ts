// src/http/filter-builder.ts
//
// Build OData $filter clauses for Outlook v2.0 API queries.
// Used by list-mail's --since/--until flags to scope server-side filtering.

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function validateIso(label: string, value: string): void {
  if (!ISO_8601_RE.test(value)) {
    throw new FilterError(
      `--${label} must be an ISO-8601 UTC timestamp (e.g. 2026-04-22T07:00:00Z), got "${value}"`,
    );
  }
}

export function buildReceivedDateFilter(
  since: string | undefined,
  until: string | undefined,
): string {
  if (since !== undefined) validateIso('since', since);
  if (until !== undefined) validateIso('until', until);

  if (since !== undefined && until !== undefined) {
    if (since >= until) {
      throw new FilterError(`--since (${since}) must be earlier than --until (${until})`);
    }
    return `ReceivedDateTime ge ${since} and ReceivedDateTime lt ${until}`;
  }
  if (since !== undefined) return `ReceivedDateTime ge ${since}`;
  if (until !== undefined) return `ReceivedDateTime lt ${until}`;
  return '';
}
