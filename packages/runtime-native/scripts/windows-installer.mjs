import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

function compilerString(value) {
  // Character expansion prevents authored ${defines} and $%environment% from being evaluated.
  return String(value).replaceAll('$', () => '${U+24}').replaceAll('"', '$\\"')
    .replaceAll('\r', '$\\r').replaceAll('\n', '$\\n');
}

function nsis(value) {
  return compilerString(String(value).replaceAll('$', () => '$$'));
}

function quote(value) {
  return `"${compilerString(value)}"`;
}

function checkPaths(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('TN_WINDOWS_INSTALLER_EMPTY');
  const seen = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || win32.isAbsolute(file) ||
        file.split('/').some((part) => !part || part === '.' || part === '..' ||
          /[<>:"\\|?*]|[. ]$/u.test(part) || [...part].some((character) => character.charCodeAt(0) < 32) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
      throw new Error(`TN_WINDOWS_INSTALLER_PATH_INVALID: ${file}`);
    }
    const key = file.toLowerCase();
    if (seen.has(key)) throw new Error(`TN_WINDOWS_INSTALLER_PATH_COLLISION: ${file}`);
    seen.add(key);
  }
  for (const file of seen) {
    const parts = file.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join('/'))) throw new Error(`TN_WINDOWS_INSTALLER_PATH_COLLISION: ${file}`);
    }
  }
}

/** Check removal of the sealed payload; runtime-created data belongs to the player. */
export function verifyWindowsUninstall(directory, files) {
  checkPaths(files);
  for (const path of [...files.map((file) => join('game', file)), '.threenative-installer.ini']) {
    if (lstatSync(join(directory, path), { throwIfNoEntry: false }))
      throw new Error(`Uninstaller retained owned payload: ${path}`);
  }
  if (!existsSync(directory)) return [];
  // Dirents let us inventory links without traversing their targets.
  const entries = [];
  const directories = [directory];
  while (directories.length) {
    const current = directories.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const type = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      entries.push({ path: relative(directory, path).replaceAll('\\', '/'), type });
      if (type === 'directory') directories.push(path);
    }
  }
  return entries
    // NSIS cannot remove its own running executable in synchronous _?= mode; the verifier does.
    .filter((entry) => entry.path !== 'Uninstall.exe')
    .sort((a, b) => a.path.localeCompare(b.path));
}

const ensureWebView = [
  'param([Parameter(Mandatory=$true)][string]$Bootstrapper)',
  "$ErrorActionPreference = 'Stop'",
  'function HasRuntime {',
  "  foreach ($hive in @('CurrentUser', 'LocalMachine')) {",
  '    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::Registry32)',
  '    $key = $null',
  '    try {',
  "      $key = $base.OpenSubKey('SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')",
  '      $version = $null',
  "      if ($null -ne $key -and [Version]::TryParse([string]$key.GetValue('pv'), [ref]$version) -and $version.Major -gt 0) { return $true }",
  '    } finally {',
  '      if ($null -ne $key) { $key.Dispose() }',
  '      $base.Dispose()',
  '    }',
  '  }',
  '  return $false',
  '}',
  'if (HasRuntime) { exit 0 }',
  "$process = Start-Process -FilePath $Bootstrapper -ArgumentList '/silent', '/install' -Wait -PassThru",
  "if ($process.ExitCode -ne 0) { throw ('WebView2 setup failed: ' + $process.ExitCode) }",
  "if (-not (HasRuntime)) { throw 'WebView2 setup returned without installing a valid runtime.' }",
].join('\n');

