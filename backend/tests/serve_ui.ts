import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {openSync,mkdirSync,closeSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
process.env.SPACETIME_URI='ws://127.0.0.1:3101';process.env.SPACETIME_DATABASE='ghidorah-ui-check';process.env.SPACETIME_ROOT=resolve('.runtime-ui');
process.env.VITE_SPACETIME_URI=process.env.SPACETIME_URI;process.env.VITE_SPACETIME_DATABASE=process.env.SPACETIME_DATABASE;
const {startServer,stopProcess,cli,httpOrigin,database}=await import('../scripts/cli.js');
const {connectNode}=await import('../scripts/connection.js');const {importDataset,DEFAULT_FOLDER}=await import('../scripts/import.js');
mkdirSync('.runtime-ui',{recursive:true});const fd=openSync('.runtime-ui/server.log','a'),server=startServer({stdio:['ignore',fd,fd]});closeSync(fd);let ui:ReturnType<typeof spawn>|undefined;
function stop(){stopProcess(ui);stopProcess(server);}
process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('exit',stop);
try{for(let i=0;;i++){try{if((await fetch(`${httpOrigin}/v1/ping`)).ok)break;}catch{}if(i>100)throw new Error('UI database did not start');await delay(200);}
  cli(['publish','--server',httpOrigin,'--module-path','spacetimedb','--yes=skip-login',database]);const conn=await connectNode(true);try{await importDataset(conn,DEFAULT_FOLDER);}finally{conn.disconnect();}
  ui=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5174','--strictPort'],{cwd:resolve('../frontend'),stdio:'inherit',windowsHide:true,env:process.env});
  console.log('UI CHECK READY: http://127.0.0.1:5174');
}catch(error){stop();throw error;}
