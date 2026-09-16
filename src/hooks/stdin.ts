/** Reads and parses the hook JSON Claude Code writes to this process's stdin. */
export function readStdinJson<T>(): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      if (data.length === 0) {
        resolvePromise({} as T);
        return;
      }
      try {
        resolvePromise(JSON.parse(data) as T);
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on('error', reject);
  });
}
