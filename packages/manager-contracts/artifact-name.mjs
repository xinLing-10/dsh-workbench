/** Human-facing names never use an execution id as a document title. */
export function artifactName(text,path='成果.md'){
 const base=path.split('/').pop()||'成果.md',ext=base.match(/\.[a-z0-9]{1,8}$/i)?.[0]||'.md';
 const heading=String(text||'').match(/^\s{0,3}#{1,3}\s+(.+)$/m)?.[1];
 const opaque=/^(?:reply-|eng_|op_|[a-f0-9]{16})/i.test(base);
 const title=heading||(opaque?String(text||'').split('\n').find(line=>line.trim()&&!line.startsWith('```')):'');
 const clean=String(title||'').replace(/[#*`<>:"/\\|?\x00-\x1f]/g,'').trim().replace(/\s+/g,' ').slice(0,64).replace(/[. ]+$/,'');
 return clean?clean.replace(/\.(md|markdown|txt)$/i,'')+ext:opaque?'项目说明'+ext:base;
}
