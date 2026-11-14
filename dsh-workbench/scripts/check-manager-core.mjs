import {readdir,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
for(const name of await readdir(new URL('core/',root))) {
  if(!name.endsWith('.js'))continue;
  const source=await readFile(new URL('core/'+name,root),'utf8');
  if(/(?:from|import\s*\()\s*['"]\.\.\//.test(source))throw new Error('Core must not depend on Host: '+name);
  execFileSync(process.execPath,['--check',new URL('core/'+name,root).pathname]);
}
console.log('Shared core syntax and dependency boundary OK');
