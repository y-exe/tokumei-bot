import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from '../domain/config.js';
import { validateText } from '../domain/validation.js';
import { WorkQueue } from './http.js';
import type { MediaSource } from './service.js';

const queue = new WorkQueue(1, 10);
const bridge = fileURLToPath(new URL('./gallery_bridge.py', import.meta.url));
const output = z.object({ status: z.enum(['ok','unsupported','failed']), media: z.array(z.object({ url: z.string().max(4000).url(), headers: z.record(z.string(),z.string().max(4000)).optional() })).max(11) });

export function galleryEnvironment(ambient: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','TEMP','TMP']);
  return Object.fromEntries(Object.entries(ambient).filter(([name])=>allowed.has(name.toUpperCase())));
}

export function galleryMedia(value: unknown, config: Config): MediaSource[] {
  const result = output.safeParse(value);
  if (!result.success || result.data.status !== 'ok') return [];
  const media: MediaSource[] = [];
  for (const item of result.data.media) {
    const url = new URL(item.url);
    if(url.protocol!=='https:'||url.username||url.password||url.port)continue;
    validateText(item.url,config,4000,'source');
    const headers = Object.fromEntries(Object.entries(item.headers??{}).filter(([name,value])=>['referer','user-agent'].includes(name.toLowerCase())&&!/[\r\n]/.test(value)));
    media.push({url:item.url,headers,kind:/\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(item.url)?'video':/\.gif(?:[?#]|$)/i.test(item.url)?'animation':'image'});
  }
  return media;
}

export class GalleryDl {
  constructor(readonly python=process.env.NODE_ENV==='test'?undefined:process.env.GALLERY_DL_PYTHON) {}
  async resolve(url: string, config: Config): Promise<MediaSource[]> {
    if(!this.python)return [];
    validateText(url,config,4000,'source');
    return queue.run(async()=>{
      const result = await new Promise<string>(done=>{
        const child=spawn(this.python!,['-I','-B',bridge],{env:galleryEnvironment(process.env),stdio:['pipe','pipe','ignore'],windowsHide:true});
        let data='',bytes=0,finished=false;
        const finish=(value:string)=>{if(finished)return;finished=true;clearTimeout(timer);done(value);};
        const timer=setTimeout(()=>{child.kill();finish('');},30_000);
        child.stdout.on('data',(part:Buffer)=>{bytes+=part.length;if(bytes>128*1024){child.kill();finish('');}else data+=part.toString('utf8');});
        child.on('error',()=>finish(''));child.on('close',code=>finish(code===0?data:''));child.stdin.on('error',()=>{});
        child.stdin.end(JSON.stringify({url,blockedDomains:config.policy.blockedDomains}));
      });
      let value: unknown;
      try{value=JSON.parse(result);}catch{return [];}
      return galleryMedia(value,config);
    });
  }
}
