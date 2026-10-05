import type { FroshMissionStep } from "../../../packages/types/src/mission";

const now=()=>new Date().toISOString();
function step(title:string):FroshMissionStep{const timestamp=now();return {id:crypto.randomUUID(),title,status:"pending",createdAt:timestamp,updatedAt:timestamp};}

export function planMission(goal:string):FroshMissionStep[]{
  const lower=goal.toLowerCase();
  const titles=[
    "Understand the objective and inspect the relevant context",
    lower.includes("website")||lower.includes("code")||lower.includes("github")?"Inspect the relevant project and current state":"Gather the information needed for the objective",
    lower.includes("research")||lower.includes("find")||lower.includes("compare")?"Analyze the findings against the objective":"Carry out the required work",
    "Verify the result against the original objective"
  ];
  return titles.map(step);
}

export function evaluateMissionStep(input:{goal:string;step:FroshMissionStep;result?:string;status:string}){
  const result=(input.result??"").trim();
  if(input.status==="failed")return {complete:false,action:"recover",reason:"The step failed and needs recovery work."};
  if(input.status==="waiting_approval")return {complete:false,action:"approval",reason:"The step is blocked on user approval."};
  if(input.status!=="completed")return {complete:false,action:"continue",reason:"The step has not completed yet."};
  if(!result)return {complete:false,action:"verify",reason:"The step completed without a result, so verification is required."};
  return {complete:false,action:"continue",reason:"The step completed. Continue through the remaining mission plan."};
}

export function createRecoveryStep(stepTitle:string,result?:string){
  const detail=result?" Review the failure/result: "+result.slice(0,500):"";
  return {...step("Recover from the previous step and complete the missing work."+detail), retryCount:0};
}