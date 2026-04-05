import { ok, isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
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

  async execute(input: SwitchCompanyInput): Promise<Result<SwitchCompanyOutput, ProtocolError>> {
    const previousCompany = this.session.companyName;
    const invalidatedIds = this.repo.listPageContextIds();

    // ChangeCompany uses InvokeSessionAction with systemAction 500
    const result = await this.session.invoke(
      {
        type: 'SessionAction',
        actionName: 'InvokeSessionAction',
        namedParameters: {
          systemAction: 500,
          company: input.companyName,
        },
      },
      (e) => e.type === 'InvokeCompleted',
    );

    if (!isOk(result)) return result;

    // Invalidate all page contexts -- company switch resets server-side page state
    this.repo.clearAll();

    this.logger.info(`Switched company from "${previousCompany}" to "${input.companyName}"`);

    return ok({
      previousCompany,
      newCompany: input.companyName,
      invalidatedPageContextIds: invalidatedIds,
    });
  }
}
