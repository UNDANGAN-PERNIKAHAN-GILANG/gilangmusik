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
const RAPID_HOST=process.env.RAPIDAPI_HOST||'yt-search-and-download-mp3.p.rapidapi.com';

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

app.get('/api/download',async(req,res)=>{
  const videoId=String(req.query.videoId||'');
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return res.status(400).json({error:'ID video tidak valid.'});
  if(!RAPID_KEY)return res.status(503).json({error:'RAPIDAPI_KEY belum dikonfigurasi di environment server.'});
  try{
    const u=new URL(`https://${RAPID_HOST}/mp3`);
    u.searchParams.set('url',`https://www.youtube.com/watch?v=${videoId}`);
    const r=await fetch(u,{headers:{accept:'*/*','x-rapidapi-host':RAPID_HOST,'x-rapidapi-key':RAPID_KEY}});
    const data=await r.json().catch(()=>null);
    if(!r.ok)throw new Error(data?.message||data?.error||`RapidAPI membalas HTTP ${r.status}`);
    if(!data?.success||typeof data.download!=='string')throw new Error(data?.message||data?.error||'Respons RapidAPI tidak berisi link download.');
    const fileUrl=new URL(data.download);
    if(fileUrl.protocol!=='https:'||fileUrl.hostname!=='lib.jaiza.fun')throw new Error('Host link audio dari API tidak valid.');
    const audio=await fetch(fileUrl);
    if(!audio.ok||!audio.body)throw new Error(`Server file audio membalas HTTP ${audio.status}`);
    res.setHeader('content-type',audio.headers.get('content-type')||'audio/mpeg');
    res.setHeader('content-disposition',`attachment; filename="gudang-lagu-${videoId}.mp3"`);
    const {Readable}=await import('node:stream');Readable.fromWeb(audio.body).pipe(res);
  }catch(e){res.status(502).json({error:e.message})}
});

app.listen(port,'0.0.0.0',()=>console.log(`Gudang Lagu Gilang listening on ${port}`));
