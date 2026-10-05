import { getMissionStore } from "./factory";

let started=false;

export function startMissionRunner(){
  if(started)return;
  started=true;
  const workerId=crypto.randomUUID();
  const tick=async()=>{
    const userId=process.env.FROSH_AUTOMATION_USER_ID?.trim();
    if(!userId)return;
    const store=getMissionStore();
    const missions=await store.list(userId);
    const limit=Math.max(1,Number(process.env.FROSH_MAX_CONCURRENT_MISSIONS??2)||2);
    const candidates=missions.filter((mission)=>mission.status==="running"||mission.status==="planning");
    for(let offset=0;offset<candidates.length;offset+=limit){
      const batch=candidates.slice(offset,offset+limit);
      await Promise.all(batch.map(async(mission)=>{
        try{
          const claimed=await store.claim(mission.id,userId);
          if(!claimed)return;
          const heartbeat=setInterval(()=>void store.renewLease(mission.id,userId),60_000);
          try{
            const response=await fetch("http://localhost:"+String(process.env.PORT??3001)+"/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(mission.id)+"/recover",{method:"POST",headers:{"x-frosh-web-token":process.env.FROSH_WEB_TOKEN??"","x-frosh-mission-worker-id":workerId}});
            if(!response.ok)console.error("FROSH mission worker failed",mission.id,response.status);
          } finally {
            clearInterval(heartbeat);
          }
        }catch(error){console.error("FROSH mission worker error",mission.id,error);}
      }));
    }
  };
  void tick();
  setInterval(()=>void tick(),60_000);
}
