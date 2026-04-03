import { z } from 'zod';

// MCP delivers params as strings or typed values — coerce everything.
// Note: .transform() breaks z.toJSONSchema(), so we keep a separate
// JSON-schema-safe version (StringOrNumberInput) for schema generation.
const StringOrNumber = z.union([z.string(), z.number()]).transform(v => String(v).trim());
const StringOrNumberInput = z.union([z.string(), z.number()]);

export const OpenPageSchema = z.object({
  pageId: StringOrNumber,
  bookmark: z.string().optional(),
  tenantId: z.string().optional(),
});

export const ReadDataSchema = z.object({
  pageContextId: z.string().min(1),
  section: z.string().optional(),
  tab: z.string().optional(),
  filters: z.array(z.object({ column: z.string(), value: z.string() })).optional(),
  columns: z.array(z.string()).optional(),
  range: z.object({ offset: z.number(), limit: z.number() }).optional(),
});

export const WriteDataSchema = z.object({
  pageContextId: z.string().min(1),
  fields: z.record(z.string(), z.string()),
  section: z.string().optional(),
  rowIndex: z.number().optional(),
  bookmark: z.string().optional(),
});

export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1),
  action: z.string().min(1),
  section: z.string().optional(),
  rowIndex: z.number().optional(),
  bookmark: z.string().optional(),
});

export const ClosePageSchema = z.object({
  pageContextId: z.string().min(1),
});

export const SearchPagesSchema = z.object({
  query: z.string().min(1),
});

export const NavigateSchema = z.object({
  pageContextId: z.string().min(1),
  bookmark: z.string().min(1),
  action: z.enum(['drill_down', 'select', 'lookup']).optional(),
  section: z.string().optional(),
  field: z.string().optional(),
});

export const RespondDialogSchema = z.object({
  pageContextId: z.string().min(1),
  dialogFormId: z.string().min(1),
  response: z.enum(['ok', 'cancel', 'yes', 'no', 'abort', 'close']),
});

/**
 * Generate MCP-compatible JSON schema from a Zod schema.
 * Handles the OpenPageSchema specially since it uses .transform() which
 * z.toJSONSchema() cannot represent. All other schemas pass through directly.
 */
export function toMcpJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // OpenPageSchema uses StringOrNumber with .transform() — use the safe variant
  if (schema === OpenPageSchema) {
    const safe = z.object({
      pageId: StringOrNumberInput,
      bookmark: z.string().optional(),
      tenantId: z.string().optional(),
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
