// Score saved production outputs. Never rerun the agent or change accepted records.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PostgresLedgerStore} from '../dist/src/store/postgres.js';
import {GPT6_LUNA_PRICE_2026_10_01} from '../dist/src/intelligence/model-price.js';
import {contentHash} from '../dist/src/domain/content-hash.js';
import {scoreOutcomes} from './observation-gold-score.mjs';
const folder=path.resolve(process.env.PANINI_OBSERVATION_GOLD_OUTPUT??'');
if(!folder.startsWith(path.resolve('artifacts')+path.sep)||process.env.PANINI_OBSERVATION_GOLD_AUTHORIZED!=='true')throw Error('Authorized artifact folder required');
const manifest=JSON.parse(await fs.readFile(folder+'/manifest.json','utf8'));
const progress=JSON.parse(await fs.readFile(folder+'/progress.json','utf8'));
const gold=JSON.parse(await fs.readFile(process.env.PANINI_OBSERVATION_GOLD_PATH,'utf8'));
if(contentHash(gold.cases)!==manifest.goldHash||new URL(process.env.DATABASE_URL).pathname.slice(1)!==manifest.targetDatabase)throw Error('Saved gold or database mismatch');
const store=new PostgresLedgerStore(process.env.DATABASE_URL,process.env.CONTENT_ENCRYPTION_KEY,undefined,{backfillLegacyContent:false});
try{
 const budget=await store.getInferenceBudget(progress.budgetId);
 if(!budget||budget.reservedCalls)throw Error('Do not grade with unsettled calls');
 const cases=[];
 for(const c of gold.cases){
  const key=contentHash({cutoff:c.cutoff,eventIds:[...c.sourceEventIds].sort()});
  const result=progress.groups.find(g=>g.key===key);
  if(result?.status!=='completed')continue;
  const score=await scoreOutcomes({c,result,store,budgetId:budget.id,apiKey:process.env.INTELLIGENCE_API_KEY,baseUrl:process.env.INTELLIGENCE_BASE_URL,fetcher:fetch,priceBasis:GPT6_LUNA_PRICE_2026_10_01});
  cases.push({id:c.id,score});
  const clear=cases.filter(c=>c.score.confirmed);
  const report={status:cases.length===gold.cases.length?'completed':'partial',productionAgentRerun:false,acceptedRecordsUnchanged:true,goldHash:gold.frozenHash,nativeTimesHash:manifest.nativeTimesHash??null,scorerHash:createHash('sha256').update(await fs.readFile('scripts/observation-gold-score.mjs')).digest('hex'),cases,completed:cases.length,total:gold.cases.length,confirmed:clear.length,passed:clear.filter(c=>c.score.outcomePassed===true).length,ambiguous:cases.filter(c=>!c.score.confirmed).length,budget:await store.getInferenceBudget(budget.id)};
  await fs.writeFile(folder+'/rescore-report.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({case:c.id,passed:score.outcomePassed}));
 }
}finally{await store.close();}
