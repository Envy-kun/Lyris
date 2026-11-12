const SERVER="http://localhost:8787/now";
const SEEK=1.5;
const FONT='-apple-system,"SF Pro Display",Arial,sans-serif';

const clamp01=x=>Math.max(0,Math.min(1,x));
function rnd(s){return()=>{s=(s*1664525+1013904223)%4294967296;return s/4294967296}}
const ROWS=[.3,.52,.72];
const place=(k,n,r)=>({x:.1+.8*(n<2?.5:k/(n-1))+(r()-.5)*.04,y:ROWS[k%3]+(r()-.5)*.08});

function finish(L){
  L.forEach((ln,i)=>{
    const nextT=L[i+1]?L[i+1].t:Infinity;
    ln.words.forEach((w,k)=>{w.rel=ln.words[k+1]?ln.words[k+1].at:nextT});
    const durs=ln.words.map(w=>Math.min(3,Math.max(.05,w.rel-w.at)));
    const mean=durs.reduce((a,b)=>a+b,0)/durs.length;
    ln.words.forEach((w,k)=>{
      const len=w.w.replace(/[^\p{L}\p{N}]/gu,"").length,d=durs[k];
      const lenS=clamp01((len-3)/5);
      const durS=.5*clamp01((d-.3)/1.2)+.5*clamp01((d/mean-.6)/1);
      w.imp=.7*Math.max(lenS,durS)+.3*Math.min(lenS,durS);
    });
  });
  return L;
}

function build(L){
  L=L.slice().sort((a,b)=>a[0]-b[0]);
  return finish(L.map(([t,s],i)=>{
    const w=s.split(" ").filter(Boolean),n=w.length,r=rnd(i*977+13);
    const gap=L[i+1]?L[i+1][0]-t:5,dur=Math.min(gap,6)*.75,hold=gap>7?7:Infinity;
    const wt=w.map(x=>x.length+2),sum=wt.reduce((a,b)=>a+b,0);
    let acc=0;
    return{t,dur,hold,words:w.map((x,k)=>{
      const at=t+dur*acc/sum;acc+=wt[k];
      return{w:x,at,...place(k,n,r)};
    })};
  }).filter(l=>l.words.length));
}

const toSec=s=>s.split(":").reduce((a,p)=>a*60+parseFloat(p),0);
function parseTTML(txt){
  const doc=new DOMParser().parseFromString(txt,"application/xml");
  if(doc.getElementsByTagName("parsererror").length)throw new Error("bad xml");
  const out=[];
  for(const p of doc.getElementsByTagName("p")){
    const syl=[];let gap=true;
    (function walk(node){
      for(const c of node.childNodes){
        if(c.nodeType===3){if(/\s/.test(c.nodeValue))gap=true}
        else if(c.nodeType===1){
          if(c.hasAttribute("begin")&&!c.getElementsByTagName("span").length){
            const raw=c.textContent,text=raw.trim();
            if(text)syl.push({text,at:toSec(c.getAttribute("begin")),sp:gap||/^\s/.test(raw)});
            gap=/\s$/.test(raw);
          }else walk(c);
        }
      }
    })(p);
    const words=[];
    for(const s of syl){if(s.sp||!words.length)words.push({w:s.text,at:s.at});else words[words.length-1].w+=s.text}
    if(!words.length)continue;
    words.sort((a,b)=>a.at-b.at);
    const pb=p.hasAttribute("begin")?toSec(p.getAttribute("begin")):words[0].at;
    const pe=p.hasAttribute("end")?toSec(p.getAttribute("end")):words[words.length-1].at+1;
    out.push({t:Math.min(pb,words[0].at),end:pe,words});
  }
  out.sort((a,b)=>a.t-b.t);
  return out;
}
function buildFile(R){
  return finish(R.map((ln,i)=>{
    const n=ln.words.length,r=rnd(i*977+13);
    const next=R[i+1]?R[i+1].t:ln.end+5,gap=next-ln.t,dur=Math.max(.5,ln.end-ln.t);
    const hold=gap-dur>2.5?dur+1.5:Infinity;
    return{t:ln.t,dur,hold,words:ln.words.map((w,k)=>({w:w.w,at:w.at,...place(k,n,r)}))};
  }));
}
const storeKey=k=>"ttml:"+k;
function stored(k){try{return JSON.parse(localStorage.getItem(storeKey(k)))}catch{return null}}
function store(k,raw){try{localStorage.setItem(storeKey(k),JSON.stringify(raw))}catch{}}

