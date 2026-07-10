import { ok, err, isOk, type Result } from '../core/result.js';
import type { BCError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { classifyBusinessError } from '../protocol/error-classifier.js';
import type { BCEvent } from '../protocol/types.js';
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

    const events = result.value;

    // BC may reject the switch (e.g. no permission, unknown company) via an
    // error message/dialog while still completing the invoke. Do NOT destroy
    // page contexts in that case -- the session is still in the old company.
    const bizErr = classifyBusinessError(events);
    if (bizErr !== null) return err(bizErr);

    // Invalidate all page contexts -- company switch resets server-side page state
    this.repo.clearAll();

    // Prefer the confirmed company name from the settings-changed event when
    // BC echoes one back; fall back to the requested name otherwise.
    const newCompany = extractConfirmedCompanyName(events) ?? input.companyName;

    this.logger.info(`Switched company from "${previousCompany}" to "${newCompany}"`);

    return ok({
      previousCompany,
      newCompany,
      invalidatedPageContextIds: invalidatedIds,
    });
  }
}

/**
 * Find the confirmed new company name in the events returned by the
 * ChangeCompany invoke (SessionSettingsChangedHandler / session-info payloads
 * carry a CompanyName field). Returns undefined when BC did not echo one.
 */
function extractConfirmedCompanyName(events: BCEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'SessionInfo') continue;
    const found = findCompanyName(event.sessionData);
    if (found) return found;
  }
  return undefined;
}

function findCompanyName(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findCompanyName(item);
      if (found) return found;
    }
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.CompanyName === 'string' && obj.CompanyName) return obj.CompanyName;
  for (const value of Object.values(obj)) {
    const found = findCompanyName(value);
    if (found) return found;
  }
  return undefined;
}
