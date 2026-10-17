/** Heuristic normalization. Only the label is exported, never the original key. */
export function normalizeKey(key: string): string {
  return key
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*')
    .replace(/[0-9a-f]{16,}/gi, '*')
    .replace(/[^:/.\s]{24,}/g, '*')
    .replace(/\d+/g, '*');
}

export class PatternRegistry {
  private readonly patterns = new Set<string>();
  constructor(private readonly max: number, private readonly normalize = normalizeKey) {}
  label(key: string): string {
    const pattern = this.normalize(key);
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 200) {
      throw new Error('Invalid normalized pattern');
    }
    if (this.patterns.has(pattern)) return pattern;
    if (this.patterns.size >= this.max) return '__other__';
    this.patterns.add(pattern);
    return pattern;
  }
}
