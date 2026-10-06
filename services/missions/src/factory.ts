import postgres from "postgres";
import type { FroshMissionStore } from "../../../packages/types/src/mission";
import {InMemoryMissionStore,PostgresMissionStore} from "./store";
let store:FroshMissionStore|undefined;

export function getMissionStore(){
  if(store)return store;
  const url=process.env.DATABASE_URL?.trim();
  store=url?new PostgresMissionStore(postgres(url,{max:5,idle_timeout:20})):new InMemoryMissionStore();
  return store;
}

export async function closeMissionStore():Promise<void>{
  const current=store;
  store=undefined;
  if(current instanceof PostgresMissionStore)await current.close();
}
