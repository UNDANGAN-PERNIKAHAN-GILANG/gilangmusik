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
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return res.status(400).json({error:'ID video tidak valid.',received:videoId});
  if(!RAPID_KEY)return res.status(503).json({error:'RapidAPI belum dikonfigurasi. Tambahkan RAPIDAPI_KEY di Railway Variables.'});
  try{
    const params=new URLSearchParams({url:`https://www.youtube.com/watch?v=${videoId}`,endTime:'0',format:'mp3'});
    const url=`https://${RAPID_HOST}/download?${params}`;
    const r=await fetch(url,{method:'POST',headers:{'accept':'application/json','content-type':'application/json','x-rapidapi-key':RAPID_KEY,'x-rapidapi-host':RAPID_HOST},body:'{}'});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.message||data.error||`RapidAPI error ${r.status}`);
    res.json(data);
  }catch(e){res.status(502).json({error:e.message})}
});
app.get('/api/stream',async(req,res)=>{
  const url=String(req.query.url||'');
  let parsed;try{parsed=new URL(url)}catch{return res.status(400).send('URL tidak valid')}
  if(!['https:'].includes(parsed.protocol))return res.status(400).send('URL tidak valid');
  try{
    const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'}});
    if(!r.ok||!r.body)return res.status(502).send('Audio tidak tersedia dari sumber download.');
    res.setHeader('content-type',r.headers.get('content-type')||'audio/mpeg');
    res.setHeader('content-disposition','attachment; filename="gudang-lagu.mp3"');
    r.body.pipeTo(new WritableStream({write(chunk){res.write(Buffer.from(chunk))},close(){res.end()},abort(){res.end()}})).catch(()=>res.end());
  }catch(e){res.status(502).send(e.message)}
});
app.listen(port,'0.0.0.0',()=>console.log(`Gudang Lagu Gilang listening on ${port}`));
