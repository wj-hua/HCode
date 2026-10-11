// Ship the small macOS compatibility shim; runtime never compiles code or requires Xcode.
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'darwin') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(`${root}/out/native`, {recursive:true});
  execFileSync('/usr/bin/xcrun', ['clang','-dynamiclib','-O2','-Wall','-Wextra','-Werror','-arch','arm64','-arch','x86_64','native/validation-fork-only.c','-o','out/native/validation-fork-only.dylib'], {cwd:root,stdio:'inherit'});
}