/** Render only explicit owned files; the uninstaller never recursively removes an install folder. */
export function windowsInstallerScript({ root, output, manifest, files, bootstrapper, icon, signer }) {
  const { id, name, version } = manifest.app;
  if (!/^[a-z0-9][a-z0-9._-]+$/iu.test(id)) throw new Error('TN_WINDOWS_INSTALLER_APP_ID_INVALID');
  checkPaths(files);
  if (!files.includes(manifest.executable)) throw new Error('TN_WINDOWS_INSTALLER_EXECUTABLE_MISSING');
  const installed = (file) => `$INSTDIR\\game${file ? `\\${nsis(file.replaceAll('/', '\\'))}` : ''}`;
  const directories = new Set([installed('')]);
  for (const file of files) {
    const parts = file.split('/');
    for (let count = parts.length - 1; count > 0; count -= 1) {
      directories.add(installed(parts.slice(0, count).join('/')));
    }
  }
  const values = {
    NAME: nsis(name), ID: nsis(id), VERSION: nsis(version), OUTPUT: compilerString(output),
    SHORTCUT: nsis([...String(name)].map((character) => character.charCodeAt(0) < 32 ? '_' : character)
      .join('').replace(/[<>:"/\\|?*]/gu, '_').replace(/[. ]+$/u, '') || id),
    EXECUTABLE: nsis(manifest.executable.replaceAll('/', '\\')),
    REGISTRY: nsis(`Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`),
    ICON: icon ? `!define MUI_ICON ${quote(icon)}\n!define MUI_UNICON ${quote(icon)}` : '',
    SIGN_UNINSTALLER: signer ? `!uninstfinalize ${quote(signer)} = 0` : '',
    WEBVIEW: bootstrapper ? [
      '  InitPluginsDir',
      '  SetOutPath "$PLUGINSDIR"',
      `  File /oname=WebView2Setup.exe ${quote(bootstrapper)}`,
      `  File /oname=ensure-webview.ps1 ${quote(join(dirname(output), 'ensure-webview.ps1'))}`,
      '  ExecWait \'"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\\ensure-webview.ps1" -Bootstrapper "$PLUGINSDIR\\WebView2Setup.exe"\' $0',
      '  IfErrors webviewFailed',
      '  StrCmp $0 0 webviewReady webviewFailed',
      'webviewFailed:',
      '  MessageBox MB_OK|MB_ICONSTOP "Microsoft WebView2 could not be installed. Check your internet connection and run setup again." /SD IDOK',
      '  SetErrorLevel 1',
      '  Abort',
      'webviewReady:',
    ].join('\n') : '',
    INSTALL_FILES: files.map((file) => [
      `  SetOutPath "${installed(file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')}"`,
      `  File "/oname=${nsis(file.split('/').at(-1))}" ${quote(join(root, file))}`,
      '  IfErrors failed',
    ].join('\n')).join('\n'),
    DELETE_FILES: files.map((file) => `  Delete "${installed(file)}"`).join('\n'),
    DELETE_DIRECTORIES: [...directories].sort((a, b) => b.length - a.length)
      .map((directory) => `  RMDir "${directory}"`).join('\n'),
  };
  return readFileSync(new URL('./windows-installer.nsi', import.meta.url), 'utf8')
    .replace(/@TN_([A-Z_]+)@/gu, (_match, key) => {
      if (!Object.hasOwn(values, key)) throw new Error(`Unknown installer template field: ${key}`);
      return values[key];
    });
}

export function buildWindowsInstaller({ root, output, manifest, files, icon, run, signing }) {
  const directory = dirname(output);
  let bootstrapper;
  if (manifest.ui) {
    bootstrapper = join(directory, 'WebView2Setup.exe');
    const script = join(directory, 'download-webview.ps1');
    writeFileSync(script, [
      "$ErrorActionPreference = 'Stop'",
      "Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $env:TN_WEBVIEW_BOOTSTRAPPER_OUTPUT",
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:TN_WEBVIEW_BOOTSTRAPPER_OUTPUT',
      "if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )CN=Microsoft Corporation(,|$)') { throw 'WebView2 bootstrapper does not have a valid Microsoft signature.' }",
    ].join('\n'));
    const download = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      env: { ...process.env, TN_WEBVIEW_BOOTSTRAPPER_OUTPUT: bootstrapper },
    });
    if (download.error || download.status !== 0 || !existsSync(bootstrapper)) {
      throw new Error(`TN_WEBVIEW2_BOOTSTRAPPER_FAILED: ${download.error?.message || download.stderr || 'download or Microsoft signature verification failed'}`);
    }
    writeFileSync(join(directory, 'ensure-webview.ps1'), ensureWebView);
  }
  let signer;
  if (signing) {
    const helper = join(directory, 'sign-uninstaller.mjs');
    const moduleUrl = pathToFileURL(join(import.meta.dirname, 'desktop-distribution.mjs')).href;
    writeFileSync(helper, `import { signDesktopArtifact } from ${JSON.stringify(moduleUrl)};\nsignDesktopArtifact({ platform: 'win32', signing: JSON.parse(process.env.TN_WINDOWS_INSTALLER_SIGNING), target: process.argv[2] });\n`);
    signer = `"${process.execPath}" "${helper}" "%1"`;
  }
  const script = join(directory, 'installer.nsi');
  writeFileSync(script, windowsInstallerScript({ root, output, manifest, files, bootstrapper, icon, signer }));
  const options = {
    cwd: directory,
    env: { ...process.env, ...(signing ? { TN_WINDOWS_INSTALLER_SIGNING: JSON.stringify(signing) } : {}) },
  };
  let result = run('makensis', ['-V2', script], options);
  if (result.error?.code === 'ENOENT' && process.platform === 'win32') {
    const installedCompiler = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
      .map((directory) => join(directory, 'NSIS', 'makensis.exe')).find(existsSync);
    if (installedCompiler) result = run(installedCompiler, ['-V2', script], options);
  }
  if (result.error || result.status !== 0 || !existsSync(output) ||
      readFileSync(output).subarray(0, 2).toString() !== 'MZ') {
    throw new Error(`TN_WINDOWS_INSTALLER_FAILED: ${result.error?.message || result.stderr || 'makensis did not produce a Windows installer'}; install NSIS and ensure makensis is on PATH.`);
  }
  return output;
}
