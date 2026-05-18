/**
 * Error codes used in the upload/validate/unpack/index pipeline (spec §13.1).
 * Matches what the server reports back to the client; web shows them verbatim.
 */

export const ERROR_CODES = {
  EUNZIP: 'EUNZIP',
  ENOMANIFEST: 'ENOMANIFEST',
  EBADSCHEMA: 'EBADSCHEMA',
  EBADMANIFEST: 'EBADMANIFEST',
  EZIPSLIP: 'EZIPSLIP',
  EBOMB: 'EBOMB',
  ETOOLARGE: 'ETOOLARGE',
  EMISSINGFILE: 'EMISSINGFILE',
  EINTERNAL: 'EINTERNAL',
  ERATELIMIT: 'ERATELIMIT',
  /**
   * Self-service registration is disabled by `AUTH_ALLOW_REGISTRATION=false`
   * and the `User` table is non-empty (i.e. bootstrap exception does not
   * apply). Returned by `POST /api/auth/register` and by OAuth callbacks that
   * would otherwise mint a fresh user. HTTP 403.
   */
  EREGCLOSED: 'EREGCLOSED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class SlideStageError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'SlideStageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
