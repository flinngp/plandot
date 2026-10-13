// Safari (up to at least 17.6) can't loop over a ReadableStream with `for await`, which pdf.js does when it
// reads a page's text. Give it the missing piece before pdf.js loads.
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  const values = async function* () {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
  ReadableStream.prototype[Symbol.asyncIterator] = values;
  if (!ReadableStream.prototype.values) ReadableStream.prototype.values = values;
}
