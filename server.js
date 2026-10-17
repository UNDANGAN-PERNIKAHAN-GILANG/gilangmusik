import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const app=express();
const root=path.dirname(fileURLToPath(import.meta.url));
app.use(express.json());
app.use(express.static(path.join(root,'public')));
const port=process.env.PORT||3000;
const YT_KEY=process.env.YOUTUBE_API_KEY||process.env.YOUTUBE_APIKEY;
const RAPID_KEY=process.env.RAPIDAPI_KEY;
const RAPID_HOST=process.env.RAPIDAPI_HOST||'youtube-to-mp315.p.rapidapi.com';
const ZYLA_KEY=process.env.ZYLA_API_KEY;
const ZYLA_ENDPOINT='https://zylalabs.com/api/11016/youtube+download+and+info+api/20761/download';

app.get('/api/zyla-download',async(req,res)=>{
  const videoId=String(req.query.videoId||'');
  const format=String(req.query.format||'mp3').toLowerCase();
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return res.status(400).json({error:'ID video tidak valid.'});
  if(!['mp3','m4a','flac','opus','wav','360','480','720','1080','1440','2160'].includes(format))return res.status(400).json({error:'Format tidak didukung.'});
  if(!ZYLA_KEY)return res.status(503).json({error:'ZYLA_API_KEY belum dikonfigurasi di environment server.'});
  try{
    const u=new URL(ZYLA_ENDPOINT);u.searchParams.set('url',`https://www.youtube.com/watch?v=${videoId}`);u.searchParams.set('format',format);
    const r=await fetch(u,{headers:{Authorization:`Bearer ${ZYLA_KEY}`,Accept:'application/json'}});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.message||data.error||`ZylaLabs membalas HTTP ${r.status}`);
    res.status(200).json(data);
  }catch(e){res.status(502).json({error:e.message})}
});

app.get('/api/search',async(req,res)=>{
  const q=String(req.query.q||'').trim();
  if(!q)return res.status(400).json({error:'Masukkan judul lagu dulu.'});
  if(!YT_KEY)return res.status(503).json({error:'API YouTube belum dikonfigurasi di Railway.'});
  try{
    const u=new URL('https://www.googleapis.com/youtube/v3/search');
    Object.entries({part:'snippet',type:'video',videoCategoryId:'10',maxResults:'12',q,key:YT_KEY}).forEach(([k,v])=>u.searchParams.set(k,v));
    const r=await fetch(u); const data=await r.json();
    if(!r.ok)throw new Error(data.error?.message||'Pencarian YouTube gagal');
    res.json((data.items||[]).map(x=>({id:x.id.videoId,title:x.snippet.title,channel:x.snippet.channelTitle,thumbnail:x.snippet.thumbnails?.high?.url||x.snippet.thumbnails?.default?.url})));
  }catch(e){res.status(502).json({error:e.message})}
});
const jobs=new Map();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.get('/api/download',async(req,res)=>{
  const videoId=String(req.query.videoId||'');
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return res.status(400).json({error:'ID video tidak valid.'});
  if(!RAPID_KEY)return res.status(503).json({error:'RapidAPI belum dikonfigurasi. Tambahkan RAPIDAPI_KEY di Railway Variables.'});
  try{
    const params=new URLSearchParams({url:`https://www.youtube.com/watch?v=${videoId}`,endTime:'0',format:'mp3'});
    const r=await fetch(`https://${RAPID_HOST}/download?${params}`,{method:'POST',headers:{accept:'application/json','content-type':'application/json','x-rapidapi-key':RAPID_KEY,'x-rapidapi-host':RAPID_HOST},body:'{}'});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.message||data.error||`RapidAPI error ${r.status}`);
    if(!data.id||!data.downloadUrl)throw new Error('RapidAPI tidak mengembalikan id/downloadUrl.');
    jobs.set(String(data.id),{url:String(data.downloadUrl),createdAt:Date.now()});
    res.json({id:String(data.id),status:data.status||'CONVERTING',title:data.title||'Lagu'});
  }catch(e){res.status(502).json({error:e.message})}
});
app.get('/api/download/:id',async(req,res)=>{
  if(!RAPID_KEY)return res.status(503).json({error:'RapidAPI belum dikonfigurasi.'});
  try{
    const r=await fetch(`https://${RAPID_HOST}/status/${encodeURIComponent(req.params.id)}`,{headers:{accept:'application/json','x-rapidapi-key':RAPID_KEY,'x-rapidapi-host':RAPID_HOST}});
    const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.message||data.error||`RapidAPI error ${r.status}`);
    if(data.downloadUrl)jobs.set(String(data.id||req.params.id),{url:String(data.downloadUrl),createdAt:Date.now()});
    res.json({id:String(data.id||req.params.id),status:data.status||'UNKNOWN',title:data.title||'Lagu',ready:!!data.downloadUrl});
  }catch(e){res.status(502).json({error:e.message})}
});
async function getReadyJob(id){
  let job=jobs.get(id);if(!job)throw new Error('Tugas download tidak ditemukan. Silakan klik download lagi.');
  for(let i=0;i<24;i++){
    if(job.url)return job;
    await sleep(2500);
    const r=await fetch(`https://${RAPID_HOST}/status/${encodeURIComponent(id)}`,{headers:{accept:'application/json','x-rapidapi-key':RAPID_KEY,'x-rapidapi-host':RAPID_HOST}});
    const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.message||`RapidAPI error ${r.status}`);
    if(data.downloadUrl){job={url:String(data.downloadUrl),createdAt:Date.now()};jobs.set(id,job);return job;}
    if(['FAILED','ERROR'].includes(String(data.status).toUpperCase()))throw new Error('Konversi audio gagal: '+data.status);
  }
  throw new Error('Konversi masih berjalan. Coba download lagi beberapa saat.');
}
app.get('/api/audio/:id',async(req,res)=>{
  if(!/^[A-Za-z0-9-]{10,80}$/.test(req.params.id))return res.status(400).send('ID tugas tidak valid');
  try{
    const job=await getReadyJob(req.params.id);const audioUrl=new URL(job.url);
    if(!['http:','https:'].includes(audioUrl.protocol)||!audioUrl.pathname.endsWith('.mp3'))return res.status(502).send('URL audio dari API tidak valid');
    const upstream=await fetch(audioUrl,{headers:{'user-agent':'Mozilla/5.0'}});
    if(!upstream.ok||!upstream.body)return res.status(502).send(`Server audio membalas ${upstream.status}`);
    res.setHeader('content-type','audio/mpeg');res.setHeader('content-disposition',`attachment; filename="gudang-lagu-${req.params.id}.mp3"`);
    const {Readable}=await import('node:stream');Readable.fromWeb(upstream.body).pipe(res);
  }catch(e){if(!res.headersSent)res.status(502).json({error:e.message});else res.destroy(e)}
});
app.listen(port,'0.0.0.0',()=>console.log(`Gudang Lagu Gilang listening on ${port}`));