// ---- page ----
const cv=document.getElementById("c"),ctx=cv.getContext("2d");
const ti=document.getElementById("ti"),ar=document.getElementById("ar"),artEl=document.getElementById("art");
const msgEl=document.getElementById("msg"),mm=document.getElementById("mm");
const srcBtn=document.getElementById("src-btn");
const fileIn=document.getElementById("file");
let W=0,H=0,dpr=1;
let key="",pendKey=null,pendCount=0,offset=0,hint="",haveTrack=false,dbg=false,curArt="";
let mode="auto",autoLines=[],fileLines=null,lines=[];
let currentSource="auto";
const bg=Array.from({length:40},(_,i)=>{const r=rnd(i+5);return{x:r(),y:r(),s:r()*1.2+.3,p:r()*6}});

function size(){
  const b=cv.getBoundingClientRect();dpr=window.devicePixelRatio||1;
  W=b.width;H=b.height;cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
}
new ResizeObserver(size).observe(cv);size();

let msgTimer;
function toast(t){msgEl.textContent=t;msgEl.style.opacity=1;clearTimeout(msgTimer);msgTimer=setTimeout(()=>msgEl.style.opacity=0,1800)}
function setHint(){
  if(!haveTrack)hint="";
  else if(mode==="file")hint=fileLines?"":"no file loaded for this song — tap Load word-synced file";
  else hint=autoLines.length?"":currentSource==="none"?"no synced lyrics found for this song":"looking for synced lyrics…";
}
function refresh(){
  lines=mode==="file"?(fileLines||[]):autoLines;
  mm.textContent=mode==="file"?"Mode: my file":"Mode: auto";
  srcBtn.textContent=`Source: ${mode==="file"?"my file":currentSource}`;
  setHint();
}

const clk={pos:0,last:performance.now(),playing:false,hist:[],pend:null,frozen:0,have:false,raw:0};
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1]};

function target(now){
  if(clk.playing&&clk.hist.length)return now/1000+med(clk.hist)+offset;
  return clk.frozen+offset;
}
function ingest(d,tMid){
  const first=!clk.have;
  if(d.playing!==clk.playing){clk.playing=d.playing;clk.hist=[];clk.pend=null}
  clk.frozen=d.pos;clk.raw=d.pos;
  if(d.playing){
    const off=d.pos-tMid/1000,m=clk.hist.length?med(clk.hist):off;
    if(Math.abs(off-m)<=SEEK){clk.hist.push(off);if(clk.hist.length>7)clk.hist.shift();clk.pend=null}
    else if(clk.pend!==null&&Math.abs(off-clk.pend)<.4){clk.hist=[off];clk.pend=null}
    else clk.pend=off;
  }
  if(first){clk.have=true;clk.pos=target(performance.now())}
}
function tick(now){
  const dt=Math.min(.5,Math.max(0,(now-clk.last)/1000));clk.last=now;
  if(!clk.have)return 0;
  const tg=target(now),max=.25*dt;
  if(clk.playing){
    clk.pos+=dt;
    const e=tg-clk.pos;
    if(Math.abs(e)>SEEK)clk.pos=tg;else clk.pos+=Math.max(-max,Math.min(max,e));
  }else{
    const e=tg-clk.pos;
    clk.pos=Math.abs(e)>SEEK?tg:clk.pos+e*Math.min(1,dt*10);
  }
  return clk.pos;
}

function switchTrack(d){
  key=d.key;autoLines=[];offset=0;
  clk.have=false;clk.hist=[];clk.pend=null;clk.playing=false;
  const raw=stored(key);fileLines=raw?buildFile(raw):null;
  currentSource="auto";
  mode=fileLines?"file":"auto";
  refresh();
}
function handle(d,tMid){
  if(!d.title){haveTrack=false;setHint();return}   // nothing playing: clear any stale "can't reach" hint
  haveTrack=true;
  if(d.key!==key){
    if(!key){switchTrack(d)}
    else{
      if(d.key!==pendKey){pendKey=d.key;pendCount=1}else pendCount++;
      if(pendCount<2)return;
      switchTrack(d);
    }
    pendKey=null;
  }else pendKey=null;

  if(!autoLines.length){
    if(d.rawTtml){
      try{autoLines=buildFile(parseTTML(d.rawTtml));currentSource=d.source}catch{}
    }
    if(!autoLines.length&&d.lines&&d.lines.length){
      autoLines=build(d.lines);currentSource=d.source;
    }
    if(!autoLines.length&&d.source==="none")currentSource="none";
    refresh();
  }

  ingest(d,tMid);
  ti.textContent=d.title;ar.textContent=d.artist;
  const a=d.art||"";
  if(a!==curArt){curArt=a;artEl.style.backgroundImage=a?`url("${a}")`:""}
  setHint();
}

