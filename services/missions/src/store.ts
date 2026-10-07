import postgres from "postgres";
import type { FroshMission, FroshMissionStore } from "../../../packages/types/src/mission";
type Sql=ReturnType<typeof postgres>;

const MAX_MISSION_GOAL_CHARS=12_000;
const MAX_MISSION_GOAL_BYTES=48*1024;
const MAX_MISSION_STEPS=24;
const MAX_STEP_TITLE_CHARS=500;
const MAX_STEP_CONTEXT_CHARS=12_000;
const MAX_STEP_RESULT_CHARS=16_000;
const MAX_MISSION_RESULT_CHARS=16_000;
const MAX_EVENT_MESSAGE_CHARS=4_000;
const MAX_EVENT_METADATA_BYTES=32*1024;
const MAX_MISSION_EVENTS=10_000;
const MAX_MISSION_EVENT_AGE_MS=90*24*60*60*1000;
const MAX_RESOURCE_ID_CHARS=200;
const MAX_RESOURCE_ID_BYTES=512;
const MAX_STEP_RETRY_COUNT=100;
const MAX_TOOL_CALLS=1_000_000;
const MAX_EXECUTION_DURATION_MS=7*24*60*60*1000;

export const MISSION_LEASE_MS=2*60*1000;
export const MISSION_LEASE_HEARTBEAT_MS=30*1000;
const MISSION_LEASE_SQL="NOW()+INTERVAL '2 minutes'";

