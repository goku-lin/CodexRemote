// Store only a bounded amount of unchanged text and its rendered HTML. Growing
// replies can create many versions; neither entry count nor bytes may grow forever.
export class TextRenderCache {
  constructor({maxEntries = 128, maxBytes = 2 * 1024 * 1024} = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }

  render(text, compute) {
    const cached = this.entries.get(text);
    if (cached) {
      this.entries.delete(text);
      this.entries.set(text, cached);
      return cached.html;
    }
    const html = compute(text), bytes = 2 * (text.length + html.length);
    if (bytes > this.maxBytes || this.maxEntries < 1) return html;
    this.entries.set(text, {html, bytes});
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).bytes;
      this.entries.delete(oldest);
    }
    return html;
  }
}
