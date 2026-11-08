import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
if(process.argv.includes('--help')){
  console.log(`Ghidorah full-stack prototype\n\nnpm start                       Recorded snapshot + dashboard\nnpm start -- --mock              Live mock water input + dashboard\nnpm start -- --port COM3         Read-only Arduino USB input + dashboard\nnpm start -- --dataset <folder>  Select a three-file dataset folder\n\nDashboard: http://127.0.0.1:5173\nDatabase:  http://127.0.0.1:3000\nCtrl+C stops processes started by this launcher.\nAll field shutdowns are simulated; no equipment commands are sent.\nFirst setup: npm run setup (see SETUP.md).`);
}else{
  for(const [name,path] of [['backend','backend/node_modules/tsx/dist/cli.mjs'],['frontend','frontend/node_modules/vite/bin/vite.js']])if(!existsSync(join(root,path)))throw new Error(`${name} dependencies are missing. From the repository root run npm.cmd run setup, then npm.cmd start.`);
  // npm start supplies this automatically. These locations support direct node main.mjs too.
  if(!process.env.npm_execpath){const candidates=[join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'/usr/share/nodejs/npm/bin/npm-cli.js','/usr/local/lib/node_modules/npm/bin/npm-cli.js','/usr/lib/node_modules/npm/bin/npm-cli.js'];const cli=candidates.find(existsSync);if(!cli)throw new Error('Run npm.cmd start so npm supplies its entrypoint.');process.env.npm_execpath=cli;}
  await import('./scripts/dev.mjs');
}