function boundedText(value:string,label:string,maxChars:number,maxBytes:number):string{
  if(typeof value!=="string"||value.length>maxChars||new TextEncoder().encode(value).byteLength>maxBytes||/[\\u0000-\\u001f\\u007f]/.test(value))throw new Error(label+" exceeds safety bounds");
  return value;
}
function boundedId(value:string,label:string):string{
  return boundedText(value,label,MAX_RESOURCE_ID_CHARS,MAX_RESOURCE_ID_BYTES);
}
function validateMissionSteps(steps:FroshMission["steps"]):FroshMission["steps"]{
  if(!Array.isArray(steps)||steps.length>MAX_MISSION_STEPS)throw new Error("Mission has too many steps");
  const ids=new Set<string>();
  return steps.map((step)=>{
    if(!step||typeof step!=="object")throw new Error("Invalid mission step");
    const stepId=boundedId(step.id,"Mission step ID");
    if(ids.has(stepId))throw new Error("Mission contains duplicate step IDs");
    ids.add(stepId);
    const retryCount=step.retryCount??0;
    if(!Number.isInteger(retryCount)||retryCount<0||retryCount>MAX_STEP_RETRY_COUNT)throw new Error("Mission step retry count exceeds safety bounds");
    if(step.status!=="pending"&&step.status!=="running"&&step.status!=="completed"&&step.status!=="blocked"&&step.status!=="failed")throw new Error("Invalid mission step status");
    if(typeof step.createdAt!=="string"||!Number.isFinite(Date.parse(step.createdAt)))throw new Error("Invalid mission step creation time");
    if(typeof step.updatedAt!=="string"||!Number.isFinite(Date.parse(step.updatedAt)))throw new Error("Invalid mission step update time");
    if(step.nextRetryAt!==undefined&&(!Number.isFinite(Date.parse(step.nextRetryAt))))throw new Error("Invalid mission step retry time");
    const normalized={...step,
      id:stepId,
      retryCount,
      title:boundedText(step.title,"Mission step title",MAX_STEP_TITLE_CHARS,2*1024),
      ...(step.context!==undefined?{context:boundedText(step.context,"Mission step context",MAX_STEP_CONTEXT_CHARS,48*1024)}:{}),
      ...(step.result!==undefined?{result:boundedText(step.result,"Mission step result",MAX_STEP_RESULT_CHARS,64*1024)}:{}),
      ...(step.runId!==undefined?{runId:boundedId(step.runId,"Mission run ID")}:{}),
    };
    return normalized;
  });
}
function validateMissionInput(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){
  boundedId(input.userId,"Mission user ID");
  if(!["planning","running","waiting_approval","completed","failed","paused","cancelled"].includes(input.status))throw new Error("Invalid mission status");
  if(!["low","normal","high"].includes(input.priority))throw new Error("Invalid mission priority");
  if(!["standard","extended","intensive"].includes(input.budgetProfile))throw new Error("Invalid mission budget profile");
  boundedText(input.goal,"Mission goal",MAX_MISSION_GOAL_CHARS,MAX_MISSION_GOAL_BYTES);
  validateMissionSteps(input.steps);
  if(input.activeRunId!==undefined)boundedId(input.activeRunId,"Active run ID");
  if(input.pendingApprovalId!==undefined)boundedId(input.pendingApprovalId,"Pending approval ID");
  if(input.leaseOwner!==undefined)boundedId(input.leaseOwner,"Lease owner");
  if(input.result!==undefined)boundedText(input.result,"Mission result",MAX_MISSION_RESULT_CHARS,64*1024);
  if(!Number.isFinite(input.progress)||input.progress<0||input.progress>100)throw new Error("Mission progress exceeds safety bounds");
  if(input.toolCallsUsed!==undefined&&(!Number.isInteger(input.toolCallsUsed)||input.toolCallsUsed<0||input.toolCallsUsed>MAX_TOOL_CALLS))throw new Error("Mission tool call count exceeds safety bounds");
  if(input.executionDurationMs!==undefined&&(!Number.isInteger(input.executionDurationMs)||input.executionDurationMs<0||input.executionDurationMs>MAX_EXECUTION_DURATION_MS))throw new Error("Mission execution duration exceeds safety bounds");
}
function validateMissionPatch(patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){
  if(patch.status!==undefined&&!["planning","running","waiting_approval","completed","failed","paused","cancelled"].includes(patch.status))throw new Error("Invalid mission status");
  if(patch.priority!==undefined&&!["low","normal","high"].includes(patch.priority))throw new Error("Invalid mission priority");
  if(patch.budgetProfile!==undefined&&!["standard","extended","intensive"].includes(patch.budgetProfile))throw new Error("Invalid mission budget profile");
  if(patch.goal!==undefined)boundedText(patch.goal,"Mission goal",MAX_MISSION_GOAL_CHARS,MAX_MISSION_GOAL_BYTES);
  if(patch.steps!==undefined)validateMissionSteps(patch.steps);
  if(patch.activeRunId!==undefined)boundedId(patch.activeRunId,"Active run ID");
  if(patch.pendingApprovalId!==undefined)boundedId(patch.pendingApprovalId,"Pending approval ID");
  if(patch.leaseOwner!==undefined)boundedId(patch.leaseOwner,"Lease owner");
  if(patch.result!==undefined)boundedText(patch.result,"Mission result",MAX_MISSION_RESULT_CHARS,64*1024);
  if(patch.progress!==undefined&&(!Number.isFinite(patch.progress)||patch.progress<0||patch.progress>100))throw new Error("Mission progress exceeds safety bounds");
  if(patch.toolCallsUsed!==undefined&&(!Number.isInteger(patch.toolCallsUsed)||patch.toolCallsUsed<0||patch.toolCallsUsed>MAX_TOOL_CALLS))throw new Error("Mission tool call count exceeds safety bounds");
  if(patch.executionDurationMs!==undefined&&(!Number.isInteger(patch.executionDurationMs)||patch.executionDurationMs<0||patch.executionDurationMs>MAX_EXECUTION_DURATION_MS))throw new Error("Mission execution duration exceeds safety bounds");
}
function validateMissionEvent(input:Omit<import("../../../packages/types/src/mission").FroshMissionEvent,"id"|"createdAt">){
  boundedId(input.missionId,"Mission ID");
  boundedId(input.userId,"Mission user ID");
  boundedText(input.message,"Mission event message",MAX_EVENT_MESSAGE_CHARS,16*1024);
  if(input.stepId!==undefined)boundedId(input.stepId,"Mission step ID");
  if(input.runId!==undefined)boundedId(input.runId,"Mission run ID");
  if(input.metadata!==undefined&&new TextEncoder().encode(JSON.stringify(input.metadata)).byteLength>MAX_EVENT_METADATA_BYTES)throw new Error("Mission event metadata exceeds safety bounds");
}


