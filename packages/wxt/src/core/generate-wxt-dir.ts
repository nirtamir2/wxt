import { Entrypoint, WxtDirEntry, WxtDirFileEntry } from '../types';
import fs from 'fs-extra';
import { dirname, relative, resolve } from 'node:path';
import { getEntrypointBundlePath, isHtmlEntrypoint } from './utils/entrypoints';
import { getEntrypointGlobals, getGlobals } from './utils/globals';
import { normalizePath } from './utils/paths';
import path from 'node:path';
import { Message, parseI18nMessages } from './utils/i18n';
import { writeFileIfDifferent, getPublicFiles } from './utils/fs';
import { wxt } from './wxt';

/**
 * Generate and write all the files inside the `InternalConfig.typesDir` directory.
 */
export async function generateWxtDir(entrypoints: Entrypoint[]): Promise<void> {
  await fs.ensureDir(wxt.config.typesDir);

  const entries: WxtDirEntry[] = [
    // Hard-coded entries
    { module: 'wxt/vite-builder-env' },
  ];

  // Add references to modules installed from NPM to the TS project so their
  // type augmentation can update InlineConfig correctly. Local modules defined
  // in <root>/modules are already apart of the project, so we don't need to
  // add them.
  wxt.config.userModules.forEach((module) => {
    if (module.type === 'node_module') entries.push({ module: module.id });
  });

  // browser.runtime.getURL
  entries.push(await getPathsDeclarationEntry(entrypoints));

  // browser.i18n.getMessage
  entries.push(await getI18nDeclarationEntry());

  // import.meta.env.*
  entries.push(await getGlobalsDeclarationEntry());

  // @types/chrome
  if (wxt.config.extensionApi === 'chrome') {
    entries.push({ module: '@types/chrome' });
  }

  // tsconfig.json
  entries.push(await getTsConfigEntry());

  // Let modules add more entries
  await wxt.hooks.callHook('prepare:types', wxt, entries);

  // Add main declaration file, not editable
  entries.push(getMainDeclarationEntry(entries));

  // Write all the files
  const absoluteFileEntries = (
    entries.filter((entry) => 'path' in entry) as WxtDirFileEntry[]
  ).map<WxtDirFileEntry>((entry) => ({
    ...entry,
    path: resolve(wxt.config.wxtDir, entry.path),
  }));

  await Promise.all(
    absoluteFileEntries.map(async (file) => {
      await fs.ensureDir(dirname(file.path));
      await writeFileIfDifferent(file.path, file.text);
    }),
  );
}

async function getPathsDeclarationEntry(
  entrypoints: Entrypoint[],
): Promise<WxtDirFileEntry> {
  const paths = entrypoints
    .map((entry) =>
      getEntrypointBundlePath(
        entry,
        wxt.config.outDir,
        isHtmlEntrypoint(entry) ? '.html' : '.js',
      ),
    )
    .concat(await getPublicFiles());

  await wxt.hooks.callHook('prepare:publicPaths', wxt, paths);

  const unions = paths
    .map(normalizePath)
    .sort()
    .map((path) => `    | "/${path}"`)
    .join('\n');

  const template = `// Generated by wxt
import "wxt/browser";

declare module "wxt/browser" {
  export type PublicPath =
{{ union }}
  type HtmlPublicPath = Extract<PublicPath, \`\${string}.html\`>
  export interface WxtRuntime {
    getURL(path: PublicPath): string;
    getURL(path: \`\${HtmlPublicPath}\${string}\`): string;
  }
}
`;

  return {
    path: 'types/paths.d.ts',
    text: template.replace('{{ union }}', unions || '    | never'),
    tsReference: true,
  };
}

