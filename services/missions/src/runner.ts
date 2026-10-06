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
            const heartbeat=setInterval(()=>{
              if(leaseLost||renewing)return;
              renewing=true;
              void store.renewLease(mission.id,userId,executionOwner)
                .then((renewed)=>{if(!renewed)leaseLost=true;})
                .catch(()=>{leaseLost=true;})
                .finally(()=>{renewing=false;});
            },30_000);
            try{
              const response=await fetch("http://localhost:"+String(process.env.PORT??3001)+"/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(mission.id)+"/recover",{
                method:"POST",
                headers:{
                  "x-frosh-web-token":process.env.FROSH_WEB_TOKEN??"",
                  "x-frosh-mission-worker-id":executionOwner
                }
              });
              if(!response.ok)console.error("FROSH mission worker failed",mission.id,response.status);
              if(leaseLost)console.warn("FROSH mission worker lost its lease",mission.id);
            } finally {
              clearInterval(heartbeat);
              await store.releaseLeaseIfOwned(mission.id,userId,executionOwner).catch(()=>undefined);
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
