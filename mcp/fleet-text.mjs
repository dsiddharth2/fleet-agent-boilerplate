export function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const response = result.structuredContent?.response;
  if (typeof response === 'string' && response.length > 0) return response;
  const parts = result.content ?? [];
  if (parts.length > 0) {
    return parts.map((part) => part.text ?? '').join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
