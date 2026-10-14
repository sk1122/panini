// Failure modes and scope were saved before implementation in full-dataset-medium-20261005/preflight-plan.json.
// This harness calls the frozen production agent. It has no gold labels or scorer.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
const frozen='/private/tmp/panini-v26-medium';
const {PostgresLedgerStore,DEFAULT_ORGANIZATION_ID}=await import(frozen+'/dist/src/store/postgres.js');
const {migrate}=await import(frozen+'/dist/src/db/migrate.js');
const {TeamLedger}=await import(frozen+'/dist/src/domain/team-ledger.js');
const {ProposalPolicy}=await import(frozen+'/dist/src/domain/policy.js');
const {ObservationAgent}=await import(frozen+'/dist/src/intelligence/observation-agent.js');
const {BudgetedVoyageEmbeddings,VOYAGE4_PRICE_2026_10_02}=await import(frozen+'/dist/src/intelligence/voyage-work-embeddings.js');
const {GPT6_LUNA_PRICE_2026_10_01}=await import(frozen+'/dist/src/intelligence/model-price.js');
const {contentHash}=await import(frozen+'/dist/src/domain/content-hash.js');
const {containsCredentialLikeText}=await import(frozen+'/dist/src/retrieval/external-text-policy.js');
import {normalizeSourceTime,compareNativeSourceEvents,nativeSourceTimestamp} from './observation-source-time.mjs';
import {recoveryStore} from './observation-recovery-store.mjs';
const folder=path.resolve('artifacts/observation-agent/full-dataset-medium-20261005');
const source='panini_replay_gold_eval_voyage4_searchfix_20261002',target='panini_replay_full_dataset_medium_20261005';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(url.pathname!==`/${target}`||!process.env.CONTENT_ENCRYPTION_KEY||!process.env.INTELLIGENCE_API_KEY||!process.env.OPENROUTER_API_KEY||process.env.PANINI_FULL_DATASET_AUTHORIZED!=='true')throw Error('Assert authorized isolated replay and local keys');
const visibilities=(process.env.JEV_WORK_ALLOWED_VISIBILITIES??'').split(',').map(x=>x.trim()).filter(Boolean);
if(!visibilities.length)throw Error('Source visibility scope is missing');
const cap={maxUsd:'50',maxCalls:100000,maxInputTokens:2_000_000_000,maxOutputTokens:20_000_000,maxWallSeconds:172800};
const save=async(name,value)=>{const file=path.join(folder,name);await fs.writeFile(file+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(file+'.tmp',file);};
const sha=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const snapshot=JSON.parse(await fs.readFile('artifacts/observation-agent/code-snapshots/native_v26/snapshot-proof.json'));
const hashes=await Promise.all(snapshot.codeHashes.map(async([file])=>[file,await sha(path.join(frozen,file))]));
const fingerprint=contentHash(hashes);
if(fingerprint!=='e7df6c80222448301004e4a743a7b7e1c6a123dca81a030dc9543c5c4df225fd')throw Error('Frozen medium source changed');
const compiledHashes=await Promise.all(snapshot.compiledHashes.map(async([file])=>[file,await sha(path.join(frozen,file))]));
if(!(await fs.readFile(frozen+'/dist/src/intelligence/observation-agent.js','utf8')).includes('reasoning: { effort: "medium" }'))throw Error('Compiled actor is not medium');
const nativeTimes=JSON.parse(await fs.readFile('artifacts/observation-agent/final-chronology/all-commit-times.json'));
const adminUrl=new URL(url);adminUrl.pathname='/postgres';
const admin=new pg.Pool({connectionString:adminUrl.toString()});
const sourceUrl=new URL(url);sourceUrl.pathname='/'+source;
const sourcePool=new pg.Pool({connectionString:sourceUrl.toString()});
let pool,store,guard,state,manifest,locked=false;
const sourceHash=async p=>(await p.query("SELECT 'source_events' AS table_name,count(*)::int AS records,md5(string_agg(md5(row_to_json(s)::text),'' ORDER BY id)) AS hash FROM source_events s UNION ALL SELECT 'source_event_contents',count(*)::int,md5(string_agg(md5(row_to_json(s)::text),'' ORDER BY source_event_id)) FROM source_event_contents s ORDER BY table_name")).rows;
async function report(status,error=null){
 const budget=await store.getInferenceBudget(state.budgetId);
 const calls=(await pool.query('SELECT purpose,state,count(*)::int AS calls,sum(input_tokens)::text AS input_tokens,sum(cached_input_tokens)::text AS cached_input_tokens,sum(output_tokens)::text AS output_tokens,sum(cost_usd)::text AS estimated_usd FROM model_calls WHERE budget_id=$1 GROUP BY purpose,state ORDER BY purpose,state',[state.budgetId])).rows;
 const counts=(await pool.query("SELECT 'tasks' AS kind,count(*)::int AS count FROM tasks UNION ALL SELECT 'context_entries',count(*)::int FROM context_entries UNION ALL SELECT 'accepted_proposals',count(*)::int FROM proposals WHERE state='auto_applied' UNION ALL SELECT 'pending_proposals',count(*)::int FROM proposals WHERE state IN ('pending','escalated')")).rows;
 const value={status,error,startedAt:state.startedAt,updatedAt:new Date().toISOString(),database:target,model:'gpt-6-luna',reasoning:'medium',totalRecords:manifest.events.length,completedRecords:state.cursor,completedAgentRuns:state.completedAgentRuns,duplicateRecords:state.duplicateRecords,budget,callSummary:calls,acceptedStateCounts:counts,manifestHash:state.manifestHash,liveWorker:'This isolated replay only; production worker unverified',accuracy:'Unscored full corpus; source review required'};
 await save('report.json',value);return value;
}
try{
 const existing=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[target])).rowCount;
 if(!existing){
  const accounting=JSON.parse(await fs.readFile('artifacts/observation-agent/final-attempt-accounting.json'));
  if(Date.now()-Date.parse(accounting.at)>600000||accounting.estimatedSpentUsd+accounting.reservedUsd+Number(cap.maxUsd)>100||accounting.spentCalls+accounting.reservedCalls+cap.maxCalls>250000)throw Error('Refresh or extend remaining session guard');
  await save('resource-authorization.json',{at:new Date().toISOString(),authorization:'Full dataset medium replay requested by user; same approved sources/providers',cap,priorAccounting:accounting});
  await admin.query(`CREATE DATABASE ${target} TEMPLATE ${source}`);
 }
 await migrate(url.toString());
 pool=new pg.Pool({connectionString:url.toString()});guard=await pool.connect();
 locked=(await guard.query("SELECT pg_try_advisory_lock(hashtext('observation_full_dataset_medium')) AS locked")).rows[0].locked;
 if(!locked)throw Error('Replay already running');
 store=new PostgresLedgerStore(url.toString(),process.env.CONTENT_ENCRYPTION_KEY,undefined,{backfillLegacyContent:false});
 const prepared=await fs.access(path.join(folder,'manifest.json')).then(()=>true,()=>false);
 if(existing&&prepared){
  manifest=JSON.parse(await fs.readFile(path.join(folder,'manifest.json')));state=JSON.parse(await fs.readFile(path.join(folder,'progress.json')));
  if(state.manifestHash!==contentHash(manifest)||manifest.codeFingerprint!==fingerprint||contentHash(manifest.compiledHashes)!==contentHash(compiledHashes)||manifest.runnerHash!==await sha('scripts/observation-full-dataset-run.mjs')||(manifest.recoveryHelperHash&&manifest.recoveryHelperHash!==await sha('scripts/observation-recovery-store.mjs')))throw Error('Resume inputs/code changed');
  if(state.status==='completed'){console.log(JSON.stringify(await report('completed')));process.exitCode=0;}
  else {
   const b=await store.getInferenceBudget(state.budgetId);
   const unknown=(await pool.query("SELECT count(*)::int AS count FROM model_calls WHERE budget_id=$1 AND state NOT IN ('succeeded','failed')",[state.budgetId])).rows[0].count;
   if(unknown||b.reservedCalls||Number(b.reservedUsd)||Date.now()>=Date.parse(b.deadline)||b.state!=='active')throw Error('Resume has unsettled calls or expired budget; reconciliation required');
  }
 }else{
  const originalHash=await sourceHash(sourcePool),cloneHash=await sourceHash(pool);
  if(contentHash(originalHash)!==contentHash(cloneHash))throw Error('Source clone differs');
  const excludedOtherOrganizations=(await pool.query("SELECT id,organization_id,provider FROM source_events WHERE content_state='active' AND organization_id<>$1 ORDER BY id",[DEFAULT_ORGANIZATION_ID])).rows;
  await save('organization-scope.json',{organizationId:DEFAULT_ORGANIZATION_ID,excludedOtherOrganizations});
  const ids=(await pool.query("SELECT id FROM source_events WHERE content_state='active' AND organization_id=$1 ORDER BY id",[DEFAULT_ORGANIZATION_ID])).rows.map(x=>x.id);
  const events=[];for(let i=0;i<ids.length;i+=100)events.push(...await store.getSourceEvents(ids.slice(i,i+100)));
  if(events.length!==ids.length)throw Error('Active source content is missing');
  const unauthorized=events.filter(e=>!visibilities.includes(e.visibility)).map(e=>e.id);
  const unsafe=events.filter(e=>containsCredentialLikeText(JSON.stringify(e.payload))).map(e=>e.id);
  if(unauthorized.length||unsafe.length){await save('blocked-inputs.json',{unauthorized,credentialLikePayloads:unsafe});throw Error('Input permission or credential check failed; see numeric IDs in blocked-inputs');}
  const normalized=events.map(e=>normalizeSourceTime(e,nativeTimes)).sort(compareNativeSourceEvents);
  manifest={at:new Date().toISOString(),sourceDatabase:source,targetDatabase:target,sourceTablesBefore:originalHash,codeFingerprint:fingerprint,codeHashes:hashes,compiledHashes,runnerHash:await sha('scripts/observation-full-dataset-run.mjs'),model:'gpt-6-luna',reasoning:'medium',labelsSentToAgent:false,scorer:false,initialState:'Empty task/context/project state',cap,allowedVisibilities:visibilities,nativeTimesHash:contentHash(nativeTimes),events:normalized.map(e=>({id:e.id,provider:e.provider,eventKind:e.eventKind,occurredAt:e.occurredAt,nativeTime:nativeSourceTimestamp(e)===null?null:e.occurredAt,originalOccurredAt:events.find(x=>x.id===e.id).occurredAt,originalReceivedAt:e.receivedAt,payloadHash:contentHash(e.payload)}))};
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const requested=['tasks','context_entries','context_documents','projects','workstreams','proposals','task_revisions','context_revisions','project_revisions','project_proposals','work_links','work_link_revisions','interpretation_runs','observation_dispositions','model_calls','inference_budgets','evidence_claims','evidence_assessments','evidence_dependencies','work_entity_embeddings','outbox_jobs'];
   const tables=(await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",[requested])).rows.map(x=>x.table_name);
   await client.query('TRUNCATE '+tables.map(t=>'"'+t+'"').join(',')+' CASCADE');
   if(contentHash(await sourceHash(client))!==contentHash(originalHash))throw Error('Reset altered source tables');
   // Historical availability uses native dates only in this isolated clone.
   for(const e of normalized)await client.query('UPDATE source_events SET occurred_at=$2,received_at=$2 WHERE id=$1',[e.id,e.occurredAt]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const deadline=new Date(Date.now()+cap.maxWallSeconds*1000).toISOString();
  const budget=await store.createInferenceBudget({label:'full-dataset-medium-20261005',maxCalls:cap.maxCalls,maxInputTokens:cap.maxInputTokens,maxOutputTokens:cap.maxOutputTokens,maxUsd:cap.maxUsd,deadline,priceBasis:{models:[GPT6_LUNA_PRICE_2026_10_01,VOYAGE4_PRICE_2026_10_02]}});
  state={startedAt:new Date().toISOString(),manifestHash:contentHash(manifest),budgetId:budget.id,cursor:0,completedAgentRuns:0,duplicateRecords:0,status:'prepared'};
  await save('manifest.json',manifest);await save('chronology.json',{basis:'Native sent/created dates; undated branch references last; original receipt dates retained in manifest',events:manifest.events.map(({id,provider,eventKind,nativeTime})=>({id,provider,eventKind,nativeTime}))});await save('progress.json',state);
  if((await store.listTasks()).length||(await store.listContextEntries()).length)throw Error('Accepted state reset failed');
 }
 await report(state.status==='completed'?'completed':'prepared');
 console.log(JSON.stringify({status:state.status,records:manifest.events.length,cursor:state.cursor,database:target,budgetId:state.budgetId,model:'gpt-6-luna',reasoning:'medium'}));
 if(process.argv.includes('--run')&&state.status!=='completed'){
  let cutoff=null;
  const recoveryProof=await fs.readFile(path.join(folder,'authorized-call-recoveries.json'),'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return {entries:[]};throw error;});
  for(const entry of recoveryProof.entries){const call=(await pool.query('SELECT state,error_code,request_hash FROM model_calls WHERE id=$1 AND budget_id=$2',[entry.callId,state.budgetId])).rows[0];if(!call||call.state!=='failed'||!call.error_code?.endsWith('_reserved_bound')||call.request_hash!==entry.requestHash)throw Error('Retry receipt is not safely reconciled');}
  const reader=new Proxy(recoveryStore(store,recoveryProof.entries),{get(target,property){
   if(property==='getSourceEvents')return async ids=>(await target.getSourceEvents(ids)).filter(e=>e.receivedAt<=cutoff);
   if(property==='listSourceContextCandidates')return input=>target.listSourceContextCandidates({...input,cutoff});
   if(property==='currentSourceEventIds')return(ids,at)=>target.currentSourceEventIds(ids,at&&at<cutoff?at:cutoff);
   const value=target[property];return typeof value==='function'?value.bind(target):value;
  }});
  const ledger=new TeamLedger(reader,new ProposalPolicy({autoApproveNewTasks:false,autoApproveContext:false,requireReviewForTaskChanges:true}));
  const embeddings=new BudgetedVoyageEmbeddings({store:reader,apiKey:process.env.OPENROUTER_API_KEY});
  const agent=new ObservationAgent({store:reader,ledger,apiKey:process.env.INTELLIGENCE_API_KEY,model:'gpt-6-luna',embeddings,pipelineVersion:'full-medium-'+fingerprint.slice(0,12),allowedVisibilities:visibilities,priceBasis:GPT6_LUNA_PRICE_2026_10_01,...(process.env.INTELLIGENCE_BASE_URL?{baseUrl:process.env.INTELLIGENCE_BASE_URL}:{})});
  state.status='running';await save('progress.json',state);await report('running');
  const datedLast=manifest.events.filter(e=>e.nativeTime!==null).at(-1)?.occurredAt;
  for(;state.cursor<manifest.events.length;){
   const e=manifest.events[state.cursor];cutoff=e.nativeTime===null?manifest.events.reduce((last,x)=>x.occurredAt>last?x.occurredAt:last,datedLast):e.occurredAt;
   const event=(await reader.getSourceEvents([e.id]))[0];
   if(!event||contentHash(event.payload)!==e.payloadHash)throw Error('Frozen input changed');
   const result=await agent.run({eventId:e.id,budgetId:state.budgetId});
   if(!['completed','duplicate'].includes(result.state))throw Error('Observation returned '+result.state);
   if(result.state==='completed')state.completedAgentRuns++;else state.duplicateRecords++;
   state.cursor++;await save('progress.json',state);const status=await report('running');
   console.log(JSON.stringify({completed:state.cursor,total:manifest.events.length,agentRuns:state.completedAgentRuns,duplicates:state.duplicateRecords,spentCalls:status.budget.spentCalls,estimatedUsd:status.budget.spentUsd}));
  }
  const unsettled=(await pool.query("SELECT count(*)::int AS count FROM model_calls WHERE budget_id=$1 AND state NOT IN ('succeeded','failed')",[state.budgetId])).rows[0].count;
  const b=await store.getInferenceBudget(state.budgetId);
  if(unsettled||b.reservedCalls||Number(b.reservedUsd))throw Error('Run has unsettled costs');
  const after=await sourceHash(sourcePool);if(contentHash(after)!==contentHash(manifest.sourceTablesBefore))throw Error('Original source database changed');
  await save('source-database-proof.json',{before:manifest.sourceTablesBefore,after,unchanged:true});
  await save('accepted-state.json',{tasks:await store.listTasks(),context:await store.listContextEntries()});
  const usage=(await pool.query('SELECT id,run_id,purpose,model,state,input_tokens,cached_input_tokens,output_tokens,cost_usd,created_at FROM model_calls WHERE budget_id=$1 ORDER BY created_at,id',[state.budgetId])).rows;await save('token-usage.json',usage);
  state.status='completed';await save('progress.json',state);console.log(JSON.stringify(await report('completed')));
 }
}catch(error){if(store&&state)await report('stopped',error.message);console.error(error.message);process.exitCode=1;}
finally{if(locked)await guard.query("SELECT pg_advisory_unlock(hashtext('observation_full_dataset_medium'))");guard?.release();await store?.close();await pool?.end();await sourcePool.end();await admin.end();}
