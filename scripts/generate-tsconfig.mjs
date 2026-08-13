import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(projectRoot, 'tsconfig.json');
const templatePath = join(projectRoot, 'tsconfig.template.json');
const generateOnlyWhenConfigured = process.argv.includes('--if-env');
const configuredRoot = process.env.DSH_PATH?.trim();

if (configuredRoot === undefined || configuredRoot.length === 0) {
  if (!generateOnlyWhenConfigured) {
    throw new Error('DSH_PATH must point to a DSH repository root');
  }

  // postinstall on a machine without DSH_PATH: skip generation. The runtime
  // runs from source via tsx and never needs tsconfig.json; only dev
  // build/typecheck do, and those invocations pass DSH_PATH.
  console.log(
    'DSH_PATH not set — skipping tsconfig.json generation (set DSH_PATH to build/typecheck)',
  );
  process.exit(0);
} else {
  const dshRoot = resolve(configuredRoot);
  const packageJsonPath = join(dshRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

  if (packageJson.name !== '@deepseek-ai/dsh-root') {
    throw new Error(
      `DSH_PATH does not point to a DSH repository root: ${dshRoot}`,
    );
  }

  await access(join(dshRoot, 'tsconfig.base.json'));

  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const references = template.dshReferences.map((reference) => ({
    path: join(dshRoot, reference),
  }));

  await Promise.all(
    references.map(({ path }) => access(join(path, 'tsconfig.json'))),
  );

  const tsconfig = {
    extends: join(dshRoot, 'tsconfig.base.json'),
    compilerOptions: template.compilerOptions,
    include: template.include,
    references,
  };

  await writeFile(outputPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  console.log(`Generated tsconfig.json for ${dshRoot}`);
}
