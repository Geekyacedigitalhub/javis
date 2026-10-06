import postgres from "postgres";
import type { FroshAutomation, FroshAutomationStore } from "../../../packages/types/src/automation";

type Sql = ReturnType<typeof postgres>;

export class PostgresAutomationStore implements FroshAutomationStore {
  constructor(private readonly sql: Sql) {}

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async list(userId: string) {
    const rows = await this.sql.unsafe<FroshAutomation[]>(
      `SELECT id, user_id AS "userId", name, prompt, schedule, status,
        next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
       FROM frosh_automations WHERE user_id=$1 ORDER BY next_run_at NULLS LAST, created_at DESC`,
      [userId]
    );
    return rows;
  }

  async get(id: string, userId: string) {
    const rows = await this.sql.unsafe<FroshAutomation[]>(
      `SELECT id, user_id AS "userId", name, prompt, schedule, status,
        next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
       FROM frosh_automations WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [id, userId]
    );
    return rows[0] ?? null;
  }

  async create(input: Omit<FroshAutomation, "id" | "createdAt" | "updatedAt">) {
    const id = crypto.randomUUID();
    const rows = await this.sql.unsafe<FroshAutomation[]>(
      `INSERT INTO frosh_automations
       (id,user_id,name,prompt,schedule,status,next_run_at,last_run_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       RETURNING id,user_id AS "userId",name,prompt,schedule,status,
       next_run_at AS "nextRunAt",last_run_at AS "lastRunAt",
       created_at AS "createdAt",updated_at AS "updatedAt"`,
      [id,input.userId,input.name,input.prompt,JSON.stringify(input.schedule),input.status,input.nextRunAt ?? null,input.lastRunAt ?? null]
    );
    return rows[0];
  }

  async update(id: string, userId: string, patch: Partial<Pick<FroshAutomation, "name" | "prompt" | "schedule" | "status" | "nextRunAt" | "lastRunAt">>) {
    const current = await this.get(id, userId);
    if (!current) throw new Error("Automation not found");
    const updated = await this.updateIfIdle(id, userId, patch);
    if (!updated) throw new Error("Automation is currently executing");
    return updated;
  }

  private async getForMutation(id: string, userId: string) {
    const rows = await this.sql.unsafe<FroshAutomation[]>(
      `SELECT id,user_id AS "userId",name,prompt,schedule,status,
        next_run_at AS "nextRunAt",last_run_at AS "lastRunAt",
        lease_owner AS "leaseOwner",lease_until AS "leaseUntil",
        created_at AS "createdAt",updated_at AS "updatedAt"
       FROM frosh_automations WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [id,userId]
    );
    return rows[0] ?? null;
  }

  async updateIfIdle(id: string, userId: string, patch: Partial<Pick<FroshAutomation, "name" | "prompt" | "schedule" | "status" | "nextRunAt" | "lastRunAt">>) {
    const current = await this.get(id, userId);
    if (!current) return null;
    const next = { ...current, ...patch };
    const rows = await this.sql.unsafe<FroshAutomation[]>(
      `UPDATE frosh_automations SET name=$3,prompt=$4,schedule=$5::jsonb,status=$6,next_run_at=$7,last_run_at=$8,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until <= NOW())
       RETURNING id,user_id AS "userId",name,prompt,schedule,status,next_run_at AS "nextRunAt",last_run_at AS "lastRunAt",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [id,userId,next.name,next.prompt,JSON.stringify(next.schedule),next.status,next.nextRunAt ?? null,next.lastRunAt ?? null]
    );
    return rows[0] ?? null;
  }

  async updateOwned(id: string, userId: string, owner: string, patch: Partial<Pick<FroshAutomation, "name" | "prompt" | "schedule" | "status" | "nextRunAt" | "lastRunAt">>) {
    const current = await this.getForMutation(id, userId);
    if (!current || current.leaseOwner !== owner || !current.leaseUntil || Date.parse(current.leaseUntil) <= Date.now()) return null;
    const next = { ...current, ...patch };
    const rows = await this.sql.unsafe<FroshAutomation[]>(
      `UPDATE frosh_automations SET name=$3,prompt=$4,schedule=$5::jsonb,status=$6,next_run_at=$7,last_run_at=$8,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND lease_owner=$9 AND lease_until > NOW()
       RETURNING id,user_id AS "userId",name,prompt,schedule,status,next_run_at AS "nextRunAt",last_run_at AS "lastRunAt",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [id,userId,next.name,next.prompt,JSON.stringify(next.schedule),next.status,next.nextRunAt ?? null,next.lastRunAt ?? null,owner]
    );
    return rows[0] ?? null;
  }

  async deleteIfIdle(id: string, userId: string) {
    const result = await this.sql.unsafe("DELETE FROM frosh_automations WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until <= NOW())",[id,userId]);
    return result.count > 0;
  }

  async claimDue(id: string, userId: string, owner: string, leaseMs: number) {
    const rows = await this.sql.unsafe<FroshAutomation[]>(
      `UPDATE frosh_automations
       SET lease_owner=$3, lease_until=NOW() + ($4 * INTERVAL '1 millisecond'), updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='active'
         AND next_run_at IS NOT NULL AND next_run_at <= NOW()
         AND (lease_until IS NULL OR lease_until <= NOW())
       RETURNING id,user_id AS "userId",name,prompt,schedule,status,
       next_run_at AS "nextRunAt",last_run_at AS "lastRunAt",
       lease_owner AS "leaseOwner",lease_until AS "leaseUntil",
       created_at AS "createdAt",updated_at AS "updatedAt"`,
      [id,userId,owner,leaseMs]
    );
    return rows[0] ?? null;
  }

  async renewLease(id: string, userId: string, owner: string, leaseMs: number) {
    const result = await this.sql.unsafe(
      `UPDATE frosh_automations
       SET lease_until=NOW() + ($4 * INTERVAL '1 millisecond'), updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND lease_owner=$3 AND lease_until > NOW()`,
      [id,userId,owner,leaseMs]
    );
    return result.count > 0;
  }

  async releaseLease(id: string, userId: string, owner: string) {
    const result = await this.sql.unsafe(
      `UPDATE frosh_automations SET lease_owner=NULL, lease_until=NULL, updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND lease_owner=$3`,
      [id,userId,owner]
    );
    return result.count > 0;
  }

  async delete(id: string, userId: string) {
    return this.deleteIfIdle(id, userId);
  }
}

export class InMemoryAutomationStore implements FroshAutomationStore {
  private items = new Map<string,FroshAutomation>();

