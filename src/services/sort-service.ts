// src/services/sort-service.ts
//
// Sorts a list-page repeater by a named column via the BC SortColumn
// interaction (SystemAction 470). The rcc (RepeaterColumnHeader) node for
// the column is resolved by caption match, same pattern as FilterService.
//
// Reference: SortColumnAction.cs, SortOrder.cs, ClientSortOrder.cs
// (decompiled Microsoft.Dynamics.Framework.UI / BC28).

import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type { SortColumnInteraction } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import type { Logger } from '../core/logger.js';

export type SortDirection = 'asc' | 'desc';

export class SortService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Sort the repeater of `sectionId` by `columnName` in the given direction.
   *
   * Resolves the rcc node by case-insensitive caption match over
   * `repeater.columns`. Returns a ProtocolError if the column is not found
   * (with `availableColumns` in context) or if BC rejects the sort invoke.
   *
   * A successful sort triggers a DataLoaded event that resets the BC viewport
   * to the top of the sorted result set. The caller should re-materialize
   * scroll ranges after calling this.
   */
  async applySort(
    pageContextId: string,
    columnName: string,
    direction: SortDirection,
    sectionId?: string,
  ): Promise<Result<PageContext, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater -- cannot sort'));

    // Resolve the rcc column node by caption (case-insensitive), same as FilterService.
    const column = resolved.repeater.columns.find(c =>
      (c.properties.caption ?? '').toLowerCase() === columnName.toLowerCase()
    );
    if (!column) {
      return err(new ProtocolError(`Sort column not found: ${columnName}`, {
        availableColumns: resolved.repeater.columns.map(c => c.properties.caption ?? '').filter(Boolean),
      }));
    }

    // SortOrder enum: Ascending=1, Descending=2
    // Reference: Microsoft.Dynamics.Framework.UI.SortOrder (decompiled BC28).
    const sortOrder: 1 | 2 = direction === 'asc' ? 1 : 2;

    const interaction: SortColumnInteraction = {
      type: 'SortColumn',
      formId: resolved.form.formId,
      controlPath: column.controlPath,
      sortOrder,
    };

    this.logger.info(`[Sort] SortColumn on ${column.controlPath} (column="${columnName}", direction=${direction}, sortOrder=${sortOrder})`);

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    );
    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);

    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return err(new ProtocolError('State lost after sort'));
    this.logger.info(`[Sort] Sort applied: ${columnName} ${direction}`);
    return ok(updatedCtx);
  }
}
