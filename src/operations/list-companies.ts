import { ok, isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import type { DataService } from '../services/data-service.js';
import type { Logger } from '../core/logger.js';

export interface ListCompaniesOutput {
  currentCompany: string;
  companies: Array<{ name: string; displayName: string }>;
}

export class ListCompaniesOperation {
  constructor(
    private readonly pageService: PageService,
    private readonly dataService: DataService,
    private readonly getCurrentCompany: () => string,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<Result<ListCompaniesOutput, ProtocolError>> {
    // Open the Companies system page (page 357)
    const openResult = await this.pageService.openPage('357');
    if (!isOk(openResult)) return openResult;

    const pageContextId = openResult.value.pageContextId;

    try {
      // Read company names from the list
      const readResult = this.dataService.readRows(pageContextId);
      if (!isOk(readResult)) return readResult;

      // Extract company names from rows
      const companies = readResult.value.map(row => {
        const cells = row.cells as Record<string, unknown>;
        // Find the cell that contains the company name
        const name = Object.values(cells).find(v => typeof v === 'string') as string ?? '';
        return { name, displayName: name };
      });

      this.logger.info(`Listed ${companies.length} companies (current: ${this.getCurrentCompany()})`);

      return ok({
        currentCompany: this.getCurrentCompany(),
        companies,
      });
    } finally {
      // Always close the page to free resources
      await this.pageService.closePage(pageContextId).catch(() => {});
    }
  }
}