  async list(userId:string){ return [...this.items.values()].filter(x=>x.userId===userId).sort((a,b)=>Date.parse(a.nextRunAt??"9999")-Date.parse(b.nextRunAt??"9999")); }
  async get(id:string,userId:string){ const item=this.items.get(id); return item?.userId===userId ? item : null; }
  async create(input:Omit<FroshAutomation,"id"|"createdAt"|"updatedAt">){
    const now=new Date().toISOString();
    const item={...input,id:crypto.randomUUID(),createdAt:now,updatedAt:now};
    this.items.set(item.id,item); return item;
  }
  async update(id:string,userId:string,patch:Partial<Pick<FroshAutomation,"name"|"prompt"|"schedule"|"status"|"nextRunAt"|"lastRunAt">>){
    const item=await this.get(id,userId); if(!item) throw new Error("Automation not found");
    const updated=await this.updateIfIdle(id,userId,patch); if(!updated) throw new Error("Automation is currently executing");
    return updated;
  }
  async updateIfIdle(id:string,userId:string,patch:Partial<Pick<FroshAutomation,"name"|"prompt"|"schedule"|"status"|"nextRunAt"|"lastRunAt">>){
    const item=await this.get(id,userId); if(!item || (item.leaseUntil && Date.parse(item.leaseUntil)>Date.now())) return null;
    const next={...item,...patch,updatedAt:new Date().toISOString()}; this.items.set(id,next); return next;
  }
  async updateOwned(id:string,userId:string,owner:string,patch:Partial<Pick<FroshAutomation,"name"|"prompt"|"schedule"|"status"|"nextRunAt"|"lastRunAt">>){
    const item=await this.get(id,userId);
    if(!item || item.leaseOwner!==owner || !item.leaseUntil || Date.parse(item.leaseUntil)<=Date.now()) return null;
    const next={...item,...patch,updatedAt:new Date().toISOString()}; this.items.set(id,next); return next;
  }
  async deleteIfIdle(id:string,userId:string){
    const item=await this.get(id,userId); if(!item || (item.leaseUntil && Date.parse(item.leaseUntil)>Date.now())) return false;
    this.items.delete(id); return true;
  }
  async claimDue(id:string,userId:string,owner:string,leaseMs:number){
    const item=await this.get(id,userId);
    if(!item || item.status!=="active" || !item.nextRunAt || Date.parse(item.nextRunAt)>Date.now()) return null;
    if(item.leaseUntil && Date.parse(item.leaseUntil)>Date.now()) return null;
    const next={...item,leaseOwner:owner,leaseUntil:new Date(Date.now()+leaseMs).toISOString(),updatedAt:new Date().toISOString()};
    this.items.set(id,next); return next;
  }
  async renewLease(id:string,userId:string,owner:string,leaseMs:number){
    const item=await this.get(id,userId);
    if(!item || item.leaseOwner!==owner || !item.leaseUntil || Date.parse(item.leaseUntil)<=Date.now()) return false;
    this.items.set(id,{...item,leaseUntil:new Date(Date.now()+leaseMs).toISOString(),updatedAt:new Date().toISOString()}); return true;
  }
  async releaseLease(id:string,userId:string,owner:string){
    const item=await this.get(id,userId);
    if(!item || item.leaseOwner!==owner) return false;
    this.items.set(id,{...item,leaseOwner:undefined,leaseUntil:undefined,updatedAt:new Date().toISOString()}); return true;
  }
  async delete(id:string,userId:string){ return this.deleteIfIdle(id,userId); }
}