async function pollLoop(){
  for(;;){
    const t0=performance.now();
    let d=null;
    const ctl=new AbortController(),to=setTimeout(()=>ctl.abort(),1500);
    try{
      // tell the server which track we already have lyrics for, so it skips resending them
      const r=await fetch(SERVER+"?k="+encodeURIComponent(autoLines.length?key:""),{signal:ctl.signal,cache:"no-store"});
      d=await r.json();
    }catch{hint="can’t reach server.js"}
    finally{clearTimeout(to)}
    if(d){try{handle(d,(t0+performance.now())/2)}catch(e){console.error(e)}}
    await new Promise(res=>setTimeout(res,Math.max(100,400-(performance.now()-t0))));
  }
}
pollLoop();

// ---- buttons ----
document.getElementById("load").addEventListener("click",()=>{
  if(!key){toast("start a song first");return}
  fileIn.click();
});
fileIn.addEventListener("change",async()=>{
  const f=fileIn.files[0];fileIn.value="";
  if(!f)return;
  try{
    const raw=parseTTML(await f.text());
    if(!raw.length)throw new Error("no lines");
    store(key,raw);fileLines=buildFile(raw);mode="file";refresh();
    toast("loaded "+raw.length+" lines");
  }catch{toast("couldn’t read that file")}
});
mm.addEventListener("click",()=>{mode=mode==="auto"?"file":"auto";refresh()});
srcBtn.addEventListener("click",()=>{
  toast(`Current provider: ${mode==="file"?"my file":currentSource}`);
});

// ---- drawing & rendering ----
function star(x,y,r){
  if(r<.05)return;
  ctx.beginPath();ctx.moveTo(x,y-r);
  ctx.quadraticCurveTo(x,y,x+r,y);ctx.quadraticCurveTo(x,y,x,y+r);
  ctx.quadraticCurveTo(x,y,x-r,y);ctx.quadraticCurveTo(x,y,x,y-r);ctx.fill();
}
const ease=t=>1-Math.pow(1-Math.min(1,Math.max(0,t)),3);
const mix=(a,r,g,b)=>`rgb(${(r+(255-r)*a)|0},${(g+(255-g)*a)|0},${(b+(255-b)*a)|0})`;
const fadeOut=(ln,pos)=>Math.max(0,Math.min(1,(ln.t+ln.hold-pos)/.7));
function lineAt(pos){
  let lo=0,hi=lines.length-1,r=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(lines[m].t<=pos){r=m;lo=m+1}else hi=m-1}
  return r;
}

function drawLine(ln,pos,la,big){
  if(la<=.005)return;
  const sh=[];
  for(const w of ln.words){if(w.at>pos)break;sh.push(w)}
  if(!sh.length)return;

  ctx.lineWidth=1;ctx.strokeStyle="#9a9a9a";
  for(let k=1;k<sh.length;k++){
    const a=sh[k-1],b=sh[k],e=ease((pos-b.at)/.45);
    ctx.globalAlpha=.5*la;ctx.beginPath();
    ctx.moveTo(a.x*W,a.y*H);ctx.lineTo(a.x*W+(b.x-a.x)*W*e,a.y*H+(b.y-a.y)*H*e);ctx.stroke();
  }
  for(const w of sh){
    const x=w.x*W,y=w.y*H,e=ease((pos-w.at)/.45);
    const a=ease((pos-w.at)/.15)*(1-ease((pos-w.rel)/.3));

    ctx.globalAlpha=e*la;
    ctx.fillStyle=mix(a,170,170,170);
    ctx.shadowColor="rgba(255,255,255,.6)";ctx.shadowBlur=(3+10*a)*e;
    star(x,y,(4+3*w.imp+(4+3*w.imp)*a)*e);
    ctx.shadowBlur=0;

    const rest=Math.max(11,big*(.5+.6*w.imp)),peak=Math.max(rest+2,big*(.8+1.3*w.imp));
    let fs=(rest+(peak-rest)*a)*(.85+.15*e);
    ctx.font=`600 ${fs}px ${FONT}`;
    const tw0=ctx.measureText(w.w).width;
    if(tw0>W-40){fs*=(W-40)/tw0;ctx.font=`600 ${fs}px ${FONT}`}
    const tw=ctx.measureText(w.w).width;
    let tx=x+13;if(tx+tw>W-10)tx=x-13-tw;
    tx=Math.max(10,tx);
    ctx.globalAlpha=e*la*(.65+.35*a);
    ctx.fillStyle=mix(a,140,140,140);
    ctx.fillText(w.w,tx,y+fs*.35);
  }
}

