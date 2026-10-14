// The production ObservationAgent runs unchanged. This runner isolates gold inputs,
// freezes accepted state at each cutoff, and records actual automatically accepted writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../dist/src/db/migrate.js';
import {PostgresLedgerStore} from '../dist/src/store/postgres.js';
import {TeamLedger} from '../dist/src/domain/team-ledger.js';
import {ProposalPolicy} from '../dist/src/domain/policy.js';
import {ObservationAgent} from '../dist/src/intelligence/observation-agent.js';
import {BudgetedVoyageEmbeddings,VOYAGE4_PRICE_2026_10_02} from '../dist/src/intelligence/voyage-work-embeddings.js';
import {GPT6_LUNA_PRICE_2026_10_01} from '../dist/src/intelligence/model-price.js';
import {mechanicalScore,scoreOutcomes} from './observation-gold-score.mjs';
import {contentHash} from '../dist/src/domain/content-hash.js';
import {normalizeSourceTime,compareNativeSourceEvents,nativeSourceTimestamp} from './observation-source-time.mjs';

const fixture=process.env.PANINI_OBSERVATION_GOLD_FIXTURE==='true';
const source=process.env.PANINI_OBSERVATION_GOLD_SOURCE_DATABASE;
const target=process.env.PANINI_OBSERVATION_GOLD_TARGET_DATABASE;
const databaseUrl=process.env.DATABASE_URL,contentKey=process.env.CONTENT_ENCRYPTION_KEY;
const apiKey=process.env.INTELLIGENCE_API_KEY,routerKey=process.env.OPENROUTER_API_KEY;
const visibilities=(process.env.JEV_WORK_ALLOWED_VISIBILITIES??'').split(',').map(x=>x.trim()).filter(Boolean);
const folder=path.resolve(process.env.PANINI_OBSERVATION_GOLD_OUTPUT??'');
const continuationFolder=process.env.PANINI_OBSERVATION_GOLD_CONTINUE_FROM_DIR?path.resolve(process.env.PANINI_OBSERVATION_GOLD_CONTINUE_FROM_DIR):null;
const goldPath=path.resolve(process.env.PANINI_OBSERVATION_GOLD_PATH??'');
const allowedDb=fixture?/^panini_e2e_observation_gold_(seed|run)_[a-f0-9]+$/:/^panini_replay_[a-z0-9_]+$/;
const cap={model:'gpt-6-luna',embeddingModel:'voyageai/voyage-4',maxUsd:process.env.PANINI_OBSERVATION_GOLD_MAX_USD??'1',maxCalls:Number(process.env.PANINI_OBSERVATION_GOLD_MAX_CALLS??2000),maxWallSeconds:Number(process.env.PANINI_OBSERVATION_GOLD_MAX_WALL_SECONDS??2700),maxInputTokens:Number(process.env.PANINI_OBSERVATION_GOLD_MAX_INPUT_TOKENS??30_000_000),maxOutputTokens:Number(process.env.PANINI_OBSERVATION_GOLD_MAX_OUTPUT_TOKENS??1_000_000)};
if(!databaseUrl||!source||!target||source===target||!allowedDb.test(source)||!allowedDb.test(target)
 ||new URL(databaseUrl).pathname.slice(1)!==target||!contentKey||!apiKey||!routerKey||!visibilities.length
 ||!folder.startsWith(path.resolve('artifacts')+path.sep)||!goldPath.startsWith(path.resolve('artifacts')+path.sep)
 ||process.env.PANINI_OBSERVATION_GOLD_AUTHORIZED!=='true'||!Number.isFinite(Number(cap.maxUsd))||Number(cap.maxUsd)<=0
 ||!Number.isSafeInteger(cap.maxCalls)||cap.maxCalls<1||!Number.isSafeInteger(cap.maxWallSeconds)||cap.maxWallSeconds<1)throw Error('Assert an isolated database, authorized exact caps, local keys, source scope and artifact paths.');