const SELECT_FIELDS=`id,user_id AS "userId",goal,status,priority,budget_profile AS "budgetProfile",progress,steps,active_run_id AS "activeRunId",pending_approval_id AS "pendingApprovalId",lease_until AS "leaseUntil",lease_owner AS "leaseOwner",result,tool_calls_used AS "toolCallsUsed",execution_duration_ms AS "executionDurationMs",created_at AS "createdAt",updated_at AS "updatedAt"`;

export class PostgresMissionStore implements FroshMissionStore {
  constructor(private readonly sql:Sql){}
  async list(userId:string){return this.sql.unsafe<FroshMission[]>(`SELECT ${SELECT_FIELDS} FROM frosh_missions WHERE user_id=$1 ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, updated_at DESC`,[userId]);}
  async get(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`SELECT ${SELECT_FIELDS} FROM frosh_missions WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,userId]);return rows[0]??null;}
  async create(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){
    validateMissionInput(input);
    const configuredLimit=Number(process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER??50);
    const maxActive=Number.isFinite(configuredLimit)?Math.min(500,Math.max(1,Math.floor(configuredLimit))):50;
    const id=crypto.randomUUID();
    return this.sql.begin(async(tx)=>{
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))",[input.userId]);
      const countRows=await tx.unsafe<{count:string}[]>(
        "SELECT COUNT(*)::text AS count FROM frosh_missions WHERE user_id=$1 AND status NOT IN ('completed','failed','cancelled')",
        [input.userId]
      );
      if(Number(countRows[0]?.count??0)>=maxActive)return null;
      const rows=await tx.unsafe<FroshMission[]>(`INSERT INTO frosh_missions(id,user_id,goal,status,priority,budget_profile,progress,steps,active_run_id,pending_approval_id,lease_until,lease_owner,result,tool_calls_used,execution_duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING ${SELECT_FIELDS}`,[id,input.userId,input.goal,input.status,input.priority,input.budgetProfile,input.progress,JSON.stringify(input.steps),input.activeRunId??null,input.pendingApprovalId??null,input.leaseUntil??null,input.leaseOwner??null,input.result??null,input.toolCallsUsed??0,input.executionDurationMs??0]);
      return rows[0];
    });
  }
  async update(id:string,userId:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){
    validateMissionPatch(patch);
    const activeStatus=patch.status!==undefined&&!["completed","failed","cancelled"].includes(patch.status);
    const current=patch.status!==undefined&&activeStatus?await this.get(id,userId):null;
    const needsQuotaFence=Boolean(current&&["completed","failed","cancelled"].includes(current.status));
    const apply=async(executor:Sql)=>{
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
        ? `UPDATE frosh_missions SET ${setClause},updated_at=NOW() WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`
        : `UPDATE frosh_missions SET updated_at=NOW() WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`;
      const rows=await executor.unsafe<FroshMission[]>(sql,values);
      return rows[0]??null;
    };
    let updated:FroshMission|null=null;
    if(needsQuotaFence){
      const configuredLimit=Number(process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER??50);
      const maxActive=Number.isFinite(configuredLimit)?Math.min(500,Math.max(1,Math.floor(configuredLimit))):50;
      updated=await this.sql.begin(async(tx)=>{
        await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))",[userId]);
        const locked=await tx.unsafe<{status:FroshMission["status"]}[]>("SELECT status FROM frosh_missions WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,userId]);
        if(!locked[0])return null;
        if(["completed","failed","cancelled"].includes(locked[0].status)){
          const countRows=await tx.unsafe<{count:string}[]>("SELECT COUNT(*)::text AS count FROM frosh_missions WHERE user_id=$1 AND status NOT IN ('completed','failed','cancelled')",[userId]);
          if(Number(countRows[0]?.count??0)>=maxActive)throw new Error("Mission limit reached for this user");
        }
        return apply(tx);
      });
    }else{
      updated=await apply(this.sql);
    }
    if(updated)return updated;
    const existing=await this.get(id,userId);
    if(!existing)throw new Error("Mission not found");
    throw new Error("Mission is currently executing");
  }
  async updateOwned(id:string,userId:string,leaseOwner:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){validateMissionPatch(patch);boundedId(leaseOwner,"Lease owner");
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
    validateMissionSteps(steps);boundedId(leaseOwner,"Lease owner");
    const configuredLimit=Number(process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER??50);
    const maxActive=Number.isFinite(configuredLimit)?Math.min(500,Math.max(1,Math.floor(configuredLimit))):50;
    return this.sql.begin(async(tx)=>{
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))",[userId]);
      const countRows=await tx.unsafe<{count:string}[]>("SELECT COUNT(*)::text AS count FROM frosh_missions WHERE user_id=$1 AND status NOT IN ('completed','failed','cancelled')",[userId]);
      if(Number(countRows[0]?.count??0)>=maxActive)return null;
      const rows=await tx.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',steps=$4::jsonb,lease_until=${MISSION_LEASE_SQL},lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='failed' AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner,JSON.stringify(steps)]);
      return rows[0]??null;
    });
  }
  async claim(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',lease_until=${MISSION_LEASE_SQL},lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('planning','running') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async claimStepRetry(id:string,userId:string,leaseOwner:string){
    boundedId(leaseOwner,"Lease owner");
    const configuredLimit=Number(process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER??50);
    const maxActive=Number.isFinite(configuredLimit)?Math.min(500,Math.max(1,Math.floor(configuredLimit))):50;
    return this.sql.begin(async(tx)=>{
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))",[userId]);
      const current=await tx.unsafe<{status:FroshMission["status"]}[]>("SELECT status FROM frosh_missions WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,userId]);
      if(!current[0]||["completed","cancelled","waiting_approval"].includes(current[0].status))return null;
      if(current[0].status==="failed"){
        const countRows=await tx.unsafe<{count:string}[]>("SELECT COUNT(*)::text AS count FROM frosh_missions WHERE user_id=$1 AND status NOT IN ('completed','failed','cancelled')",[userId]);
        if(Number(countRows[0]?.count??0)>=maxActive)return null;
      }
      const rows=await tx.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',lease_until=${MISSION_LEASE_SQL},lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status NOT IN ('completed','cancelled','waiting_approval') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
      return rows[0]??null;
    });
  }
  async claimApprovalContinuation(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='running',lease_until=${MISSION_LEASE_SQL},lease_owner=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='waiting_approval' AND pending_approval_id IS NOT NULL AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async pauseIfIdle(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='paused',lease_until=NULL,lease_owner=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status NOT IN ('completed','failed','cancelled') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId]);return rows[0]??null;}
  async resumeIfPaused(id:string,userId:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status=CASE WHEN pending_approval_id IS NOT NULL THEN 'waiting_approval' ELSE 'running' END,result=NULL,lease_until=NULL,lease_owner=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='paused' RETURNING ${SELECT_FIELDS}`,[id,userId]);
    return rows[0]??null;
  }
  async cancelIfIdle(id:string,userId:string){const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET status='cancelled',lease_until=NULL,lease_owner=NULL,pending_approval_id=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status NOT IN ('completed','cancelled') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING ${SELECT_FIELDS}`,[id,userId]);return rows[0]??null;}
  async renewLease(id:string,userId:string,leaseOwner:string){
    const rows=await this.sql.unsafe<FroshMission[]>(`UPDATE frosh_missions SET lease_until=${MISSION_LEASE_SQL},updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='running' AND lease_owner=$3 AND lease_until>NOW() RETURNING ${SELECT_FIELDS}`,[id,userId,leaseOwner]);
    return rows[0]??null;
  }
  async releaseLeaseIfOwned(id:string,userId:string,leaseOwner:string){
    const result=await this.sql.unsafe(`UPDATE frosh_missions SET lease_until=NULL,lease_owner=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND lease_owner=$3`,[id,userId,leaseOwner]);
    return result.count>0;
  }
  async addEvent(input:Omit<import("../../../packages/types/src/mission").FroshMissionEvent,"id"|"createdAt">){validateMissionEvent(input);
    const id=crypto.randomUUID();
    const mission=await this.sql.unsafe<{id:string;steps:import("../../../packages/types/src/mission").FroshMissionStep[]}[]>(`SELECT id,steps FROM frosh_missions WHERE id=$1 AND user_id=$2 LIMIT 1`,[input.missionId,input.userId]);
    if(!mission[0]) throw new Error("Mission not found for event");
    if(input.stepId && !mission[0].steps.some(step=>step.id===input.stepId)) throw new Error("Mission step not found for event");
    if(input.runId && input.stepId){
      const step=mission[0].steps.find(item=>item.id===input.stepId);
      if(step?.runId && step.runId!==input.runId) throw new Error("Agent run does not match mission step for event");
    }
    const rows=await this.sql.begin(async(tx)=>{
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))",[input.missionId]);
      const inserted=await tx.unsafe<import("../../../packages/types/src/mission").FroshMissionEvent[]>(`INSERT INTO frosh_mission_events(id,mission_id,user_id,type,message,step_id,run_id,metadata)
        SELECT $1,m.id,$3,$4,$5,$6,$7,$8::jsonb
        FROM frosh_missions m
        WHERE m.id=$2 AND m.user_id=$3
        RETURNING id,mission_id AS "missionId",user_id AS "userId",type,message,step_id AS "stepId",run_id AS "runId",metadata,created_at AS "createdAt"`,[id,input.missionId,input.userId,input.type,input.message,input.stepId??null,input.runId??null,input.metadata?JSON.stringify(input.metadata):null]);
      if(!inserted[0]) throw new Error("Mission not found for event");
      await tx.unsafe(`WITH ranked AS (
        SELECT id,ROW_NUMBER() OVER (ORDER BY created_at DESC,id DESC) AS row_num
        FROM frosh_mission_events WHERE mission_id=$1 AND user_id=$2
      ) DELETE FROM frosh_mission_events e USING ranked r
        WHERE e.id=r.id AND (r.row_num>$3 OR e.created_at<NOW()-INTERVAL '90 days')`,[input.missionId,input.userId,MAX_MISSION_EVENTS]);
      return inserted[0];
    });
    return rows;
  }
  async listEvents(missionId:string,userId:string,limit=100){
    return this.sql.unsafe<import("../../../packages/types/src/mission").FroshMissionEvent[]>(`SELECT id,mission_id AS "missionId",user_id AS "userId",type,message,step_id AS "stepId",run_id AS "runId",metadata,created_at AS "createdAt" FROM frosh_mission_events WHERE mission_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3`,[missionId,userId,Math.min(Math.max(limit,1),500)]);
  }
  async delete(id:string,userId:string){
    return this.deleteIfIdle(id,userId);
  }
  async deleteIfIdle(id:string,userId:string){const result=await this.sql.unsafe("DELETE FROM frosh_missions WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until<NOW())",[id,userId]);return result.count>0;}
}

export class InMemoryMissionStore implements FroshMissionStore {
  private items=new Map<string,FroshMission>();
  private events=new Map<string,import("../../../packages/types/src/mission").FroshMissionEvent[]>();
  async list(userId:string){return [...this.items.values()].filter(x=>x.userId===userId).sort((a,b)=>{const rank=(p:string)=>p==="high"?0:p==="normal"?1:2;return rank(a.priority)-rank(b.priority)||Date.parse(b.updatedAt)-Date.parse(a.updatedAt);});}
  async get(id:string,userId:string){const x=this.items.get(id);return x?.userId===userId?x:null;}
  async create(input:Omit<FroshMission,"id"|"createdAt"|"updatedAt">){
    validateMissionInput(input);
    const configuredLimit=Number(process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER??50);
    const maxActive=Number.isFinite(configuredLimit)?Math.min(500,Math.max(1,Math.floor(configuredLimit))):50;
    const activeCount=[...this.items.values()].filter((mission)=>mission.userId===input.userId&&!["completed","failed","cancelled"].includes(mission.status)).length;
    if(activeCount>=maxActive)return null;
    const now=new Date().toISOString();
    const x={...input,id:crypto.randomUUID(),createdAt:now,updatedAt:now};
    this.items.set(x.id,x);
    return x;
  }
  async update(id:string,userId:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){
    validateMissionPatch(patch);
    const x=await this.get(id,userId);
    if(!x)throw new Error("Mission not found");
    if(x.leaseUntil&&Date.parse(x.leaseUntil)>Date.now())throw new Error("Mission is currently executing");
    const nextStatus=patch.status??x.status;
    if(["completed","failed","cancelled"].includes(x.status)&&!["completed","failed","cancelled"].includes(nextStatus)){
      const configuredLimit=Number(process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER??50);
      const maxActive=Number.isFinite(configuredLimit)?Math.min(500,Math.max(1,Math.floor(configuredLimit))):50;
      const activeCount=[...this.items.values()].filter((mission)=>mission.userId===userId&&!["completed","failed","cancelled"].includes(mission.status)).length;
      if(activeCount>=maxActive)throw new Error("Mission limit reached for this user");
    }
    const next={...x,...patch,updatedAt:new Date().toISOString()};
    this.items.set(id,next);
    return next;
  }
  async updateOwned(id:string,userId:string,leaseOwner:string,patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>){validateMissionPatch(patch);boundedId(leaseOwner,"Lease owner");const current=await this.get(id,userId);if(!current||current.leaseOwner!==leaseOwner||!current.leaseUntil||Date.parse(current.leaseUntil)<=Date.now())return null;const next={...current,...patch,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async updatePriorityIfIdle(id:string,userId:string,priority:FroshMission["priority"]){const mission=await this.get(id,userId);if(!mission||["completed","cancelled"].includes(mission.status)||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,priority,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async updateBudgetProfileIfIdle(id:string,userId:string,budgetProfile:FroshMission["budgetProfile"]){const mission=await this.get(id,userId);if(!mission||["completed","cancelled"].includes(mission.status)||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,budgetProfile,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async recoverFailedIfIdle(id:string,userId:string,leaseOwner:string,steps:FroshMission["steps"]){validateMissionSteps(steps);boundedId(leaseOwner,"Lease owner");const mission=await this.get(id,userId);if(!mission||mission.status!=="failed"||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const configuredLimit=Number(process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER??50);const maxActive=Number.isFinite(configuredLimit)?Math.min(500,Math.max(1,Math.floor(configuredLimit))):50;const activeCount=[...this.items.values()].filter((item)=>item.userId===userId&&!["completed","failed","cancelled"].includes(item.status)).length;if(activeCount>=maxActive)return null;const next={...mission,status:"running" as const,steps,leaseUntil:new Date(Date.now()+MISSION_LEASE_MS).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async claim(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||!["planning","running"].includes(mission.status))return null;if(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now())return null;const next={...mission,status:"running" as const,leaseUntil:new Date(Date.now()+MISSION_LEASE_MS).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async claimStepRetry(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||["completed","cancelled","waiting_approval"].includes(mission.status))return null;if(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now())return null;if(mission.status==="failed"){const configuredLimit=Number(process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER??50);const maxActive=Number.isFinite(configuredLimit)?Math.min(500,Math.max(1,Math.floor(configuredLimit))):50;const activeCount=[...this.items.values()].filter((item)=>item.userId===userId&&!["completed","failed","cancelled"].includes(item.status)).length;if(activeCount>=maxActive)return null;}const next={...mission,status:"running" as const,leaseUntil:new Date(Date.now()+MISSION_LEASE_MS).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async claimApprovalContinuation(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||mission.status!=="waiting_approval"||!mission.pendingApprovalId)return null;if(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now())return null;const next={...mission,status:"running" as const,leaseUntil:new Date(Date.now()+MISSION_LEASE_MS).toISOString(),leaseOwner,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async pauseIfIdle(id:string,userId:string){const mission=await this.get(id,userId);if(!mission||["completed","failed","cancelled"].includes(mission.status)||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,status:"paused" as const,leaseUntil:undefined,leaseOwner:undefined,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async resumeIfPaused(id:string,userId:string){const mission=await this.get(id,userId);if(!mission||mission.status!=="paused")return null;const next={...mission,status:(mission.pendingApprovalId?"waiting_approval":"running") as FroshMission["status"],result:undefined,leaseUntil:undefined,leaseOwner:undefined,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async cancelIfIdle(id:string,userId:string){const mission=await this.get(id,userId);if(!mission||["completed","cancelled"].includes(mission.status)||(mission.leaseUntil&&Date.parse(mission.leaseUntil)>Date.now()))return null;const next={...mission,status:"cancelled" as const,leaseUntil:undefined,leaseOwner:undefined,pendingApprovalId:undefined,updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async renewLease(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||mission.status!=="running"||mission.leaseOwner!==leaseOwner||!mission.leaseUntil||Date.parse(mission.leaseUntil)<=Date.now())return null;const next={...mission,leaseUntil:new Date(Date.now()+MISSION_LEASE_MS).toISOString(),updatedAt:new Date().toISOString()};this.items.set(id,next);return next;}
  async releaseLeaseIfOwned(id:string,userId:string,leaseOwner:string){const mission=await this.get(id,userId);if(!mission||mission.leaseOwner!==leaseOwner)return false;const next={...mission,leaseUntil:undefined,leaseOwner:undefined,updatedAt:new Date().toISOString()};this.items.set(id,next);return true;}
  async addEvent(input:Omit<import("../../../packages/types/src/mission").FroshMissionEvent,"id"|"createdAt">){
    const mission=await this.get(input.missionId,input.userId);
    if(!mission) throw new Error("Mission not found for event");
    if(input.stepId && !mission.steps.some(step=>step.id===input.stepId)) throw new Error("Mission step not found for event");
    if(input.runId && input.stepId){
      const step=mission.steps.find(item=>item.id===input.stepId);
      if(step && step.runId && step.runId!==input.runId) throw new Error("Agent run does not match mission step for event");
    }
    const event={...input,id:crypto.randomUUID(),createdAt:new Date().toISOString()};
    const cutoff=Date.now()-MAX_MISSION_EVENT_AGE_MS;
    const list=[event,...(this.events.get(input.missionId)??[])].filter(item=>Date.parse(item.createdAt)>=cutoff).slice(0,MAX_MISSION_EVENTS);
    this.events.set(input.missionId,list);
    return event;
  }
  async listEvents(missionId:string,userId:string,limit=100){
    const mission=await this.get(missionId,userId);
    if(!mission)return [];
    return (this.events.get(missionId)??[]).slice(0,Math.min(Math.max(limit,1),500));
  }
  async delete(id:string,userId:string){return this.deleteIfIdle(id,userId);}
  async deleteIfIdle(id:string,userId:string){const x=await this.get(id,userId);if(!x||(x.leaseUntil&&Date.parse(x.leaseUntil)>Date.now()))return false;this.items.delete(id);this.events.delete(id);return true;}
}