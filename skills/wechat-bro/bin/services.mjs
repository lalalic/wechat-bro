#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const skill="wechat-bro";
const definitions=[["daemon", "npx", ["-y", "wechat-bro@latest", "--daemon", "--port", "9231", "--quiet"]], ["orchestrator", "npx", ["-y", "wechat-bro@latest", "orchestrator", "--harness", "codex", "--port", "9231"]]];
const home=process.env.HOME||'';
const expand=s=>s.replaceAll('__HOME__',home);
const action=process.argv[2]||'status';
if(!['setup','status','doctor'].includes(action)){console.error('usage: node skills/'+skill+'/bin/services.mjs setup|status|doctor');process.exit(2)}
const run=(cmd,args)=>{const p=spawnSync(cmd,args,{encoding:'utf8'});if(p.error)throw p.error;if(p.status!==0)throw new Error(cmd+' failed: '+String(p.stderr||p.stdout).slice(0,300));return p.stdout};
try {
 const pm2=JSON.parse(run('npx',['--yes','pm2','jlist']));
 const report=[];
 for(const [service,binary,args] of definitions){
   const id=skill+'/'+service;
   const current=pm2.find(x=>x.name===id);
   if(action==='setup'&&!current){
      if(skill==='family-tutor')throw new Error('family-tutor/orchestrator missing: provision product runtime before setup; serviceman must not infer its working directory');
      const result=spawnSync('serviceman',['define','--skill',skill,'--service',service,'--apply','--',binary,...args.map(expand)],{stdio:'inherit'});
      if(result.error)throw result.error;
      if(result.status!==0)throw new Error('failed to define '+id);
   }
   const live=action==='setup'?JSON.parse(run('npx',['--yes','pm2','jlist'])).find(x=>x.name===id):current;
   report.push({service:id,state:live?.pm2_env?.status||'missing',registered:Boolean(live)});
 }
 console.log(JSON.stringify({skill,services:report},null,2));
 if(report.some(x=>x.state!=='online'))process.exitCode=2;
} catch(e){console.error(e.message);process.exitCode=2}
