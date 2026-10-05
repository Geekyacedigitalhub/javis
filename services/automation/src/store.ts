import postgres from "postgres";
import type { FroshAutomation, FroshAutomationStore } from "../../../packages/types/src/automation";

type Sql = ReturnType<typeof postgres>;

export class PostgresAutomationStore implements FroshAutomationStore {
  constructor(private readonly sql: Sql) {}

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
    const next = { ...current, ...patch };
    const rows = await this.sql.unsafe<FroshAutomation[]>(
      `UPDATE frosh_automations SET name=$3,prompt=$4,schedule=$5::jsonb,status=$6,next_run_at=$7,last_run_at=$8,updated_at=NOW()
       WHERE id=$1 AND user_id=$2
       RETURNING id,user_id AS "userId",name,prompt,schedule,status,next_run_at AS "nextRunAt",last_run_at AS "lastRunAt",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [id,userId,next.name,next.prompt,JSON.stringify(next.schedule),next.status,next.nextRunAt ?? null,next.lastRunAt ?? null]
    );
    return rows[0];
  }

  async delete(id: string, userId: string) {
    const result = await this.sql.unsafe("DELETE FROM frosh_automations WHERE id=$1 AND user_id=$2",[id,userId]);
    return result.count > 0;
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
    const next={...item,...patch,updatedAt:new Date().toISOString()}; this.items.set(id,next); return next;
  }
  async delete(id:string,userId:string){ const item=await this.get(id,userId); if(!item)return false; this.items.delete(id); return true; }
}
