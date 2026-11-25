import { Problems } from '../errors/problem-details.exception';

export function formatEtag(version: number): string {
  return `"v${version}"`;
}

export function parseIfMatchVersion(ifMatchHeader: string | undefined): number {
  if (!ifMatchHeader || ifMatchHeader.trim().length === 0) {
    throw Problems.preconditionRequired(
      'Conditional update requires an If-Match header containing the current resource ETag (e.g. "v1").',
      'IF_MATCH_REQUIRED',
    );
  }

  const trimmed = ifMatchHeader.trim().replace(/^W\//i, '');
  const match = /^"?v(\d+)"?$/.exec(trimmed);
  if (!match) {
    throw Problems.badRequest(
      `Malformed If-Match header '${ifMatchHeader}'. Expected format "v<integer>".`,
      'MALFORMED_IF_MATCH',
    );
  }

  const version = Number.parseInt(match[1], 10);
  if (!Number.isInteger(version) || version < 1) {
    throw Problems.badRequest(
      `Invalid version in If-Match header '${ifMatchHeader}'.`,
      'MALFORMED_IF_MATCH',
    );
  }

  return version;
}

export function assertExpectedVersion(expectedVersion: number, currentVersion: number): void {
  if (expectedVersion !== currentVersion) {
    throw Problems.preconditionFailed(
      `Resource version conflict: If-Match specified v${expectedVersion}, but current version is v${currentVersion}.`,
      'ETAG_MISMATCH',
    );
  }
}