const nativeTimesPath=process.env.PANINI_OBSERVATION_GOLD_NATIVE_TIMES_PATH;
const nativeTimes=nativeTimesPath?JSON.parse(await fs.readFile(nativeTimesPath,'utf8')):null;
if(nativeTimes && (nativeTimes.sourceDatabase!==source || !nativeTimes.selectedCommitsVerified))throw Error('Native timestamp proof does not match source');
const gold=JSON.parse(await fs.readFile(goldPath,'utf8'));
if(!Array.isArray(gold.cases)||!gold.cases.length||contentHash(gold.cases)!==gold.frozenHash)throw Error('Gold hash mismatch');
for(const c of gold.cases){if(typeof c.id!=='string'||!Array.isArray(c.sourceEventIds)||!c.sourceEventIds.length||typeof c.cutoff!=='string'||new Date(c.cutoff).toISOString()!==c.cutoff)throw Error('Invalid frozen case metadata');}
const sourceFiles=(await fs.readdir('src',{recursive:true})).filter(file=>file.endsWith('.ts')).map(file=>'src/'+file).sort();
const codeFiles=gold.schemaVersion===2?[...sourceFiles,'package.json','pnpm-lock.yaml','scripts/observation-gold-run.mjs','scripts/observation-gold-score.mjs']:['src/intelligence/observation-agent.ts','src/intelligence/observation-search.ts','src/intelligence/voyage-work-embeddings.ts','src/store/postgres.ts','src/domain/team-ledger.ts','scripts/observation-gold-run.mjs','scripts/observation-gold-score.mjs'];
if(gold.schemaVersion===2&&continuationFolder)throw Error('V2 requires one fresh code version; mixed-code continuation is forbidden');
codeFiles.push('scripts/observation-source-time.mjs');
const codeHashes=await Promise.all(codeFiles.map(async file=>[file,createHash('sha256').update(await fs.readFile(file)).digest('hex')]));
const inputManifest=gold.cases.map(c=>({id:c.id,cutoff:c.cutoff,sourceEventIds:[...c.sourceEventIds].sort()}));
let manifest={schemaVersion:1,architecture:'production_observation_agent_v1',sourceDatabase:source,targetDatabase:target,goldHash:gold.frozenHash,nativeTimesHash:nativeTimes?contentHash(nativeTimes):null,inputFingerprint:contentHash({inputManifest,nativeTimesHash:nativeTimes?contentHash(nativeTimes):null}),codeFingerprint:contentHash(codeHashes),codeHashes,modelBudget:cap,modelBudgetHash:contentHash(cap),inputManifest,fixture,labelsSentToModels:gold.schemaVersion===2?'scorer only':false,labelsSentToAgent:false,labelsSentToScorer:gold.schemaVersion===2,scoring:gold.schemaVersion===2?'Frozen accepted-state outcomes, equivalent task scope, accepted fact capture, no-write checks; ambiguity separate.':'Actual task operations and explicit no-action cases. Relationship/claim labels are unscored because production does not emit that old contract.',baselineComparison:'No matched baseline run; this is one candidate run.'};
const save=async(name,data)=>{await fs.mkdir(folder,{recursive:true});const file=path.join(folder,name),temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);};
const adminUrl=new URL(databaseUrl);adminUrl.pathname='/postgres';
const admin=new pg.Pool({connectionString:adminUrl.toString()});let pool,store,guard,locked=false,state;
if(gold.schemaVersion===2&&gold.cases.some(c=>!Array.isArray(c.expectedOutcomes)||!c.expectedOutcomes.length))throw Error('Every v2 case needs an outcome');
const groups=[];
for(const c of gold.cases){const key=contentHash({cutoff:c.cutoff,eventIds:[...c.sourceEventIds].sort()});let group=groups.find(g=>g.key===key);if(!group){group={key,cutoff:c.cutoff,eventIds:[...c.sourceEventIds].sort(),caseIds:[]};groups.push(group);}group.caseIds.push(c.id);}
const cutoffs=[...new Set(groups.map(g=>g.cutoff))].sort();
const seedTables=['tasks','context_entries','proposals','task_revisions','context_revisions','work_links','work_link_revisions'];
async function correctSourceTimes(){
 if(!nativeTimes)return;
 const ids=(await pool.query("SELECT id FROM source_events WHERE provider IN ('github','slack')")).rows.map(r=>r.id);
 const corrections=[];
 for(let offset=0;offset<ids.length;offset+=200){
  for(const event of await store.getSourceEvents(ids.slice(offset,offset+200))){
   const normalized=normalizeSourceTime(event,nativeTimes);
   if(normalized.occurredAt===event.occurredAt)continue;
   corrections.push({id:event.id,provider:event.provider,sha:event.payload.sha??null,previous:event.occurredAt,occurredAt:normalized.occurredAt});
  }
 }
 const client=await pool.connect();
 try{await client.query('BEGIN');for(const c of corrections)await client.query('UPDATE source_events SET occurred_at=$2 WHERE id=$1 AND occurred_at=$3',[c.id,c.occurredAt,c.previous]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 await save('source-time-corrections.json',{sourceDatabase:source,targetDatabase:target,sourceUnmodified:true,nativeTimesHash:contentHash(nativeTimes),corrections});
}
async function makeSeeds(){
 for(const [index,cutoff] of cutoffs.entries()){
  for(const table of seedTables){let filter='';if(table==='task_revisions'||table==='context_revisions')filter=' WHERE applied_at<='+`'${cutoff}'::timestamptz`;await pool.query(`CREATE TABLE gold_seed_${index}_${table} AS SELECT * FROM ${table}${filter}`);}
  const taskSeed=`gold_seed_${index}_tasks`,contextSeed=`gold_seed_${index}_context_entries`;
  await pool.query(`DELETE FROM ${taskSeed} WHERE id NOT IN (SELECT task_id FROM gold_seed_${index}_task_revisions)`);
  await pool.query(`UPDATE ${taskSeed} t SET external_ref=r.current->>'externalRef',document=r.current-ARRAY['id','externalRef','version','createdAt','updatedAt'],version=r.version,created_at=(r.current->>'createdAt')::timestamptz,updated_at=(r.current->>'updatedAt')::timestamptz FROM (SELECT DISTINCT ON(task_id) * FROM gold_seed_${index}_task_revisions ORDER BY task_id,version DESC) r WHERE r.task_id=t.id`);
  await pool.query(`DELETE FROM ${contextSeed} WHERE id NOT IN (SELECT context_entry_id FROM gold_seed_${index}_context_revisions)`);
  await pool.query(`UPDATE ${contextSeed} c SET source_event_id=(r.current->>'sourceEventId')::uuid,source_ref=r.current->>'sourceRef',path=r.current->>'path',title=r.current->>'title',body=r.current->>'body',fact_type=r.current->>'factType',fact_value=r.current->'value',source_url=r.current->>'sourceUrl',content_hash=r.current->>'contentHash',evidence_ids=ARRAY(SELECT jsonb_array_elements_text(r.current->'evidenceIds'))::uuid[],lifecycle_state=r.current->>'lifecycleState',effective_from=(r.current->>'effectiveFrom')::timestamptz,effective_to=(r.current->>'effectiveTo')::timestamptz,links=r.current->'links',updated_at=(r.current->>'updatedAt')::timestamptz FROM (SELECT DISTINCT ON(context_entry_id) * FROM gold_seed_${index}_context_revisions ORDER BY context_entry_id,version DESC) r WHERE r.context_entry_id=c.id`);
 }
}
async function resetAccepted(cutoff){
 const index=cutoffs.indexOf(cutoff),client=await pool.connect();
 try{await client.query('BEGIN');await client.query('DELETE FROM work_link_revisions');await client.query('DELETE FROM work_links');await client.query('DELETE FROM task_revisions');await client.query('DELETE FROM context_revisions');
  await client.query(`DELETE FROM proposals WHERE id NOT IN (SELECT id FROM gold_seed_${index}_proposals)`);
  await client.query(`DELETE FROM tasks WHERE id NOT IN (SELECT id FROM gold_seed_${index}_tasks)`);
  await client.query(`DELETE FROM context_entries WHERE id NOT IN (SELECT id FROM gold_seed_${index}_context_entries)`);
  for(const table of ['tasks','context_entries']){
   const columns=(await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',['public',table])).rows.map(r=>r.column_name).filter(c=>c!=='id');
   await client.query(`UPDATE ${table} t SET ${columns.map(c=>`"${c}"=s."${c}"`).join(',')} FROM gold_seed_${index}_${table} s WHERE t.id=s.id`);
  }
  for(const table of ['task_revisions','context_revisions','work_links','work_link_revisions'])await client.query(`INSERT INTO ${table} SELECT * FROM gold_seed_${index}_${table}`);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function capturedWrites(runId,eventId){
 const changes=[];
 for(const call of await store.listModelCalls(runId)){
  if(call.purpose!=='observe'||call.state!=='succeeded')continue;
  const response=(await store.getModelCallResponseByKey(call.logicalCallKey))?.response;
  for(const item of response?.output??[]){
   if(item.type!=='function_call'||!item.name?.match(/^(create|update|edit)_/))continue;
   const proposal=await store.findProposalByClientEvent('observation-agent',contentHash({runId,callId:item.call_id}));
   if(proposal?.state!=='auto_applied')continue;
   const taskRevision=await store.getTaskRevisionByProposal(proposal.id),contextRevision=await store.getContextRevisionByProposal(proposal.id);
   const revision=taskRevision??contextRevision;if(!revision)throw Error('Accepted write has no revision');
   changes.push({eventId,runId,tool:item.name,proposalId:proposal.id,taskId:taskRevision?.taskId??null,contextId:contextRevision?.contextEntryId??null,changes:proposal.changes,previous:revision.previous,current:revision.current,appliedAt:revision.appliedAt,rationale:proposal.rationale,evidenceIds:proposal.evidenceIds,changedFields:proposal.kind==='task_create'?['task_create']:Object.keys(proposal.changes).filter(k=>JSON.stringify(revision.previous?.[k]??null)!==JSON.stringify(revision.current[k]??null))});
  }
 }
 return changes;
}
function caseScore(c,result){
 if(gold.schemaVersion===2)return state.scores?.[c.id]??mechanicalScore(c,result);
 const confirmed=c.adjudication==='confirmed'&&c.ambiguityStatus==='clear';const expected=c.expectedTransition;
 if(expected){const hits=result.changes.filter(change=>expected.field==='task_create'?change.tool==='create_task'&&change.current.title.trim().toLowerCase()===expected.value.trim().toLowerCase():change.taskId===c.taskId&&change.changedFields.includes(expected.field)&&String(change.current[expected.field])===expected.value);return{confirmed,category:'expected_action',exactActionRecovered:hits.length>0&&(expected.field==='task_create'||String(result.finalTargets[c.taskId]?.[expected.field])===expected.value),initialTargetAlreadyMatches:expected.field!=='task_create'&&String(result.initialTargets[c.taskId]?.[expected.field])===expected.value,finalTargetMatchesExpected:expected.field!=='task_create'&&String(result.finalTargets[c.taskId]?.[expected.field])===expected.value,matchingProposalIds:hits.map(h=>h.proposalId),titleMatching:expected.field==='task_create'?'exact normalized title only; semantic title matches require review':null};}
 if(c.id.startsWith('no_action:'))return{confirmed,category:'explicit_no_action',noWrites:result.changes.length===0};
 if(c.taskId)return{confirmed,category:'target_no_transition',statusAndResultPreserved:result.initialTargets[c.taskId]?.status===result.finalTargets[c.taskId]?.status&&result.initialTargets[c.taskId]?.result===result.finalTargets[c.taskId]?.result};
 return{confirmed,category:'relationship_only',scored:false,reason:'The single agent does not emit a separate relationship label.'};
}
async function report(status,error=null){
 const cases=gold.cases.map(c=>{const group=groups.find(g=>g.caseIds.includes(c.id)),result=state.groups.find(g=>g.key===group.key);return{id:c.id,cutoff:c.cutoff,groupKey:group.key,status:result?.status??'not_started',runIds:result?.runIds??[],changes:result?.changes??[],initialTarget:result?.initialTargets?.[c.taskId]??null,finalTarget:result?.finalTargets?.[c.taskId]??null,score:result?.status==='completed'?caseScore(c,result):null};});
 const budget=await store.getInferenceBudget(state.budgetId);const calls=(await pool.query("SELECT purpose,model,state,count(*)::int AS count,sum(cost_usd)::text AS estimated_usd FROM model_calls WHERE budget_id=$1 GROUP BY purpose,model,state",[state.budgetId])).rows;
 const rows=(await pool.query('SELECT id,run_id,purpose,model,state,input_tokens,cached_input_tokens,output_tokens,cost_usd,created_at FROM model_calls WHERE budget_id=$1 ORDER BY created_at,id',[state.budgetId])).rows;
 const usage=rows.map(r=>({...r,phase:state.inheritedCallIds?.includes(r.id)?'previous':'current'}));
 const totals=phase=>usage.filter(r=>r.phase===phase).reduce((a,r)=>({calls:a.calls+1,inputTokens:a.inputTokens+Number(r.input_tokens??0),cachedInputTokens:a.cachedInputTokens+Number(r.cached_input_tokens??0),outputTokens:a.outputTokens+Number(r.output_tokens??0),estimatedUsd:a.estimatedUsd+Number(r.cost_usd??0)}),{calls:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,estimatedUsd:0});
 const tokenUsage={updatedAt:new Date().toISOString(),previous:totals('previous'),current:totals('current'),calls:usage};
 await save('token-usage.json',tokenUsage);
 const columns=['id','run_id','phase','purpose','model','state','input_tokens','cached_input_tokens','output_tokens','cost_usd','created_at'];
 await fs.writeFile(path.join(folder,'token-usage.csv'),columns.join(',')+'\n'+usage.map(r=>columns.map(c=>JSON.stringify(String(r[c]??''))).join(',')).join('\n')+'\n',{mode:0o600});
 const scorerCallCount=gold.schemaVersion===2?calls.filter(c=>c.purpose==='verify').reduce((a,c)=>a+c.count,0):0;
 const splitStageCalls=calls.filter(c=>!['observe','embed',...(gold.schemaVersion===2?['verify']:[])].includes(c.purpose)).reduce((a,c)=>a+c.count,0);
 const pendingAgentProposals=(await store.listProposals()).filter(p=>p.requestedBy==='observation-agent'&&['pending','escalated'].includes(p.state)).length;
 const complete=cases.filter(c=>c.status==='completed');const actions=complete.filter(c=>c.score?.confirmed&&c.score.category==='expected_action'),noActions=complete.filter(c=>c.score?.confirmed&&c.score.category==='explicit_no_action');
 const output={schemaVersion:1,status,error,startedAt:state.startedAt,updatedAt:new Date().toISOString(),manifest,resumeHistory:state.resumeHistory??[],sourceDatabaseUnmodified:true,database:target,budget,callSummary:calls,tokenUsage:{previous:tokenUsage.previous,current:tokenUsage.current},splitStageCalls,scorerCallCount,pendingAgentProposals,uniqueInputGroups:groups.length,completedGroups:state.groups.filter(g=>g.status==='completed').length,totalCases:cases.length,completedCases:complete.length,cases,metrics:{...(gold.schemaVersion===2?{confirmedOutcomeChecks:complete.flatMap(c=>c.score.confirmed?c.score.checks:[]).length,passedOutcomeChecks:complete.flatMap(c=>c.score.confirmed?c.score.checks:[]).filter(c=>c.passed===true).length,confirmedCases:complete.filter(c=>c.score.confirmed).length,passedConfirmedCases:complete.filter(c=>c.score.confirmed&&c.score.outcomePassed===true).length,missedConfirmedCases:complete.filter(c=>c.score.confirmed&&c.score.outcomePassed===false).length,pendingSemanticCases:complete.filter(c=>c.score.pendingSemantic).length,ambiguousCases:complete.filter(c=>!c.score.confirmed).length}:{}),confirmedExpectedActionsCompleted:actions.length,exactActionsRecovered:actions.filter(c=>c.score.exactActionRecovered).length,confirmedExplicitNoActionCompleted:noActions.length,explicitNoActionWithNoWrites:noActions.filter(c=>c.score.noWrites).length},limitations:gold.schemaVersion===2?['Expectations are self-reviewed; this is not independent human adjudication.','Semantic matches are model judgments with saved inputs and reasons.','Ambiguous cases are executed and reported separately; they cannot prove full recall.','No matched baseline; no comparative quality claim.']:['Gold labels were self-reviewed, not independently adjudicated.','No matched baseline; prior multi-stage relationship scores are not comparable.','New task title scoring is exact-match only.','Additional task/context writes require source review before being counted as correct.']};await save('report.json',output);return output;
}
try{
 const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[target])).rowCount;
 if(!exists){await admin.query(`CREATE DATABASE ${target} TEMPLATE ${source}`);await migrate(databaseUrl);}
 pool=new pg.Pool({connectionString:databaseUrl});guard=await pool.connect();locked=(await guard.query("SELECT pg_try_advisory_lock(hashtext('observation_gold_runner')) AS locked")).rows[0].locked;if(!locked)throw Error('Gold runner already active');
 store=new PostgresLedgerStore(databaseUrl,contentKey,undefined,{backfillLegacyContent:false});
 if(continuationFolder){
  if(exists||!continuationFolder.startsWith(path.resolve('artifacts')+path.sep)||continuationFolder===folder)throw Error('Continuation requires fresh isolated target and output');
  const priorManifest=JSON.parse(await fs.readFile(path.join(continuationFolder,'manifest.json'),'utf8'));
  const priorState=JSON.parse(await fs.readFile(path.join(continuationFolder,'progress.json'),'utf8'));
  if(priorState.manifestHash!==contentHash(priorManifest)||priorManifest.targetDatabase!==source||priorManifest.goldHash!==manifest.goldHash||priorManifest.inputFingerprint!==manifest.inputFingerprint||Number(priorManifest.modelBudget.maxUsd)!==Number(cap.maxUsd)||cap.maxCalls<priorManifest.modelBudget.maxCalls)throw Error('Continuation inputs or cumulative caps mismatch');
  const budget=await store.getInferenceBudget(priorState.budgetId);
  if(!budget||budget.state!=='active'||budget.reservedCalls!==0||budget.spentCalls>=cap.maxCalls||Number(budget.spentUsd)>=Number(cap.maxUsd))throw Error('Continuation budget exhausted or unsettled');
  const unsettled=await pool.query("SELECT id FROM model_calls WHERE budget_id=$1 AND state NOT IN ('succeeded','failed')",[budget.id]);
  if(unsettled.rowCount)throw Error('Unsettled inherited provider calls');
  const deadline=new Date(Date.now()+cap.maxWallSeconds*1000).toISOString();
  manifest.continuationOf={folder:continuationFolder,codeFingerprint:priorManifest.codeFingerprint,completedCases:priorState.groups.filter(g=>g.status==='completed').flatMap(g=>groups.find(x=>x.key===g.key)?.caseIds??[]).length,spentCalls:budget.spentCalls,spentUsd:budget.spentUsd,partialGroupsHaveMixedCode:true};
  const updated=await pool.query("UPDATE inference_budgets SET max_calls=$2,deadline=$3 WHERE id=$1 AND state='active' AND reserved_calls=0 RETURNING id",[budget.id,cap.maxCalls,deadline]);
  if(updated.rowCount!==1)throw Error('Continuation budget changed');
  state={...priorState,manifestHash:contentHash(manifest),deadline,continuationStartedAt:new Date().toISOString(),inheritedCallIds:(await pool.query('SELECT id FROM model_calls WHERE budget_id=$1',[budget.id])).rows.map(r=>r.id)};
  await save('manifest.json',manifest);await save('progress.json',state);
 }else try{
  state=JSON.parse(await fs.readFile(path.join(folder,'progress.json'),'utf8'));
  const savedManifest=JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'));
  if(gold.schemaVersion===2&&contentHash(savedManifest)!==contentHash(manifest))throw Error('Frozen v2 code or inputs changed');
  const stableManifest=value=>({...value,codeFingerprint:null,codeHashes:value.codeHashes.filter(([file])=>file!=='scripts/observation-gold-run.mjs')});
  if(state.manifestHash!==contentHash(savedManifest)||contentHash(stableManifest(manifest))!==contentHash(stableManifest(savedManifest))
   ||(state.manifestHash!==contentHash(manifest)&&process.env.PANINI_OBSERVATION_GOLD_RESUME!=='true'))throw Error('Resume manifest mismatch');
  // Preserve original agent pipeline keys and immutable inputs; record runner-only repairs separately.
  manifest=savedManifest;
  if(process.env.PANINI_OBSERVATION_GOLD_RESUME==='true'){
   const budget=await store.getInferenceBudget(state.budgetId);
   if(!budget||budget.state!=='active'||budget.reservedCalls!==0||budget.spentCalls>=budget.maxCalls
    ||(budget.maxUsd!==null&&Number(budget.spentUsd)>=Number(budget.maxUsd)))throw Error('Resume budget is exhausted or has unsettled calls');
   const deadline=new Date(Date.now()+cap.maxWallSeconds*1000).toISOString();
   const updated=await pool.query("UPDATE inference_budgets SET deadline=$2 WHERE id=$1 AND state='active' AND reserved_calls=0 RETURNING id",[state.budgetId,deadline]);
   if(updated.rowCount!==1)throw Error('Resume budget changed concurrently');
   state.resumeHistory??=[];state.resumeHistory.push({resumedAt:new Date().toISOString(),previousDeadline:state.deadline,deadline,
    runnerHash:codeHashes.find(([file])=>file==='scripts/observation-gold-run.mjs')[1],spentCalls:budget.spentCalls,spentUsd:budget.spentUsd});
   state.deadline=deadline;await save('progress.json',state);
  }
 }
 catch(error){if(error.code!=='ENOENT')throw error;if(exists)throw Error('Existing target has no matching saved progress');await correctSourceTimes();await makeSeeds();const deadline=new Date(Date.now()+cap.maxWallSeconds*1000).toISOString();const budget=await store.createInferenceBudget({label:'observation-agent-gold',maxCalls:cap.maxCalls,maxInputTokens:cap.maxInputTokens,maxOutputTokens:cap.maxOutputTokens,maxUsd:cap.maxUsd,deadline,priceBasis:{models:[GPT6_LUNA_PRICE_2026_10_01,VOYAGE4_PRICE_2026_10_02]}});state={schemaVersion:1,manifestHash:contentHash(manifest),budgetId:budget.id,deadline,startedAt:new Date().toISOString(),groups:[]};await save('manifest.json',manifest);await save('progress.json',state);}
 const ledger=new TeamLedger(store,new ProposalPolicy({autoApproveNewTasks:false,autoApproveContext:false,requireReviewForTaskChanges:true}));
 let dispatches=0;
 const guardedFetch=async(...args)=>{if(++dispatches>cap.maxCalls||Date.now()>=Date.parse(state.deadline))throw Error('Gold dispatch cap/deadline reached');return fetch(...args);};
 const embeddings=new BudgetedVoyageEmbeddings({store,apiKey:routerKey,fetcher:guardedFetch,...(process.env.OPENROUTER_EMBEDDING_ENDPOINT?{endpoint:process.env.OPENROUTER_EMBEDDING_ENDPOINT}:{})});
 await report('running');
 for(const group of groups){
  let result=state.groups.find(g=>g.key===group.key);if(result?.status==='completed')continue;if(Date.now()>=Date.parse(state.deadline))throw Error('Gold wall deadline reached');
  if(!result){await resetAccepted(group.cutoff);const initialTargets=Object.fromEntries((await store.listTasks()).map(t=>[t.id,t]));result={key:group.key,status:'running',doneEventIds:[],runIds:[],changes:[],initialTargets,finalTargets:{}};state.groups.push(result);await save('progress.json',state);}
  const reader=new Proxy(store,{get(target,property){if(property==='getSourceEvents')return async ids=>(await target.getSourceEvents(ids)).filter(e=>e.receivedAt<=group.cutoff);if(property==='listSourceContextCandidates')return input=>target.listSourceContextCandidates({...input,cutoff:group.cutoff});if(property==='currentSourceEventIds')return(ids,at)=>target.currentSourceEventIds(ids,at&&at<group.cutoff?at:group.cutoff);const value=target[property];return typeof value==='function'?value.bind(target):value;}});
  const events=await reader.getSourceEvents(group.eventIds);if(events.length!==group.eventIds.length||events.some(e=>!visibilities.includes(e.visibility)))throw Error('Frozen raw input is missing or unauthorized');
  const ordered=events.sort(compareNativeSourceEvents);
  if(ordered.some(e=>!Number.isFinite(Date.parse(e.occurredAt))))throw Error('Invalid original source timestamp');
  result.eventOrder=ordered.map(e=>({id:e.id,occurredAt:nativeSourceTimestamp(e)===null?null:e.occurredAt,timestampBasis:nativeSourceTimestamp(e)===null?"capture-only reference, creation unknown":"native",provider:e.provider,sourceUrl:e.sourceUrl}));
  if(result.doneEventIds.some((id,i)=>id!==result.eventOrder[i]?.id))throw Error('Saved cursor is not a chronological prefix');
  await save('chronology.json',{basis:'original source sent or created time; collection time excluded',tieBreak:'UUID for equal timestamps only',groups:state.groups.map(g=>({key:g.key,events:g.eventOrder??[]}))});
  const agent=new ObservationAgent({store:reader,ledger,apiKey,model:'gpt-6-luna',embeddings,pipelineVersion:`observation-gold-${manifest.codeFingerprint.slice(0,12)}-${group.key.slice(0,12)}${state.continuationStartedAt?'-continuation':''}`,allowedVisibilities:visibilities,priceBasis:GPT6_LUNA_PRICE_2026_10_01,fetcher:guardedFetch,...(process.env.INTELLIGENCE_BASE_URL?{baseUrl:process.env.INTELLIGENCE_BASE_URL}:{})});
  for(const event of ordered){if(result.doneEventIds.includes(event.id))continue;if(state.continuationStartedAt&&event.observationIdentity?.originObservationKey&&ordered.some(prior=>result.doneEventIds.includes(prior.id)&&prior.observationIdentity?.originObservationKey===event.observationIdentity?.originObservationKey)){result.doneEventIds.push(event.id);await save('progress.json',state);continue;}const run=await agent.run({eventId:event.id,budgetId:state.budgetId});if(!['completed','duplicate'].includes(run.state)||(run.state==='completed'&&!run.runId))throw Error(`Observation ${event.id} returned ${run.state}`);if(run.state==='completed'){result.runIds.push(run.runId);result.changes.push(...await capturedWrites(run.runId,event.id));}result.doneEventIds.push(event.id);await save('progress.json',state);await report('running');const budget=await store.getInferenceBudget(state.budgetId);console.log(JSON.stringify({group:state.groups.length,totalGroups:groups.length,observation:result.doneEventIds.length,totalObservations:ordered.length,spentCalls:budget.spentCalls,estimatedUsd:budget.spentUsd}));}
  result.finalTargets=Object.fromEntries((await store.listTasks()).map(t=>[t.id,t]));result.status='completed';await save('progress.json',state);await report('running');
 }
 if(gold.schemaVersion===2){state.scores??={};for(const c of gold.cases){if(state.scores[c.id])continue;const group=groups.find(g=>g.caseIds.includes(c.id)),result=state.groups.find(g=>g.key===group.key);state.scores[c.id]=await scoreOutcomes({c,result,store,budgetId:state.budgetId,apiKey,baseUrl:process.env.INTELLIGENCE_BASE_URL,fetcher:guardedFetch,priceBasis:GPT6_LUNA_PRICE_2026_10_01});await save('progress.json',state);await report('grading');}}
 const unsettled=(await pool.query("SELECT count(*)::int AS n FROM model_calls WHERE budget_id=$1 AND state NOT IN ('succeeded','failed')",[state.budgetId])).rows[0].n;const settledBudget=await store.getInferenceBudget(state.budgetId);if(unsettled||settledBudget.reservedCalls||Number(settledBudget.reservedUsd)>0||state.groups.some(g=>g.status!=='completed'))throw Error('Gold run has unfinished work or unsettled provider costs');
 const done=await report('completed');if(done.splitStageCalls||done.pendingAgentProposals)throw Error('Unexpected retired stage or human-review dependency');console.log(JSON.stringify({report:path.join(folder,'report.json'),status:'completed',cases:done.completedCases,metrics:done.metrics}));
}catch(error){if(store&&state)await report('stopped',error.message);throw error;}
finally{if(locked)await guard.query("SELECT pg_advisory_unlock(hashtext('observation_gold_runner'))");guard?.release();await store?.close();await pool?.end();await admin.end();}
