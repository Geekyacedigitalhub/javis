import postgres from "postgres";
import type { FroshMission, FroshMissionStore } from "../../../packages/types/src/mission";
type Sql=ReturnType<typeof postgres>;

export class PostgresMissionStore implements FroshMissionStore {
  constructor(private readonly sql:Sql){}
  async list(userId:string){return this.sql.unsafe<FroshMission[]>(`SELECT id,user_id AS "userId",goal,status,progress,steps,active_run_id AS "activeRunId",pending_approval_id AS "pendingApprovalId",result,created_at AS "createdAt",updated_at AS "updatedAt" FROM frosh_missions WHERE user_id=$1 ORDER BY updated_at DESC`,[userId]);}
  async get(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`SELECT id,user_id AS "userId",goal,status,progress,steps,active_run_id AS "activeRunId",pending_approval_id AS "pendingApprovalId",result,created_at AS "createdAt",updated_at AS "updatedAt" FROM frosh_missions WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,userId]);return rows[0]??null;}
  async create(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){const id=crypto.randomUUID();const rows=await this.sql.unsafe<FroshMission[]>(`INSERT INTO frosh_missions(id,user_id,goal,status,progress,steps,active_run_id,pending_approval_id,result) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id,user_id AS "userId",goal,status,progress,steps,active_run_id AS "activeRunId",pending_approval_id AS "pendingApprovalId",result,created_at AS "createdAt",updated_at AS "updatedAt"`,[id,input.userId,input.goal,input.status,input.progress,JSON.stringify(input.steps),input.activeRunId??null,input.pendingApprovalId??null,input.result??null]);return rows[0];}
  async update(id:string,userId:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){const current=await this.get(id,userId);if(!current)throw new Error("Mission not found");const next={...current,...patch};const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET goal=$3,status=$4,progress=$5,steps=$6::jsonb,active_run_id=$7,pending_approval_id=$8,result=$9,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id,user_id AS "userId",goal,status,progress,steps,active_run_id AS "activeRunId",pending_approval_id AS "pendingApprovalId",result,created_at AS "createdAt",updated_at AS "updatedAt"`,[id,userId,next.goal,next.status,next.progress,JSON.stringify(next.steps),next.activeRunId??null,next.pendingApprovalId??null,next.result??null]);return rows[0];}
  async delete(id:string,userId:string){const result=await this.sql.unsafe("DELETE FROM frosh_missions WHERE id=$1 AND user_id=$2",[id,userId]);return result.count>0;}
}
export class InMemoryMissionStore implements FroshMissionStore {
  private items=new Map<string,FroshMission>();
  async list(userId:string){return [...this.items.values()].filter(x=>x.userId===userId).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));}
  async get(id:string,userId:string){const x=this.items.get(id);return x?.userId===userId?x:null;}
  async create(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){const now=new Date().toISOString();const x={...input,id:crypto.randomUUID(),createdAt:now,updatedAt:now};this.items.set(x.id,x);return x;}
  async update(id:string,userId:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){const x=await this.get(id,userId);if(!x)throw new Error("Mission not found");const next={...x,...patch,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async delete(id:string,userId:string){const x=await this.get(id,userId);if(!x)return false;this.items.delete(id);return true;}
}
