import postgres from "postgres";
import type { FroshMission, FroshMissionStore } from "../../../packages/types/src/mission";
type Sql=ReturnType<typeof postgres>;

const SELECT_FIELDS=`id,user_id AS "userId",goal,status,priority,budget_profile AS "budgetProfile",progress,steps,active_run_id AS "activeRunId",pending_approval_id AS "pendingApprovalId",lease_until AS "leaseUntil",lease_owner AS "leaseOwner",result,tool_calls_used AS "toolCallsUsed",execution_duration_ms AS "executionDurationMs",created_at AS "createdAt",updated_at AS "updatedAt"`;

export class PostgresMissionStore implements FroshMissionStore {
  constructor(private readonly sql:Sql){}
  async list(userId:string){return this.sql.unsafe<FroshMission[]>(`SELECT ${SELECT_FIELDS} FROM frosh_missions WHERE user_id=$1 ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, updated_at DESC`,[userId]);}
  async get(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`SELECT ${SELECT_FIELDS} FROM frosh_missions WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,userId]);return rows[0]??null;}
  async create(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){const id=crypto.randomUUID();const rows=await this.sql.unsafe<FroshMission[]>(`INSERT INTO frosh_missions(id,user_id,goal,status,priority,budget_profile,progress,steps,active_run_id,pending_approval_id,lease_until,lease_owner,result,tool_calls_used,execution_duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING ${SELECT_FIELDS}`,[id,input.userId,input.goal,input.status,input.priority,input.budgetProfile,input.progress,JSON.stringify(input.steps),input.activeRunId??null,input.pendingApprovalId??null,input.leaseUntil??null,input.leaseOwner??null,input.result??null,input.toolCallsUsed??0,input.executionDurationMs??0]);return rows[0];}
  async update(id:string,userId:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){const current=await this.get(id,userId);if(!current)throw new Error("Mission not found");const next={...current,...patch};const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET goal=$3,status=$4,priority=$5,budget_profile=$6,progress=$7,steps=$8::jsonb,active_run_id=$9,pending_approval_id=$10,lease_until=$11,lease_owner=$12,result=$13,tool_calls_used=$14,execution_duration_ms=$15,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING ${SELECT_FIELDS}`,[id,userId,next.goal,next.status,next.priority,next.budgetProfile,next.progress,JSON.stringify(next.steps),next.activeRunId??null,next.pendingApprovalId??null,next.leaseUntil??null,next.leaseOwner??null,next.result??null,next.toolCallsUsed,next.executionDurationMs]);return rows[0];}
  async claim(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',lease_until=NOW()+INTERVAL '2 minutes',lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('planning','running') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async claimApprovalContinuation(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',lease_until=NOW()+INTERVAL '2 minutes',lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='waiting_approval' AND pending_approval_id IS NOT NULL AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async renewLease(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET lease_until=NOW()+INTERVAL '2 minutes',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='running' AND lease_owner=$3 RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async addEvent(input:Omit<import("../../../packages/types/src/mission").FroshMissionEvent,"id"|"createdAt">){
    const id=crypto.randomUUID();
    const rows=await this.sql.unsafe<import("../../../packages/types/src/mission").FroshMissionEvent[]>(`INSERT INTO frosh_mission_events(id,mission_id,user_id,type,message,step_id,run_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id,mission_id AS "missionId",user_id AS "userId",type,message,step_id AS "stepId",run_id AS "runId",metadata,created_at AS "createdAt"`,[id,input.missionId,input.userId,input.type,input.message,input.stepId??null,input.runId??null,input.metadata?JSON.stringify(input.metadata):null]);
    return rows[0];
  }
  async listEvents(missionId:string,userId:string,limit=100){
    return this.sql.unsafe<import("../../../packages/types/src/mission").FroshMissionEvent[]>(`SELECT id,mission_id AS "missionId",user_id AS "userId",type,message,step_id AS "stepId",run_id AS "runId",metadata,created_at AS "createdAt" FROM frosh_mission_events WHERE mission_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3`,[missionId,userId,Math.min(Math.max(limit,1),500)]);
  }
  async delete(id:string,userId:string){const result=await this.sql.unsafe("DELETE FROM frosh_missions WHERE id=$1 AND user_id=$2",[id,userId]);return result.count>0;}
}

export class InMemoryMissionStore implements FroshMissionStore {
  private items=new Map<string,FroshMission>();
  private events=new Map<string,import("../../../packages/types/src/mission").FroshMissionEvent[]>();
  async list(userId:string){return [...this.items.values()].filter(x=>x.userId===userId).sort((a,b)=>{const rank=(p:string)=>p==="high"?0:p==="normal"?1:2;return rank(a.priority)-rank(b.priority)||Date.parse(b.updatedAt)-Date.parse(a.updatedAt);});}
  async get(id:string,userId:string){const x=this.items.get(id);return x?.userId===userId?x:null;}
  async create(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){const now=new Date().toISOString();const x={...input,id:crypto.randomUUID(),createdAt:now,updatedAt:now};this.items.set(x.id,x);return x;}
  async update(id:string,userId:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){const x=await this.get(id,userId);if(!x)throw new Error("Mission not found");const next={...x,...patch,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async claim(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||!["planning","running"].includes(mission.status))return null;if(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now())return null;const next={...mission,status:"running" as const,leaseUntil:new Date(Date.now()+120000).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async renewLease(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||mission.status!=="running"||mission.leaseOwner!==leaseOwner)return null;const next={...mission,leaseUntil:new Date(Date.now()+120000).toISOString(),updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async addEvent(input:Omit<import("../../../packages/types/src/mission").FroshMissionEvent,"id"|"createdAt">){
    const event={...input,id:crypto.randomUUID(),createdAt:new Date().toISOString()};
    const list=this.events.get(input.missionId)??[];
    list.unshift(event);
    this.events.set(input.missionId,list);
    return event;
  }
  async listEvents(missionId:string,userId:string,limit=100){
    const mission=await this.get(missionId,userId);
    if(!mission)return [];
    return (this.events.get(missionId)??[]).slice(0,Math.min(Math.max(limit,1),500));
  }
  async delete(id:string,userId:string){const x=await this.get(id,userId);if(!x)return false;this.items.delete(id);this.events.delete(id);return true;}
}