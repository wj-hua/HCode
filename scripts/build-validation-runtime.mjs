// Ship the small macOS compatibility shim; runtime never compiles code or requires Xcode.
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

if (process.platform === 'darwin') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(`${root}/out/native`, {recursive:true});
  await copyFile(`${root}/native/validation-shell.sh`, `${root}/out/native/validation-shell.sh`);
  await chmod(`${root}/out/native/validation-shell.sh`, 0o755);

  const candidateSdks = [
    '/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk',
    '/Library/Developer/CommandLineTools/SDKs/MacOSX14.4.sdk',
    '/Library/Developer/CommandLineTools/SDKs/MacOSX13.sdk',
  ];
  const env = { ...process.env };
  for (const sdk of candidateSdks) {
    if (existsSync(sdk)) {
      env.SDKROOT = sdk;
      break;
    }
  }

  execFileSync('/usr/bin/xcrun', ['clang','-dynamiclib','-O2','-Wall','-Wextra','-Werror','-arch','arm64','-arch','x86_64','native/validation-fork-only.c','-o','out/native/validation-fork-only.dylib'], {cwd:root,stdio:'inherit',env});
}
