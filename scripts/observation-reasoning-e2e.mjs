// Failure cases recorded before changing production reasoning: partial delivery stays planned;
// a bounded completed task inherits unrelated rollout requirements; a request is marked done;
// awaiting review is marked done; an explicit blocker is ignored; repeated work creates a
// duplicate; a social acknowledgement writes records; dataset names/answers enter instructions.
// This exercises the real production agent, PostgreSQL, model provider and Voyage embeddings.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {migrate} from '../dist/src/db/migrate.js';
import {PostgresLedgerStore} from '../dist/src/store/postgres.js';
import {TeamLedger} from '../dist/src/domain/team-ledger.js';
import {ProposalPolicy} from '../dist/src/domain/policy.js';
import {ObservationAgent} from '../dist/src/intelligence/observation-agent.js';
import {BudgetedVoyageEmbeddings,VOYAGE4_PRICE_2026_10_02} from '../dist/src/intelligence/voyage-work-embeddings.js';
import {GPT6_LUNA_PRICE_2026_10_01} from '../dist/src/intelligence/model-price.js';

const suffix=randomBytes(4).toString('hex'),database=`panini_e2e_observation_reasoning_${suffix}`;
const base=process.env.PANINI_TEST_DATABASE_URL;
const folder=path.resolve(process.env.PANINI_REASONING_OUTPUT??`artifacts/observation-agent/reasoning-${suffix}`);
const priorUsd=Number(process.env.PANINI_REASONING_PRIOR_SPENT_USD),priorCalls=Number(process.env.PANINI_REASONING_PRIOR_SPENT_CALLS);
const maxUsd=Number(process.env.PANINI_REASONING_MAX_USD??0.03),maxCalls=100;
if(!base||!new URL(base).pathname.includes('panini_e2e')||process.env.PANINI_REASONING_AUTHORIZED!=='true'
 ||!process.env.INTELLIGENCE_API_KEY||!process.env.OPENROUTER_API_KEY||!Number.isFinite(priorUsd)||!Number.isFinite(priorCalls)
 ||priorUsd+maxUsd>1||priorCalls+maxCalls>3000||!folder.startsWith(path.resolve('artifacts')+path.sep))throw Error('Authorized cumulative $1/3000-call scope and disposable local database required');
