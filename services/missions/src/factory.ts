import type { FroshMissionStore } from "../../../packages/types/src/mission";
import { getFroshDatabaseClient } from "../../database/src";
import {InMemoryMissionStore,PostgresMissionStore} from "./store";
let store:FroshMissionStore|undefined;

export function getMissionStore(){
  if(store)return store;
  const database=getFroshDatabaseClient();
  store=database?new PostgresMissionStore(database):new InMemoryMissionStore();
  return store;
}

export async function closeMissionStore():Promise<void>{
  store=undefined;
}
