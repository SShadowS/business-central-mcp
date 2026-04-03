import { z } from 'zod';

// MCP delivers params as strings or typed values — coerce everything
const StringOrNumber = z.union([z.string(), z.number()]).transform(v => String(v).trim());

export const OpenPageSchema = z.object({
  pageId: StringOrNumber,
  bookmark: z.string().optional(),
  tenantId: z.string().optional(),
});

export const ReadDataSchema = z.object({
  pageContextId: z.string().min(1),
  filters: z.array(z.object({ column: z.string(), value: z.string() })).optional(),
  columns: z.array(z.string()).optional(),
});

export const WriteDataSchema = z.object({
  pageContextId: z.string().min(1),
  fields: z.record(z.string(), z.string()),
});

export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1),
  action: z.string().min(1),
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
  action: z.enum(['drill_down', 'select']).optional(),
});
