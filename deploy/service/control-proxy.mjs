/** Loopback-only fault injection transport for this acceptance instance, not a public proxy. */
import {createServer,request} from 'node:http';import {existsSync,watch} from 'node:fs';import {dirname} from 'node:path';
const [flag]=process.argv.slice(2);if(flag!=='/srv/manager-acceptance/private/control-network-down')throw Error('Use the dedicated acceptance fault flag');
const server=createServer((req,res)=>{if(existsSync(flag)){req.socket.destroy();return;}const upstream=request({hostname:'127.0.0.1',port:8096,method:req.method,path:req.url,headers:{...req.headers,host:'127.0.0.1:8096'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});upstream.on('error',()=>res.destroy());req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);});
const watcher=watch(dirname(flag),()=>{if(existsSync(flag))server.closeAllConnections();});server.listen(8099,'127.0.0.1',()=>console.log(JSON.stringify({controlProxy:true,loopback:true})));
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{watcher.close();server.closeAllConnections();server.close(()=>process.exit(0));});
