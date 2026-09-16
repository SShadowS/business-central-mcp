import { ok, err, isOk, type Result } from '../core/result.js';
import { CompanyNotFoundError, type BCError, type ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';

export interface SwitchCompanyInput {
  companyName: string;
}

export interface SwitchCompanyOutput {
  previousCompany: string;
  newCompany: string;
  invalidatedPageContextIds: string[];
}

export class SwitchCompanyOperation {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: SwitchCompanyInput): Promise<Result<SwitchCompanyOutput, BCError>> {
    const previousCompany = this.session.companyName;
    const invalidatedIds = this.repo.listPageContextIds();

    // A company switch is a re-OpenSession bound to the target company. BC binds
    // a session to a company ONLY at OpenSession time: the ChangeCompany
    // SystemAction (500) and the per-request envelope `company` are both no-ops
    // on an already-open session (verified live on cronus28 -- the old approach
    // "succeeded" via InvokeCompleted while the session stayed in the old
    // company, which is exactly why the switch never stuck).
    const result = await this.session.changeCompany(input.companyName);

    // On failure (e.g. NavWebFailedOpenCompanyException for an unknown or
    // wrong-case company) the session is still on the old company. Do NOT
    // destroy page contexts -- the caller's pages remain valid.
    if (!isOk(result)) return err(mapSwitchError(result.error, input.companyName));

    // Successful re-open resets all server-side page state to the new company;
    // every previously open page context is now stale.
    this.repo.clearAll();

    // `session.companyName` now reflects the company BC echoed back.
    const newCompany = this.session.companyName || input.companyName;

    this.logger.info(`Switched company from "${previousCompany}" to "${newCompany}"`);

    return ok({
      previousCompany,
      newCompany,
      invalidatedPageContextIds: invalidatedIds,
    });
  }
}

/**
 * Turn a re-open failure into a caller-friendly business error. BC reports an
 * unknown/wrong-case company as `NavWebFailedOpenCompanyException` ("The company
 * ... does not exist."); surface that as a VALIDATION_ERROR so it is not treated
 * as a transport failure. Any other protocol error passes through unchanged.
 */
function mapSwitchError(error: ProtocolError, companyName: string): BCError {
  const msg = error.message ?? '';
  if (/does not exist|FailedOpenCompany|Could not open the/i.test(msg)) {
    return new CompanyNotFoundError(companyName);
  }
  return error;
}