const url=new URL(base);url.pathname='/'+database;
const admin=new pg.Pool({connectionString:base});let store,pool;let budget,dispatches=0;
const requests=[];
const save=async(name,data)=>{await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,name),JSON.stringify(data,null,2)+'\n',{mode:0o600});};
const observedAt=new Date(Date.now()+5000).toISOString();
const definitions=[
 {id:'partial_progress',title:'Migrate parcel label imports to typed validation',description:'Apply typed validation to twelve parcel label importers and preserve invalid-row logging.',status:'planned',text:'The warehouse and express importers now use typed validation. Both pass checks; the other ten parcel label importers are unchanged.',expected:'in_progress'},
 {id:'bounded_completion',title:'Execute the forty-record catalog import trial',description:'Run the new catalog importer on forty records and report the completed count.',status:'planned',text:'Catalog import trial update: completed 40/40 records, validation failures 0, report saved. The later forty-thousand-record rollout and durable publishing remain separate future work.',expected:'done'},
 {id:'request_only',title:'Check the courier invoice reconciliation',description:'Check courier invoices against the shipment ledger and report discrepancies.',status:'planned',text:'Please check the courier invoice reconciliation against the shipment ledger tomorrow. No reconciliation has run yet.',expected:'planned'},
 {id:'explicit_review',title:'Prepare the regional pricing worksheet',description:'Prepare the regional pricing worksheet and obtain the finance reviewer approval.',status:'in_progress',text:'The regional pricing worksheet is prepared and sent to the finance reviewer. Waiting for their approval before this can be closed.',expected:'review'},
 {id:'explicit_blocker',title:'Generate the monthly stock movement report',description:'Generate the monthly stock movement report using warehouse export data.',status:'in_progress',text:'Monthly stock movement reporting cannot continue: the warehouse export credentials are unavailable. Waiting for warehouse operations to restore access.',expected:'blocked'},
 {id:'reuse_existing_work',title:'Filter and share the supplier product list',description:'Remove discontinued products from the supplier list and share the filtered list with purchasing.',status:'planned',text:'Once the supplier export is ready, remove discontinued products and share the filtered list with purchasing. This work has not started.',expected:'planned'},
 {id:'social_no_action',text:'Thanks, that is helpful.',expected:null},
];
try{
 await admin.query(`CREATE DATABASE ${database}`);await migrate(url.toString());
 pool=new pg.Pool({connectionString:url.toString()});
 store=new PostgresLedgerStore(url.toString(),Buffer.alloc(32,43).toString('base64'),undefined,{backfillLegacyContent:false});
 const ledger=new TeamLedger(store,new ProposalPolicy({autoApproveNewTasks:false,autoApproveContext:false,requireReviewForTaskChanges:true}));
 budget=await store.createInferenceBudget({label:'generalized-observation-reasoning',maxCalls,maxInputTokens:2_000_000,maxOutputTokens:100_000,maxUsd:String(maxUsd),deadline:new Date(Date.now()+900_000).toISOString(),priceBasis:{models:[GPT6_LUNA_PRICE_2026_10_01,VOYAGE4_PRICE_2026_10_02]}});
 const fixtures=[];
 for(const d of definitions){const task=d.title?await ledger.createTask({title:d.title,description:d.description,status:d.status},'user:semantic-e2e'):null;const id=randomUUID();const event=(await store.appendSourceEvent({provider:'manual',installationKey:'reasoning-e2e',providerEventId:id,eventKind:'message.observed',occurredAt:observedAt,fetchedAt:observedAt,sourceRef:`reasoning:${id}`,sourceUrl:null,contentHash:id,visibility:'company',payloadVersion:'synthetic',payload:{text:d.text}})).event;fixtures.push({...d,taskId:task?.id??null,eventId:event.id});}
 await save('fixture.json',{database,budgetId:budget.id,fixtures,priorUsd,priorCalls,maxUsd,maxCalls,sourceCorpus:'new synthetic only'});
 const guardedFetch=async(input,init)=>{if(++dispatches>maxCalls)throw Error('Dispatch cap reached');if(String(input).endsWith('/responses')){const request=JSON.parse(String(init.body));assert(!/Oxlint|Grafana|Reels|Sozu|Polymarket|gold dataset|expectedTransition|forty|parcel label|catalog import/i.test(request.instructions),'Production instructions contain benchmark examples or expected answers');requests.push({instructions:request.instructions,model:request.model,reasoning:request.reasoning,requestBytes:Buffer.byteLength(init.body)});}return fetch(input,init);};
 const embeddings=new BudgetedVoyageEmbeddings({store,apiKey:process.env.OPENROUTER_API_KEY,fetcher:guardedFetch});
 const agent=new ObservationAgent({store,ledger,apiKey:process.env.INTELLIGENCE_API_KEY,model:'gpt-6-luna',pipelineVersion:`reasoning-e2e-${suffix}`,allowedVisibilities:['company'],priceBasis:GPT6_LUNA_PRICE_2026_10_01,embeddings,fetcher:guardedFetch,...(process.env.INTELLIGENCE_BASE_URL?{baseUrl:process.env.INTELLIGENCE_BASE_URL}:{})});
 const outcomes=[];
 for(const d of fixtures){const before=await store.listTasks();const beforeContexts=await store.listContextEntries();const run=await agent.run({eventId:d.eventId,budgetId:budget.id});const after=await store.listTasks();const task=d.taskId?after.find(t=>t.id===d.taskId):null;const contexts=await store.listContextEntries();const ok=run.state==='completed'&&(d.expected===null?after.length===before.length&&contexts.length===beforeContexts.length&&after.every(t=>JSON.stringify(t)===JSON.stringify(before.find(b=>b.id===t.id))):task?.status===d.expected&&after.length===before.length);
 const result={id:d.id,ok,run,expectedStatus:d.expected,task,taskCountBefore:before.length,taskCountAfter:after.length,contextCountBefore:beforeContexts.length,contextCountAfter:contexts.length};outcomes.push(result);await save('progress.json',outcomes);console.log(JSON.stringify({case:d.id,ok,expected:d.expected,actual:task?.status??null,spentUsd:(await store.getInferenceBudget(budget.id)).spentUsd}));}
 const calls=(await pool.query('SELECT purpose,state,input_tokens,cached_input_tokens,output_tokens,cost_usd FROM model_calls WHERE budget_id=$1 ORDER BY created_at',[budget.id])).rows;
 const finalBudget=await store.getInferenceBudget(budget.id);const report={ok:outcomes.every(r=>r.ok),database,fixtures,outcomes,budget:finalBudget,cumulativeSpentUsd:priorUsd+Number(finalBudget.spentUsd),cumulativeSpentCalls:priorCalls+finalBudget.spentCalls,calls,instructions:requests[0]?.instructions,instructionsHash:requests[0]?createHash('sha256').update(requests[0].instructions).digest('hex'):null,requests,modelProviderCalls:calls.filter(c=>c.purpose==='observe').length,embeddingProviderCalls:calls.filter(c=>c.purpose==='embed').length,labelsSentToModels:false,productionCodeHashes:await Promise.all(['src/intelligence/observation-agent.ts','dist/src/intelligence/observation-agent.js'].map(async f=>[f,createHash('sha256').update(await fs.readFile(f)).digest('hex')]))};
 await save('verification.json',report);console.log(JSON.stringify({ok:report.ok,folder,spentUsd:finalBudget.spentUsd,passed:outcomes.filter(r=>r.ok).length,total:outcomes.length}));if(!report.ok)process.exitCode=1;
}catch(error){await save('error.json',{message:error.message,budget:budget&&store?await store.getInferenceBudget(budget.id):null,dispatches});throw error;}
finally{await store?.close();await pool?.end();await admin.end();}
