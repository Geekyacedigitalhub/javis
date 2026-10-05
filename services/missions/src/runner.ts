import { getMissionStore } from "./factory";
import { OpenAIProvider } from "../../ai/src/openai-provider";
import { CodingSessionManager } from "../../ai/src/coding-session";

let started=false;
const sessions=new CodingSessionManager(new OpenAIProvider());

export function startMissionRunner(){
  if(started)return;
  started=true;
  const tick=async()=>{
    const userId=process.env.FROSH_AUTOMATION_USER_ID?.trim();
    if(!userId)return;
    const store=getMissionStore();
    const missions=await store.list(userId);
    for(const mission of missions){
      if(mission.status!=="running"&&mission.status!=="planning")continue;
      try{
        const claimed=await store.claim(mission.id,userId);
        if(!claimed)continue;
        const response=await fetch("http://localhost:"+String(process.env.PORT??3001)+"/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(mission.id)+"/recover",{method:"POST",headers:{"x-frosh-web-token":process.env.FROSH_WEB_TOKEN??""}});
        if(!response.ok) console.error("FROSH mission worker failed",mission.id,response.status);
      }catch(error){console.error("FROSH mission worker error",mission.id,error);}
    }
  };
  void tick();
  setInterval(()=>void tick(),60_000);
}
