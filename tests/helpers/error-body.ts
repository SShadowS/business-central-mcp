/** The error body of an MCP isError tool result: it rides only in content text (no structuredContent). */
export interface ErrorBodyView {
  error: { code: string; category: string; message: string; retryable: boolean; details: Record<string, unknown> };
  nextSteps: string[];
}

export function errorBody(result: unknown): ErrorBodyView {
  const r = result as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: unknown };
  if (!r.isError) throw new Error('errorBody: result is not an error');
  if (r.structuredContent !== undefined) throw new Error('errorBody: error result must not carry structuredContent');
  return JSON.parse(r.content[0].text) as ErrorBodyView;
}
