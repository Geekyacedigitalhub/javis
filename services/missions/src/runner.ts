import { getMissionStore } from "./factory";

let started=false;
let stopping=false;
let tickRunning=false;
let tickTimer:ReturnType<typeof setInterval>|undefined;
let activeTick:Promise<void>|undefined;

async function tick(){
  if(tickRunning||stopping)return;
  tickRunning=true;
  try{
    const userId=process.env.FROSH_AUTOMATION_USER_ID?.trim();
    if(!userId||stopping)return;
    const store=getMissionStore();
    const missions=await store.list(userId);
    const configuredLimit=Number(process.env.FROSH_MAX_CONCURRENT_MISSIONS??2);
    const limit=Number.isFinite(configuredLimit)?Math.max(1,Math.floor(configuredLimit)):2;
    const configuredTimeout=Number(process.env.FROSH_MISSION_RUNNER_TIMEOUT_MS??60_000);
    const timeoutMs=Number.isFinite(configuredTimeout)
      ? Math.min(120_000,Math.max(5_000,Math.floor(configuredTimeout)))
      : 60_000;
    const candidates=missions.filter((mission)=>mission.status==="running"||mission.status==="planning");
    for(let offset=0;offset<candidates.length;offset+=limit){
      if(stopping)break;
      const batch=candidates.slice(offset,offset+limit);
      await Promise.all(batch.map(async(mission)=>{
        if(stopping)return;
        const executionOwner="mission-runner:"+crypto.randomUUID();
        try{
          const claimed=await store.claim(mission.id,userId,executionOwner);
          if(!claimed||stopping){
            if(claimed&&stopping)await store.releaseLeaseIfOwned(mission.id,userId,executionOwner).catch(()=>undefined);
            return;
          }
          let leaseLost=false;
          let renewing=false;
          let handoffReturned=false;
          const heartbeat=setInterval(()=>{
            if(leaseLost||renewing||stopping)return;
            renewing=true;
            void store.renewLease(mission.id,userId,executionOwner)
              .then((renewed)=>{if(!renewed)leaseLost=true;})
              .catch(()=>{leaseLost=true;})
              .finally(()=>{renewing=false;});
          },30_000);
          try{
            if(stopping)return;
            const controller=new AbortController();
            const timeout=setTimeout(()=>controller.abort(),timeoutMs);
            try{
              const response=await fetch("http://localhost:"+String(process.env.PORT??3001)+"/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(mission.id)+"/recover",{
                method:"POST",
                headers:{
                  "x-frosh-web-token":process.env.FROSH_WEB_TOKEN??"",
                  "x-frosh-mission-worker-id":executionOwner
                },
                signal:controller.signal
              });
              handoffReturned=true;
              if(!response.ok)console.error("FROSH mission worker failed",mission.id,response.status);
              if(leaseLost)console.warn("FROSH mission worker lost its lease",mission.id);
            }catch(error){
              if(controller.signal.aborted){
                console.error("FROSH mission worker handoff timed out",mission.id,timeoutMs);
              }else{
                const errorName=error instanceof Error&&error.name?error.name:"UnknownError";
                console.error("FROSH mission worker handoff failed",mission.id,errorName);
              }
            }finally{
              clearTimeout(timeout);
            }
          }finally{
            clearInterval(heartbeat);
            if(handoffReturned){
              await store.releaseLeaseIfOwned(mission.id,userId,executionOwner).catch(()=>undefined);
            }else if(!stopping){
              console.warn("FROSH mission runner leaving lease for expiry after incomplete handoff",mission.id);
            }
          }
        }catch(error){
          const errorName=error instanceof Error&&error.name?error.name:"UnknownError";
          console.error("FROSH mission worker error",mission.id,errorName);
        }
      }));
    }
  }catch(error){
    const errorName=error instanceof Error&&error.name?error.name:"UnknownError";
    console.error("FROSH mission runner tick failed",errorName);
  }finally{
    tickRunning=false;
  }
}

function scheduleTick(){
  if(tickRunning||stopping)return;
  const promise=tick();
  activeTick=promise;
  void promise.finally(()=>{
    if(activeTick===promise)activeTick=undefined;
  });
}

export function startMissionRunner(){
  if(started||stopping)return;
  started=true;
  scheduleTick();
  tickTimer=setInterval(scheduleTick,10_000);
}

export async function stopMissionRunner(){
  if(!started)return;
  stopping=true;
  if(tickTimer){
    clearInterval(tickTimer);
    tickTimer=undefined;
  }
  if(activeTick)await activeTick;
  started=false;
  stopping=false;
}
