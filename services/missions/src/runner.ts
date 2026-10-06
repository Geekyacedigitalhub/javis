import { getMissionStore } from "./factory";

let started=false;

export function startMissionRunner(){
  if(started)return;
  started=true;
  let tickRunning=false;
  const tick=async()=>{
    if(tickRunning)return;
    tickRunning=true;
    try{
      const userId=process.env.FROSH_AUTOMATION_USER_ID?.trim();
      if(!userId)return;
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
        const batch=candidates.slice(offset,offset+limit);
        await Promise.all(batch.map(async(mission)=>{
          const executionOwner="mission-runner:"+crypto.randomUUID();
          try{
            const claimed=await store.claim(mission.id,userId,executionOwner);
            if(!claimed)return;
            let leaseLost=false;
            let renewing=false;
            let handoffReturned=false;
            const heartbeat=setInterval(()=>{
              if(leaseLost||renewing)return;
              renewing=true;
              void store.renewLease(mission.id,userId,executionOwner)
                .then((renewed)=>{if(!renewed)leaseLost=true;})
                .catch(()=>{leaseLost=true;})
                .finally(()=>{renewing=false;});
            },30_000);
            try{
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
                  console.error("FROSH mission worker handoff failed",mission.id,error);
                }
              }finally{
                clearTimeout(timeout);
              }
            } finally {
              clearInterval(heartbeat);
              if(handoffReturned){
                await store.releaseLeaseIfOwned(mission.id,userId,executionOwner).catch(()=>undefined);
              }else{
                console.warn("FROSH mission runner leaving lease for expiry after incomplete handoff",mission.id);
              }
            }
          }catch(error){console.error("FROSH mission worker error",mission.id,error);}
        }));
      }
    }catch(error){
      console.error("FROSH mission runner tick failed",error);
    }finally{
      tickRunning=false;
    }
  };
  void tick();
  setInterval(()=>void tick(),10_000);
}
