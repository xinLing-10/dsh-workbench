import http from 'node:http';
import os from 'node:os';
const host=Object.values(os.networkInterfaces()).flat().find(x=>x.family==='IPv4'&&!x.internal)?.address;
if(!host)process.exit(1);
const request=http.get({host,port:3080,path:'/',timeout:3500},response=>{
  response.resume();
  // Authentication is expected: never retrieve or print a launch token here.
  process.exit([200,302,401].includes(response.statusCode)?0:1);
});
request.on('timeout',()=>request.destroy());
request.on('error',()=>process.exit(1));
