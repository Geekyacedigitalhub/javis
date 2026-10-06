import postgres from "postgres";
import type { FroshMission, FroshMissionStore } from "../../../packages/types/src/mission";
type Sql=ReturnType<typeof postgres>;

const SELECT_FIELDS=`id,user_id AS "userId",goal,status,priority,budget_profile AS "budgetProfile",progress,steps,active_run_id AS "activeRunId",pending_approval_id AS "pendingApprovalId",lease_until AS "leaseUntil",lease_owner AS "leaseOwner",result,tool_calls_used AS "toolCallsUsed",execution_duration_ms AS "executionDurationMs",created_at AS "createdAt",updated_at AS "updatedAt"`;

export class PostgresMissionStore implements FroshMissionStore {
  constructor(private readonly sql:Sql){}
  async list(userId:string){return this.sql.unsafe<FroshMission[]>(`SELECT ${SELECT_FIELDS} FROM frosh_missions WHERE user_id=$1 ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, updated_at DESC`,[userId]);}
  async get(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`SELECT ${SELECT_FIELDS} FROM frosh_missions WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,userId]);return rows[0]??null;}
  async create(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){const id=crypto.randomUUID();const rows=await this.sql.unsafe<FroshMission[]>(`INSERT INTO frosh_missions(id,user_id,goal,status,priority,budget_profile,progress,steps,active_run_id,pending_approval_id,lease_until,lease_owner,result,tool_calls_used,execution_duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING ${SELECT_FIELDS}`,[id,input.userId,input.goal,input.status,input.priority,input.budgetProfile,input.progress,JSON.stringify(input.steps),input.activeRunId??null,input.pendingApprovalId??null,input.leaseUntil??null,input.leaseOwner??null,input.result??null,input.toolCallsUsed??0,input.executionDurationMs??0]);return rows[0];}
  async update(id:string,userId:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){
    const fields:string[]=[];
    const values:unknown[]=[id,userId];
    const add=(column:string,value:unknown)=>{
      fields.push(column+"=$"+String(values.length+1));
      values.push(value);
    };
    if(Object.prototype.hasOwnProperty.call(patch,"goal"))add("goal",patch.goal);
    if(Object.prototype.hasOwnProperty.call(patch,"status"))add("status",patch.status);
    if(Object.prototype.hasOwnProperty.call(patch,"priority"))add("priority",patch.priority);
    if(Object.prototype.hasOwnProperty.call(patch,"budgetProfile"))add("budget_profile",patch.budgetProfile);
    if(Object.prototype.hasOwnProperty.call(patch,"progress"))add("progress",patch.progress);
    if(Object.prototype.hasOwnProperty.call(patch,"steps"))add("steps",JSON.stringify(patch.steps));
    if(Object.prototype.hasOwnProperty.call(patch,"activeRunId"))add("active_run_id",patch.activeRunId??null);
    if(Object.prototype.hasOwnProperty.call(patch,"pendingApprovalId"))add("pending_approval_id",patch.pendingApprovalId??null);
    if(Object.prototype.hasOwnProperty.call(patch,"leaseUntil"))add("lease_until",patch.leaseUntil??null);
    if(Object.prototype.hasOwnProperty.call(patch,"leaseOwner"))add("lease_owner",patch.leaseOwner??null);
    if(Object.prototype.hasOwnProperty.call(patch,"result"))add("result",patch.result??null);
    if(Object.prototype.hasOwnProperty.call(patch,"toolCallsUsed"))add("tool_calls_used",patch.toolCallsUsed);
    if(Object.prototype.hasOwnProperty.call(patch,"executionDurationMs"))add("execution_duration_ms",patch.executionDurationMs);
    const setClause=fields.map(field=>field.startsWith("steps=")?field+"::jsonb":field).join(",");
    const sql=setClause
      ? `UPDATE frosh_missions SET ${setClause},updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING ${SELECT_FIELDS}`
      : `UPDATE frosh_missions SET updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING ${SELECT_FIELDS}`;
    const rows=await this.sql.unsafe<FroshMission[]>(sql,values);
    if(!rows[0])throw new Error("Mission not found");
    return rows[0];
  }
  async updateOwned(id:string,userId:string,leaseOwner:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){
    const fields:string[]=[];
    const values:unknown[]=[id,userId];
    const add=(column:string,value:unknown,transform?:(value:unknown)=>unknown)=>{
      fields.push(column+"=$"+String(values.length+1));
      values.push(transform?transform(value):value);
    };
    if(Object.prototype.hasOwnProperty.call(patch,"goal"))add("goal",patch.goal);
    if(Object.prototype.hasOwnProperty.call(patch,"status"))add("status",patch.status);
    if(Object.prototype.hasOwnProperty.call(patch,"priority"))add("priority",patch.priority);
    if(Object.prototype.hasOwnProperty.call(patch,"budgetProfile"))add("budget_profile",patch.budgetProfile);
    if(Object.prototype.hasOwnProperty.call(patch,"progress"))add("progress",patch.progress);
    if(Object.prototype.hasOwnProperty.call(patch,"steps"))add("steps",JSON.stringify(patch.steps));
    if(Object.prototype.hasOwnProperty.call(patch,"activeRunId"))add("active_run_id",patch.activeRunId??null);
    if(Object.prototype.hasOwnProperty.call(patch,"pendingApprovalId"))add("pending_approval_id",patch.pendingApprovalId??null);
    if(Object.prototype.hasOwnProperty.call(patch,"leaseUntil"))add("lease_until",patch.leaseUntil??null);
    if(Object.prototype.hasOwnProperty.call(patch,"leaseOwner"))add("lease_owner",patch.leaseOwner??null);
    if(Object.prototype.hasOwnProperty.call(patch,"result"))add("result",patch.result??null);
    if(Object.prototype.hasOwnProperty.call(patch,"toolCallsUsed"))add("tool_calls_used",patch.toolCallsUsed);
    if(Object.prototype.hasOwnProperty.call(patch,"executionDurationMs"))add("execution_duration_ms",patch.executionDurationMs);
    const setClause=fields.map((field)=>field.startsWith("steps=")?field+"::jsonb":field).join(",");
    const where=[`id=$1`,`user_id=$2`,`lease_owner=${values.length+1}`,`lease_until>NOW()`].join(" AND ");
    values.push(leaseOwner);
    const sql=setClause
      ? `UPDATE frosh_missions SET ${setClause},updated_at=NOW() WHERE ${where} RETURNING ${SELECT_FIELDS}`
      : `UPDATE frosh_missions SET updated_at=NOW() WHERE ${where} RETURNING ${SELECT_FIELDS}`;
    const rows=await this.sql.unsafe<FroshMission[]>(sql,values);
    return rows[0]??null;
  }
  async updatePriorityIfIdle(id:string,userId:string,priority:FroshMission["priority"]){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET priority=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until<NOW()) AND status NOT IN ('completed','cancelled') RETURNING ${SELECT_FIELDS}`,[id,userId,priority]);
    return rows[0]??null;
  }
  async updateBudgetProfileIfIdle(id:string,userId:string,budgetProfile:FroshMission["budgetProfile"]){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET budget_profile=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until<NOW()) AND status NOT IN ('completed','cancelled') RETURNING ${SELECT_FIELDS}`,[id,userId,budgetProfile]);
    return rows[0]??null;
  }
  async recoverFailedIfIdle(id:string,userId:string,leaseOwner:string,steps:FroshMission["steps"]){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',steps=$4::jsonb,lease_until=NOW()+INTERVAL '2 minutes',lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='failed' AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner,JSON.stringify(steps)]);
    return rows[0]??null;
  }
  async claim(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',lease_until=NOW()+INTERVAL '2 minutes',lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('planning','running') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async claimStepRetry(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',lease_until=NOW()+INTERVAL '2 minutes',lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status NOT IN ('completed','cancelled','waiting_approval') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async claimApprovalContinuation(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',lease_until=NOW()+INTERVAL '2 minutes',lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='waiting_approval' AND pending_approval_id IS NOT NULL AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async pauseIfIdle(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='paused',lease_until=NULL,lease_owner=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status NOT IN ('completed','failed','cancelled') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId]);return rows[0]??null;}
  async resumeIfPaused(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',result=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='paused' RETURNING ${SELECT_FIELDS}`,[id,userId]);return rows[0]??null;}
  async cancelIfIdle(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='cancelled',lease_until=NULL,lease_owner=NULL,pending_approval_id=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status NOT IN ('completed','cancelled') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId]);return rows[0]??null;}
  async renewLease(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET lease_until=NOW()+INTERVAL '2 minutes',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='running' AND lease_owner=$3 AND lease_until>NOW() RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async releaseLeaseIfOwned(id:string,userId:string,leaseOwner:string){
    const result=await this.sql.unsafe(`UPDATE frosh_missions SET lease_until=NULL,lease_owner=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND lease_owner=$3`,[id,userId,leaseOwner]);
    return result.count>0;
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
  async deleteIfIdle(id:string,userId:string){const result=await this.sql.unsafe("DELETE FROM frosh_missions WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until<NOW())",[id,userId]);return result.count>0;}
}

export class InMemoryMissionStore implements FroshMissionStore {
  private items=new Map<string,FroshMission>();
  private events=new Map<string,import("../../../packages/types/src/mission").FroshMissionEvent[]>();
  async list(userId:string){return [...this.items.values()].filter(x=>x.userId===userId).sort((a,b)=>{const rank=(p:string)=>p==="high"?0:p==="normal"?1:2;return rank(a.priority)-rank(b.priority)||Date.parse(b.updatedAt)-Date.parse(a.updatedAt);});}
  async get(id:string,userId:string){const x=this.items.get(id);return x?.userId===userId?x:null;}
  async create(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){const now=new Date().toISOString();const x={...input,id:crypto.randomUUID(),createdAt:now,updatedAt:now};this.items.set(x.id,x);return x;}
  async update(id:string,userId:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){const x=await this.get(id,userId);if(!x)throw new Error("Mission not found");const next={...x,...patch,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async updateOwned(id:string,userId:string,leaseOwner:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){const current=await this.get(id,userId);if(!current||current.leaseOwner!==leaseOwner||!current.leaseUntil||Date.parse(current.leaseUntil)<=Date.now())return null;const next={...current,...patch,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async updatePriorityIfIdle(id:string,userId:string,priority:FroshMission["priority"]){const mission=await this.get(id,userId);if(!mission||["completed","cancelled"].includes(mission.status)||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,priority,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async updateBudgetProfileIfIdle(id:string,userId:string,budgetProfile:FroshMission["budgetProfile"]){const mission=await this.get(id,userId);if(!mission||["completed","cancelled"].includes(mission.status)||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,budgetProfile,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async recoverFailedIfIdle(id:string,userId:string,leaseOwner:string,steps:FroshMission["steps"]){const mission=await this.get(id,userId);if(!mission||mission.status!=="failed"||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,status:"running" as const,steps,leaseUntil:new Date(Date.now()+120000).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async claim(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||!["planning","running"].includes(mission.status))return null;if(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now())return null;const next={...mission,status:"running" as const,leaseUntil:new Date(Date.now()+120000).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async claimStepRetry(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||["completed","cancelled","waiting_approval"].includes(mission.status))return null;if(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now())return null;const next={...mission,status:"running" as const,leaseUntil:new Date(Date.now()+120000).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async claimApprovalContinuation(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||mission.status!=="waiting_approval"||!mission.pendingApprovalId)return null;if(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now())return null;const next={...mission,status:"running" as const,leaseUntil:new Date(Date.now()+120000).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async pauseIfIdle(id:string,userId:string){const mission=await this.get(id,userId);if(!mission||["completed","failed","cancelled"].includes(mission.status)||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,status:"paused" as const,leaseUntil:undefined,leaseOwner:undefined,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async resumeIfPaused(id:string,userId:string){const mission=await this.get(id,userId);if(!mission||mission.status!=="paused")return null;const next={...mission,status:"running" as const,result:undefined,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async cancelIfIdle(id:string,userId:string){const mission=await this.get(id,userId);if(!mission||["completed","cancelled"].includes(mission.status)||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,status:"cancelled" as const,leaseUntil:undefined,leaseOwner:undefined,pendingApprovalId:undefined,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async renewLease(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||mission.status!=="running"||mission.leaseOwner!==leaseOwner||!mission.leaseUntil||Date.parse(mission.leaseUntil)<=Date.now())return null;const next={...mission,leaseUntil:new Date(Date.now()+120000).toISOString(),updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async releaseLeaseIfOwned(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||mission.leaseOwner!==leaseOwner)return false;const next={...mission,leaseUntil:undefined,leaseOwner:undefined,updatedAt:new Date().toISOString()};this.items.set(id,next);return true;}
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
  async deleteIfIdle(id:string,userId:string){const x=await this.get(id,userId);if(!x||(x.leaseUntil&&Date.parse(x.leaseUntil)>Date.now()))return false;this.items.delete(id);this.events.delete(id);return true;}
}