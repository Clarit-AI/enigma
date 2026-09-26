// Issue #90. "Is this module the process entrypoint?" — true when the file Node
// was asked to run is this very file.
//
// The obvious spelling is wrong in a way that matters here:
//
//     import.meta.url === new URL(process.argv[1], 'file:').href
//
// `import.meta.url` is the module's *resolved* location, but `process.argv[1]`
// is the path the user typed. Those differ whenever one of them is a symlink —
// and a symlink is exactly how the CLI is invoked once it is on PATH, and
// exactly how npm's `bin` shim invokes it. Under that spelling `enigma doctor`
// through a PATH symlink runs `main()`, gets no argument list, and exits 0
// having printed nothing: a silent no-op that looks like success.
//
// `/tmp` is the other everyday case — it is a symlink to `/private/tmp` on
// macOS, so even a literal absolute path disagrees with the resolved one.
//
// Comparing realpaths on both sides makes the check agree with what the shell
// actually did. `realpathSync` throws when a path does not exist, which is
// itself a legitimate answer (not the entrypoint), so it is caught rather than
// propagated: this runs at module scope and must not take the process down.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(metaUrl: string = import.meta.url, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