async function getI18nDeclarationEntry(): Promise<WxtDirFileEntry> {
  const defaultLocale = wxt.config.manifest.default_locale;
  const template = `// Generated by wxt
import "wxt/browser";

declare module "wxt/browser" {
  /**
   * See https://developer.chrome.com/docs/extensions/reference/i18n/#method-getMessage
   */
  interface GetMessageOptions {
    /**
     * See https://developer.chrome.com/docs/extensions/reference/i18n/#method-getMessage
     */
    escapeLt?: boolean
  }

  export interface WxtI18n extends I18n.Static {
{{ overrides }}
  }
}
`;

  const defaultLocalePath = path.resolve(
    wxt.config.publicDir,
    '_locales',
    defaultLocale ?? '',
    'messages.json',
  );
  let messages: Message[];
  if (await fs.exists(defaultLocalePath)) {
    const content = JSON.parse(await fs.readFile(defaultLocalePath, 'utf-8'));
    messages = parseI18nMessages(content);
  } else {
    messages = parseI18nMessages({});
  }

  const renderGetMessageOverload = (
    keyType: string,
    description?: string,
    translation?: string,
  ) => {
    const commentLines: string[] = [];
    if (description) commentLines.push(...description.split('\n'));
    if (translation) {
      if (commentLines.length > 0) commentLines.push('');
      commentLines.push(`"${translation}"`);
    }
    const comment =
      commentLines.length > 0
        ? `/**\n${commentLines.map((line) => `     * ${line}`.trimEnd()).join('\n')}\n     */\n    `
        : '';
    return `    ${comment}getMessage(
      messageName: ${keyType},
      substitutions?: string | string[],
      options?: GetMessageOptions,
    ): string;`;
  };

  const overrides = [
    // Generate individual overloads for each message so JSDoc contains description and base translation.
    ...messages.map((message) =>
      renderGetMessageOverload(
        `"${message.name}"`,
        message.description,
        message.message,
      ),
    ),
    // Include a final union-based override so TS accepts valid string templates or concatinations
    // ie: browser.i18n.getMessage(`some_enum_${enumValue}`)
    renderGetMessageOverload(
      messages.map((message) => `"${message.name}"`).join(' | '),
    ),
  ];

  return {
    path: 'types/i18n.d.ts',
    text: template.replace('{{ overrides }}', overrides.join('\n')),
    tsReference: true,
  };
}

async function getGlobalsDeclarationEntry(): Promise<WxtDirFileEntry> {
  const globals = [...getGlobals(wxt.config), ...getEntrypointGlobals('')];
  return {
    path: 'types/globals.d.ts',
    text: [
      '// Generated by wxt',
      'interface ImportMetaEnv {',
      ...globals.map((global) => `  readonly ${global.name}: ${global.type};`),
      '}',
      'interface ImportMeta {',
      '  readonly env: ImportMetaEnv',
      '}',
      '',
    ].join('\n'),
    tsReference: true,
  };
}

function getMainDeclarationEntry(references: WxtDirEntry[]): WxtDirFileEntry {
  const lines = ['// Generated by wxt'];
  references.forEach((ref) => {
    if ('module' in ref) {
      return lines.push(`/// <reference types="${ref.module}" />`);
    } else if (ref.tsReference) {
      const absolutePath = resolve(wxt.config.wxtDir, ref.path);
      const relativePath = relative(wxt.config.wxtDir, absolutePath);
      lines.push(`/// <reference types="./${normalizePath(relativePath)}" />`);
    }
  });
  return {
    path: 'wxt.d.ts',
    text: lines.join('\n') + '\n',
  };
}

async function getTsConfigEntry(): Promise<WxtDirFileEntry> {
  const dir = wxt.config.wxtDir;
  const getTsconfigPath = (path: string) => {
    const res = normalizePath(relative(dir, path));
    if (res.startsWith('.') || res.startsWith('/')) return res;
    return './' + res;
  };
  const paths = Object.entries(wxt.config.alias)
    .flatMap(([alias, absolutePath]) => {
      const aliasPath = getTsconfigPath(absolutePath);
      return [
        `      "${alias}": ["${aliasPath}"]`,
        `      "${alias}/*": ["${aliasPath}/*"]`,
      ];
    })
    .join(',\n');

  const text = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "strict": true,
    "skipLibCheck": true,
    "paths": {
${paths}
    }
  },
  "include": [
    "${getTsconfigPath(wxt.config.root)}/**/*",
    "./wxt.d.ts"
  ],
  "exclude": ["${getTsconfigPath(wxt.config.outBaseDir)}"]
}`;

  return {
    path: 'tsconfig.json',
    text,
  };
}