function draw(pos){
  ctx.clearRect(0,0,W,H);
  const now=performance.now()/1000;
  ctx.fillStyle="#fff";
  for(const b of bg){ctx.globalAlpha=.12+.1*Math.sin(now+b.p);ctx.beginPath();ctx.arc(b.x*W,b.y*H,b.s,0,7);ctx.fill()}
  ctx.globalAlpha=1;
  if(hint){ctx.fillStyle="#777";ctx.font=`14px ${FONT}`;ctx.textAlign="center";ctx.fillText(hint,W/2,H/2);ctx.textAlign="left"}

  if(clk.have&&lines.length){
    const idx=lineAt(pos);
    if(idx>=0){
      const big=Math.max(18,Math.min(34,Math.min(W/32,H/18))),ln=lines[idx];
      if(idx>0){const pv=lines[idx-1];drawLine(pv,pos,(1-ease((pos-ln.t)/.7))*fadeOut(pv,pos),big)}
      drawLine(ln,pos,fadeOut(ln,pos),big);
    }
  }
  ctx.globalAlpha=1;ctx.shadowBlur=0;

  if(dbg){
    ctx.fillStyle="#777";ctx.font="11px monospace";
    ctx.fillText(`clock ${pos.toFixed(2)}  server ${clk.raw.toFixed(2)}  src ${currentSource}  line ${lineAt(pos)}/${lines.length}`,10,16);
  }
}

function frame(now){draw(tick(now));requestAnimationFrame(frame)}
requestAnimationFrame(frame);

const stage=document.getElementById("stage"),fsBtn=document.getElementById("fs");
const fsEl=()=>document.fullscreenElement||document.webkitFullscreenElement;
function fsSync(){const on=!!fsEl()||document.body.classList.contains("fs");fsBtn.textContent=on?"Exit full screen":"Full screen"}
function toggleFS(){
  if(fsEl()){(document.exitFullscreen||document.webkitExitFullscreen).call(document);return}
  if(document.body.classList.contains("fs")){document.body.classList.remove("fs");fsSync();return}
  const req=stage.requestFullscreen||stage.webkitRequestFullscreen;
  if(req){Promise.resolve(req.call(stage)).catch(()=>{document.body.classList.add("fs");fsSync()})}
  else{document.body.classList.add("fs");fsSync()}
}
fsBtn.addEventListener("click",toggleFS);
stage.addEventListener("dblclick",toggleFS);
document.addEventListener("fullscreenchange",fsSync);
document.addEventListener("webkitfullscreenchange",fsSync);

addEventListener("keydown",e=>{
  if(e.ctrlKey||e.metaKey||e.altKey)return;   // don't hijack browser shortcuts like Ctrl+F
  if(e.key==="ArrowLeft"||e.key==="ArrowRight"||e.key==="0"){
    const old=offset;
    if(e.key==="ArrowLeft")offset-=.5;else if(e.key==="ArrowRight")offset+=.5;else offset=0;
    clk.pos+=offset-old;
    toast("sync "+(offset>=0?"+":"")+offset.toFixed(1)+"s");
  }else if(e.key==="m"||e.key==="M"){mm.click()}
  else if(e.key==="d"||e.key==="D"){dbg=!dbg}
  else if(e.key==="f"||e.key==="F"){toggleFS()}
  else if(e.key==="Escape"&&document.body.classList.contains("fs")){toggleFS()}
});
