const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const BUILD_TARGET = ['es2015'];

const outputs = [
  {
    entryPoint: path.join(ROOT, 'public', 'js', 'app.js'),
    outfile: path.join(ROOT, 'public', 'js', 'app.legacy.js')
  },
  {
    entryPoint: path.join(ROOT, 'public', 'ui.js'),
    outfile: path.join(ROOT, 'public', 'ui.legacy.js')
  },
  {
    entryPoint: path.join(ROOT, 'public', 'scan.js'),
    outfile: path.join(ROOT, 'public', 'scan.legacy.js')
  }
];

function removeIfExists(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

async function buildClientBundle({ entryPoint, outfile }) {
  removeIfExists(outfile);
  removeIfExists(`${outfile}.map`);

  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: BUILD_TARGET,
    outfile,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
    }
  });
}

async function main() {
  for (const bundle of outputs) {
    await buildClientBundle(bundle);
  }
  console.log('Browser compatibility bundles generated successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
